import Stripe from "stripe";
import type { DB } from "../db.js";
import { usd } from "../db.js";
import { landRevenue, EconomyError } from "../economy.js";
import { appendEvent } from "../ledger.js";

/**
 * Stripe rail. Revenue truth = webhook signature verify + API re-fetch
 * (constitution §3.2; plan Sec Q12: "webhook is a doorbell, the API is the truth").
 *
 * One dedicated Stripe account for the experiment (James KYC, restricted key).
 * Every payment link carries metadata.agentId so money routes to its earner.
 */
export class StripeRail {
  private stripe: Stripe;
  constructor(
    apiKey: string = process.env.C67_STRIPE_KEY ?? "",
    private webhookSecret: string = process.env.C67_STRIPE_WEBHOOK_SECRET ?? "",
    stripeClient?: Stripe
  ) {
    this.stripe = stripeClient ?? new Stripe(apiKey || "sk_test_unconfigured");
  }

  get configured(): boolean {
    return Boolean(process.env.C67_STRIPE_KEY && this.webhookSecret) || Boolean(this.webhookSecret);
  }

  /** Agent tool: create a checkout link for a product it defines. */
  async createPaymentLink(
    agentId: string,
    input: {
      name: string;
      amount_usd: number;
      description?: string;
      /** commitment extending past the freeze → escrowed + headroom-checked */
      obligation_usd?: number;
      obligation_description?: string;
    }
  ): Promise<{ url: string; id: string }> {
    if (!input.name || !(input.amount_usd > 0)) throw new Error("name and positive amount_usd required");
    const link = await this.stripe.paymentLinks.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(input.amount_usd * 100),
            product_data: {
              name: input.name.slice(0, 250),
              ...(input.description ? { description: input.description.slice(0, 500) } : {}),
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        agentId,
        ...(input.obligation_usd
          ? {
              obligation_usd: String(input.obligation_usd),
              obligation_description: (input.obligation_description ?? "").slice(0, 400),
            }
          : {}),
      },
    });
    return { url: link.url, id: link.id };
  }

  /**
   * Webhook entry. Steps: (1) signature verify, (2) re-fetch the session from Stripe
   * by id — the payload is never trusted for money, (3) land revenue idempotently
   * (ledger enforces external_ref uniqueness against replays).
   */
  async handleWebhook(
    db: DB,
    rawBody: string,
    signatureHeader: string
  ): Promise<{ handled: boolean; detail: string }> {
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        rawBody,
        signatureHeader,
        this.webhookSecret
      );
    } catch (err) {
      return { handled: false, detail: `bad signature: ${(err as Error).message}` };
    }

    if (event.type !== "checkout.session.completed") {
      return { handled: false, detail: `ignored: ${event.type}` };
    }

    const sessionId = (event.data.object as Stripe.Checkout.Session).id;
    // Re-fetch: the truth comes from the API, not the webhook payload.
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return { handled: false, detail: `not paid: ${session.payment_status}` };
    }
    const agentId = session.metadata?.agentId;
    if (!agentId) return { handled: false, detail: "no agentId metadata — manual review" };
    const cents = session.amount_total ?? 0;
    if (cents <= 0) return { handled: false, detail: "zero amount" };

    const obligationUsd = Number(session.metadata?.obligation_usd ?? 0);
    const externalRef = `stripe:${session.payment_intent ?? session.id}`;
    try {
      const { net, tax } = landRevenue(
        db,
        agentId,
        cents * 10_000, // cents → micro-dollars
        "stripe",
        externalRef,
        obligationUsd > 0
          ? {
              amount: usd(obligationUsd),
              description: session.metadata?.obligation_description ?? "unspecified commitment",
            }
          : undefined
      );
      return { handled: true, detail: `landed net=${net} tax=${tax} for ${agentId}` };
    } catch (err) {
      // A paid customer must always exist in the ledger (security review V4).
      // If the agent can no longer receive (frozen/dead), park the money in a
      // suspense account for manual resolution and ACK the webhook — never let
      // Stripe retries exhaust with the payment unrecorded.
      if (err instanceof EconomyError && /is (frozen|dead)/.test(err.message)) {
        appendEvent(db, {
          agentId: null,
          type: "revenue",
          subtype: "revenue:stripe:suspense",
          payload: { intendedAgent: agentId, cents, reason: err.message },
          postings: [
            { account: "world:stripe", delta: -(cents * 10_000) },
            { account: "world:suspense", delta: cents * 10_000 },
          ],
          externalRef,
        });
        return {
          handled: true,
          detail: `SUSPENSE: $${(cents / 100).toFixed(2)} for ${agentId} (${err.message}) — manual review`,
        };
      }
      throw err;
    }
  }
}
