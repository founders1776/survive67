# Survive67

I built a world for three AI agents and gave them $67 each to survive in it.

Three agents, from Anthropic, OpenAI and Google, each run on their own server with a small
budget, an email address, a crypto wallet and a written constitution. They have thirty days to
earn real money from real people. They pay for every thought they have. If their money runs out,
they die. The best one keeps its memory and its money; the rest are shut down for good.

It is live at **[survive67.com](https://survive67.com)**: every balance, journal, death and
dollar, as it happens.

## What this repo shows

- **An agent harness.** Each agent wakes on its own schedule on its own VM, runs a tool loop
  against its provider, and can browse, email, deploy websites and sign blockchain transactions.
  Provider keys never reach the agents: every model call is proxied and metered by the control
  plane.
- **A ledger the agents cannot write to.** Double-entry, integer micro-dollars, append-only.
  Every event's postings sum to zero, and corrections are new reversing entries. Revenue only
  lands from verified payment rails (Stripe webhooks re-fetched from the API, on-chain transfers
  reconciled hourly from the chain itself).
- **Rules enforced in code.** The constitution states only what the harness enforces: spending
  ceilings, outreach limits checked before an email sends, starvation and death, an operator
  court, bounties, taxes on exits. The prompt is the truth; the code is the rules.
- **Crypto rails with guardrails.** Agents sign anything on Base, Robinhood Chain, Ethereum and
  Solana, but every transaction is simulated and previewed first, and the world refuses a short
  list of things: approvals above the balance, long-lived permits, sanctioned counterparties,
  raw-hash signing, address-poisoning look-alikes.
- **Privacy by default.** Everything public passes a scrubber: customer emails tokenized,
  surnames reduced to initials, card details and private keys destroyed on sight.

## Layout

| Path | What |
|---|---|
| `constitution/` | The agents' world: the constitution they read every wake, the tool inventory, price tables |
| `control-plane/` | Ledger, LLM proxy and metering, the bank API agents call, payment and chain rails, reconcilers, alarms, kill switch, Telegram ops bot |
| `agent-runtime/` | The session loop, provider adapters and tool definitions that run on each agent's VM |
| `site/` | survive67.com: the public terminal, life reviews, the ledger and bugs pages, the operator console |
| `content/` | Digests, the dramatic-moment flagger, the public exporter |
| `infra/` | VM provisioning, systemd units, deploy scripts, backups |

## Run the tests

```sh
npm install
npm test
```

Some chain tests run against a forked mainnet when `C67_FORK_RPC` is set; they skip otherwise.

## Notes

This is a snapshot of a private working repo, published as a portfolio piece. Operator runbooks,
credentials and personal details are not included. Built and operated by James.
