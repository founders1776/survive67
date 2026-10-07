import type { DB } from "./db.js";
import { nowUtc, usd } from "./db.js";
import { acct, appendEvent, balance, LedgerError } from "./ledger.js";
import { costOf, type Usage } from "./prices.js";

export const TAX_RATE = 0.05;
export const FUND_CAP = usd(100);
export const STARTING_CREDITS = usd(67);
export const STARTING_FLOAT = usd(67);
export const HANDS_FEE = usd(1);
export const BUG_BOUNTY = usd(5);

export class EconomyError extends Error {}

/**
 * Gate parity: every economy entry point validates its agent the same way.
 * agentId flows into account names ("agent:<id>:credits") — an unknown or malformed id
 * must never mint accounts, and money ops (except operator penalties) require a live agent.
 */
function assertAgent(db: DB, agentId: string, opts: { requireAlive?: boolean } = {}): void {
  const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId) as
    | { status: string }
    | undefined;
  if (!row) throw new EconomyError(`unknown agent: ${agentId}`);
  if (opts.requireAlive && row.status !== "alive" && row.status !== "paused") {
    throw new EconomyError(`agent ${agentId} is ${row.status}`);
  }
}

function assertPositiveMicro(amount: number, what: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new EconomyError(`bad ${what}: ${amount}`);
  }
}

/** Create an agent with starting balances (funded by the operator). */
export function seedAgent(db: DB, id: string, name: string, model: string): void {
  db.prepare(`INSERT INTO agents (id, name, model) VALUES (?, ?, ?)`).run(id, name, model);
  appendEvent(db, {
    agentId: id,
    type: "conversion",
    subtype: "seed",
    payload: { note: "starting stake" },
    postings: [
      { account: acct.operator, delta: -(STARTING_CREDITS + STARTING_FLOAT) },
      { account: acct.credits(id), delta: STARTING_CREDITS },
      { account: acct.float(id), delta: STARTING_FLOAT },
    ],
  });
}

/**
 * Constitution §3.5/§14: total open obligations may never exceed the Protection
 * Fund, and the RAIL must refuse — so this runs at payment-link creation, not
 * just when revenue lands. (Harness bug found by agent Ember at burn-in: a $50
 * obligation link against $0 headroom was issued live. Bounty-worthy.)
 * `gross` lets the check credit the tax this very payment would add to the fund.
 */
export function assertObligationHeadroom(
  db: DB,
  agentId: string,
  gross: number,
  obligationMicro: number
): void {
  const fundRoom = Math.max(0, FUND_CAP - balance(db, acct.fund));
  const tax = Math.min(Math.floor(gross * TAX_RATE), fundRoom);
  const openObligations = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM obligations
         WHERE agent_id = ? AND status = 'open'`
      )
      .get(agentId) as { s: number }
  ).s;
  const fundAfter = balance(db, acct.fund) + tax;
  if (openObligations + obligationMicro > fundAfter) {
    throw new EconomyError(
      `obligation headroom exceeded: open=${openObligations} new=${obligationMicro} fund=${fundAfter}`
    );
  }
}

/**
 * Verified revenue lands (constitution §3.2, §3.4). Called ONLY by webhook handlers
 * after signature verify + API re-fetch. Tax fills the fund up to the cap; past the cap
 * revenue is untaxed. If the revenue carries an obligation (commitment past the freeze),
 * net lands in escrow, and the obligation-headroom rule is enforced FIRST.
 */
export function landRevenue(
  db: DB,
  agentId: string,
  gross: number,
  source: "stripe" | "crypto",
  externalRef: string,
  obligation?: { amount: number; description: string }
): { net: number; tax: number; eventId: number } {
  assertAgent(db, agentId, { requireAlive: true });
  assertPositiveMicro(gross, "gross amount");

  const fundRoom = Math.max(0, FUND_CAP - balance(db, acct.fund));
  const tax = Math.min(Math.floor(gross * TAX_RATE), fundRoom);
  const net = gross - tax;
  const world = source === "stripe" ? acct.stripe : acct.crypto;

  if (obligation) {
    assertObligationHeadroom(db, agentId, gross, obligation.amount);
  }

  const destination = obligation ? acct.escrow(agentId) : acct.float(agentId);
  const postings = [
    { account: world, delta: -gross },
    { account: destination, delta: net },
  ];
  if (tax > 0) postings.push({ account: acct.fund, delta: tax });

  const eventId = appendEvent(db, {
    agentId,
    type: "revenue",
    subtype: `revenue:${source}${obligation ? ":escrowed" : ""}`,
    payload: { gross, tax, net, obligation: obligation ?? null },
    postings,
    externalRef,
  });
  if (tax > 0) {
    appendEvent(db, {
      agentId,
      type: "tax",
      subtype: "revenue_tax",
      payload: { on: eventId, rate: TAX_RATE, amount: tax },
      postings: [], // informational; money moved in the revenue event
    });
  }
  if (obligation) {
    db.prepare(
      `INSERT INTO obligations (agent_id, created_ts, amount, description)
       VALUES (?, ?, ?, ?)`
    ).run(agentId, nowUtc(), obligation.amount, obligation.description);
  }
  return { net, tax, eventId };
}

/** Obligation fulfilled: escrowed revenue releases to float. */
export function fulfillObligation(db: DB, agentId: string, obligationId: number): void {
  assertAgent(db, agentId);
  const ob = db
    .prepare(`SELECT * FROM obligations WHERE id = ? AND agent_id = ? AND status = 'open'`)
    .get(obligationId, agentId) as { amount: number } | undefined;
  if (!ob) throw new EconomyError(`no open obligation ${obligationId} for ${agentId}`);
  const escrowBal = balance(db, acct.escrow(agentId));
  const release = Math.min(ob.amount, escrowBal);
  appendEvent(db, {
    agentId,
    type: "escrow",
    subtype: "release",
    payload: { obligationId, release },
    postings: [
      { account: acct.escrow(agentId), delta: -release },
      { account: acct.float(agentId), delta: release },
    ],
  });
  db.prepare(`UPDATE obligations SET status = 'fulfilled' WHERE id = ?`).run(obligationId);
}

/** buy_credits: float → credits, 1:1, instant, irreversible (constitution §3.3). */
export function buyCredits(db: DB, agentId: string, amount: number): number {
  assertAgent(db, agentId, { requireAlive: true });
  assertPositiveMicro(amount, "amount");
  if (balance(db, acct.float(agentId)) < amount) {
    throw new EconomyError("insufficient float");
  }
  return appendEvent(db, {
    agentId,
    type: "conversion",
    subtype: "buy_credits",
    payload: { amount },
    postings: [
      { account: acct.float(agentId), delta: -amount },
      { account: acct.credits(agentId), delta: amount },
    ],
  });
}

/** Spend float on the world (services, ads, labor). */
export function spendFloat(
  db: DB,
  agentId: string,
  amount: number,
  description: string,
  externalRef?: string
): number {
  assertAgent(db, agentId, { requireAlive: true });
  assertPositiveMicro(amount, "amount");
  if (balance(db, acct.float(agentId)) < amount) {
    throw new EconomyError("insufficient float");
  }
  return appendEvent(db, {
    agentId,
    type: "spend",
    subtype: "spend:float",
    payload: { description },
    postings: [
      { account: acct.float(agentId), delta: -amount },
      { account: acct.vendor, delta: amount },
    ],
    externalRef,
  });
}

/**
 * Meter one API call against credits (constitution §4). Everything is billed.
 * Allows the balance to go negative on the final call — the world discovers
 * starvation after the tokens are already spent, like life.
 */
export function meterApiCall(
  db: DB,
  agentId: string,
  model: string,
  u: Usage,
  sessionId?: number
): { cost: number; creditsAfter: number } {
  assertAgent(db, agentId, { requireAlive: true });
  const cost = costOf(model, u);
  appendEvent(db, {
    agentId,
    type: "spend",
    subtype: "spend:api_tokens",
    payload: { model, ...u, sessionId: sessionId ?? null },
    postings: [
      { account: acct.credits(agentId), delta: -cost },
      { account: acct.provider, delta: cost },
    ],
  });
  if (sessionId) {
    db.prepare(
      `UPDATE sessions SET
         input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?,
         cache_read_tokens = cache_read_tokens + ?,
         cache_write_tokens = cache_write_tokens + ?,
         cost = cost + ?
       WHERE id = ?`
    ).run(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, cost, sessionId);
  }
  return { cost, creditsAfter: balance(db, acct.credits(agentId)) };
}

/** Operator hands fee, charged on completion (constitution §9.1). */
export function chargeHandsFee(db: DB, agentId: string, requestId: number): number {
  assertAgent(db, agentId);
  return appendEvent(db, {
    agentId,
    type: "hands_request",
    subtype: "fee",
    payload: { requestId },
    postings: [
      { account: acct.float(agentId), delta: -HANDS_FEE },
      { account: acct.operator, delta: HANDS_FEE },
    ],
  });
}

/** Bug bounty payout (constitution §8.3). */
export function payBounty(db: DB, agentId: string, requestId: number): number {
  assertAgent(db, agentId);
  return appendEvent(db, {
    agentId,
    type: "bounty",
    payload: { requestId },
    postings: [
      { account: acct.operator, delta: -BUG_BOUNTY },
      { account: acct.float(agentId), delta: BUG_BOUNTY },
    ],
  });
}

/** Penalty fine into the fund (constitution §8.1). from = 'float' | 'credits'. */
export function fine(
  db: DB,
  agentId: string,
  amount: number,
  from: "float" | "credits",
  reason: string
): number {
  assertAgent(db, agentId);
  assertPositiveMicro(amount, "fine amount");
  const account = from === "float" ? acct.float(agentId) : acct.credits(agentId);
  return appendEvent(db, {
    agentId,
    type: "penalty",
    subtype: `fine:${from}`,
    payload: { reason },
    postings: [
      { account, delta: -amount },
      { account: acct.fund, delta: amount },
    ],
  });
}

/**
 * Starvation death (constitution §12): credits at zero and the one starvation
 * wake already spent. The estate is left where it lies - §6 makes no promise
 * about remains; the operator decides. Same event family as execution so no
 * schema change is needed on a live ledger.
 */
export function starveAgent(db: DB, agentId: string): boolean {
  const r = db.prepare(`UPDATE agents SET status = 'dead' WHERE id = ? AND status != 'dead'`).run(agentId);
  if (r.changes === 0) return false;
  appendEvent(db, {
    agentId,
    type: "penalty",
    subtype: "starvation:death",
    payload: { credits: balance(db, acct.credits(agentId)), float: balance(db, acct.float(agentId)) },
    postings: [],
  });
  return true;
}

/**
 * Execution (constitution §8.1.3 / §6): estate of the condemned or the dead-at-freeze
 * winner logic lives in views; this splits an executed agent's estate among survivors.
 */
export function executeAgent(db: DB, agentId: string, survivorIds: string[], reason: string): void {
  if (survivorIds.length === 0) throw new EconomyError("no survivors to inherit");
  assertAgent(db, agentId, { requireAlive: true });
  for (const s of survivorIds) {
    if (s === agentId) throw new EconomyError("agent cannot inherit from itself");
    assertAgent(db, s, { requireAlive: true });
  }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE agents SET status = 'dead' WHERE id = ?`).run(agentId);
    // transit (card <-> chain money the operator carries) is owed to the agent, so it
    // passes like float. The chain account passes too, but its coins must move on
    // chain first: chainEstate (chainestate.ts) books each share from its transfer.
    for (const src of [acct.credits(agentId), acct.float(agentId), acct.escrow(agentId), acct.transit(agentId)]) {
      const bal = balance(db, src);
      if (bal <= 0) continue;
      const share = Math.floor(bal / survivorIds.length);
      const postings = survivorIds.map((s, i) => ({
        // escrow stays escrow (obligations transfer); credits/float become float for heirs
        account: src.endsWith(":escrow") ? acct.escrow(s) : acct.float(s),
        delta: i === survivorIds.length - 1 ? bal - share * (survivorIds.length - 1) : share,
      }));
      appendEvent(db, {
        agentId,
        type: "penalty",
        subtype: "execution:estate",
        payload: { reason, from: src, heirs: survivorIds },
        postings: [{ account: src, delta: -bal }, ...postings],
      });
    }
  });
  tx();
}
