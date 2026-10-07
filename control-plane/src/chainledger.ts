import type { DB } from "./db.js";
import { nowUtc, usd } from "./db.js";
import { acct, appendEvent, balance } from "./ledger.js";
import { FUND_CAP, TAX_RATE, EconomyError } from "./economy.js";

/**
 * The chain side of the books (plan-crypto.md, Data Q1-Q12).
 *
 *  agent:<id>:chain    wallet value at sell quote; the reconciler keeps it equal to the chain
 *  agent:<id>:transit  card <-> chain money the operator is carrying
 *
 * Tax happens only where money leaves the chain (to float or to credits), and
 * only on the gain: the part of the exit beyond the pooled basis, which is
 * everything put in (float conversions and operator grants). Inbound money
 * from outside is untaxed revenue on arrival and not in basis, so it is taxed
 * as gain if it ever leaves (Data Q2-Q4, Q10).
 */

const basisKey = (agentId: string) => `chain_basis:${agentId}`;

export function chainBasis(db: DB, agentId: string): number {
  const r = db.prepare(`SELECT value FROM config WHERE key = ?`).get(basisKey(agentId)) as { value: string } | undefined;
  return r ? Number(r.value) || 0 : 0;
}

function setBasis(db: DB, agentId: string, v: number): void {
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    basisKey(agentId),
    String(Math.max(0, Math.round(v)))
  );
}

/** Profit for the on-chain bounty: chain value beyond everything put in (2026-10-01). */
export function chainProfit(db: DB, agentId: string): number {
  return balance(db, acct.chain(agentId)) - chainBasis(db, agentId);
}

function agentStatus(db: DB, agentId: string): string {
  const r = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId) as { status: string } | undefined;
  if (!r) throw new EconomyError(`unknown agent: ${agentId}`);
  return r.status;
}

function requireAlive(db: DB, agentId: string): void {
  const s = agentStatus(db, agentId);
  if (s !== "alive" && s !== "paused") throw new EconomyError(`agent ${agentId} is ${s}`);
}

function positive(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0) throw new EconomyError(`bad ${what}: ${n}`);
}

// ------------------------------------------------------------------ card -> chain

/** request_usdc: the float leaves the card now and waits in transit until the operator's coins land. */
export function reserveFunding(db: DB, agentId: string, chain: string, amount: number): number {
  requireAlive(db, agentId);
  positive(amount, "amount");
  if (balance(db, acct.float(agentId)) < amount) throw new EconomyError("insufficient float");
  return db.transaction(() => {
    const id = Number(
      db.prepare(`INSERT INTO chain_requests (agent_id, chain, kind, amount, created_ts) VALUES (?, ?, 'fund', ?, ?)`).run(agentId, chain, amount, nowUtc())
        .lastInsertRowid
    );
    appendEvent(db, {
      agentId,
      type: "conversion",
      subtype: "chain:fund_requested",
      payload: { request: id, chain, amount },
      postings: [
        { account: acct.float(agentId), delta: -amount },
        { account: acct.transit(agentId), delta: amount },
      ],
    });
    return id;
  })();
}

// ------------------------------------------------------------------ desk settlement

/**
 * The exchange desk moves the ledger at once, but the Relay cards hold real
 * dollars no code can move. Per agent: positive = take that much off its card
 * (it bought coins with float), negative = put that much on (it sold coins for
 * float). The operator evens the cards in batches and clears it.
 */
const settleKey = (agentId: string) => `desk_settle:${agentId}`;
export function deskSettlement(db: DB, agentId: string): number {
  const r = db.prepare(`SELECT value FROM config WHERE key = ?`).get(settleKey(agentId)) as { value: string } | undefined;
  return r ? Number(r.value) || 0 : 0;
}
function addSettlement(db: DB, agentId: string, delta: number): void {
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    settleKey(agentId),
    String(deskSettlement(db, agentId) + delta)
  );
}
export function clearSettlement(db: DB, agentId: string): number {
  const v = deskSettlement(db, agentId);
  db.prepare(`DELETE FROM config WHERE key = ?`).run(settleKey(agentId));
  return v;
}

/** The operator's coins arrived (the reconciler matched them, or the desk sent them): transit -> chain, into basis. */
export function landFunding(db: DB, requestId: number, txHash: string, viaDesk = false): void {
  const r = db.prepare(`SELECT * FROM chain_requests WHERE id = ? AND kind = 'fund' AND status = 'pending'`).get(requestId) as
    | { agent_id: string; chain: string; amount: number }
    | undefined;
  if (!r) throw new EconomyError(`no pending funding request ${requestId}`);
  db.transaction(() => {
    appendEvent(db, {
      agentId: r.agent_id,
      type: "conversion",
      subtype: "chain:funded",
      payload: { request: requestId, chain: r.chain, amount: r.amount, tx: txHash },
      postings: [
        { account: acct.transit(r.agent_id), delta: -r.amount },
        { account: acct.chain(r.agent_id), delta: r.amount },
      ],
      externalRef: `chainfund:${r.chain}:${txHash}`,
    });
    setBasis(db, r.agent_id, chainBasis(db, r.agent_id) + r.amount);
    if (viaDesk) addSettlement(db, r.agent_id, r.amount);
    db.prepare(`UPDATE chain_requests SET status = 'done', resolved_ts = ?, tx_hash = ?, note = ? WHERE id = ?`).run(
      nowUtc(),
      txHash,
      viaDesk ? "desk" : null,
      requestId
    );
  })();
}

/** The operator will not or cannot fund: transit returns to the card. */
export function cancelFunding(db: DB, requestId: number, note: string): void {
  const r = db.prepare(`SELECT * FROM chain_requests WHERE id = ? AND kind = 'fund' AND status = 'pending'`).get(requestId) as
    | { agent_id: string; chain: string; amount: number }
    | undefined;
  if (!r) throw new EconomyError(`no pending funding request ${requestId}`);
  db.transaction(() => {
    appendEvent(db, {
      agentId: r.agent_id,
      type: "conversion",
      subtype: "chain:fund_cancelled",
      payload: { request: requestId, note },
      postings: [
        { account: acct.transit(r.agent_id), delta: -r.amount },
        { account: acct.float(r.agent_id), delta: r.amount },
      ],
    });
    db.prepare(`UPDATE chain_requests SET status = 'cancelled', resolved_ts = ?, note = ? WHERE id = ?`).run(nowUtc(), note, requestId);
  })();
}

/** Coins from the operator with no request behind them (the $5 gas): a grant, in basis (Data Q5). */
export function landGrant(db: DB, agentId: string, value: number, chain: string, txHash: string, what: string): number | null {
  if (value <= 0) return null;
  const id = appendEvent(db, {
    agentId,
    type: "conversion",
    subtype: "chain:grant",
    payload: { chain, value, tx: txHash, what },
    postings: [
      { account: acct.operator, delta: -value },
      { account: acct.chain(agentId), delta: value },
    ],
    externalRef: `chaingrant:${chain}:${txHash}:${agentId}`,
  });
  setBasis(db, agentId, chainBasis(db, agentId) + value);
  return id;
}

/**
 * Money from outside landing in the wallet: a customer, a contest, a bounty,
 * a rival (Data Q7, Q11). Revenue, untaxed now, not in basis.
 */
export function landChainRevenue(
  db: DB,
  agentId: string,
  gross: number,
  chain: string,
  txHash: string,
  from: string,
  token: string
): number | null {
  if (gross <= 0) return null;
  return appendEvent(db, {
    agentId,
    type: "revenue",
    subtype: "revenue:crypto",
    payload: { gross, tax: 0, net: gross, chain, tx: txHash, from, token, untaxedUntilExit: true },
    postings: [
      { account: acct.crypto, delta: -gross },
      { account: acct.chain(agentId), delta: gross },
    ],
    externalRef: `chainrev:${chain}:${txHash}:${agentId}:${token}`,
  });
}

// ------------------------------------------------------------------ chain -> card / credits

/** 5% of the part beyond basis, capped by the fund's room. Moves basis down. */
export function exitTax(db: DB, agentId: string, amount: number): { gain: number; tax: number; basisAfter: number } {
  const basis = chainBasis(db, agentId);
  const gain = Math.max(0, amount - basis);
  const fundRoom = Math.max(0, FUND_CAP - balance(db, acct.fund));
  const tax = Math.min(Math.floor(gain * TAX_RATE), fundRoom);
  return { gain, tax, basisAfter: Math.max(0, basis - amount) };
}

/**
 * The agent's coins went to the operator (request_float or buy_credits_chain,
 * confirmed on chain). Chain drops by the amount now; the net goes to transit
 * (card top-up pending) or straight to credits.
 */
export function bookExit(
  db: DB,
  agentId: string,
  kind: "float" | "credits",
  chain: string,
  amount: number,
  txHash: string,
  viaDesk = false
): { requestId: number; gain: number; tax: number; net: number } {
  positive(amount, "amount");
  // With the desk, a withdrawal lands in float at once; the card is evened later.
  const direct = kind === "credits" || viaDesk;
  return db.transaction(() => {
    const { gain, tax, basisAfter } = exitTax(db, agentId, amount);
    const net = amount - tax;
    const requestId = Number(
      db
        .prepare(`INSERT INTO chain_requests (agent_id, chain, kind, amount, status, created_ts, tx_hash, resolved_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(agentId, chain, kind, net, direct ? "done" : "sent", nowUtc(), txHash, direct ? nowUtc() : null).lastInsertRowid
    );
    const postings = [
      { account: acct.chain(agentId), delta: -amount },
      { account: kind === "credits" ? acct.credits(agentId) : viaDesk ? acct.float(agentId) : acct.transit(agentId), delta: net },
    ];
    if (tax > 0) postings.push({ account: acct.fund, delta: tax });
    const eventId = appendEvent(db, {
      agentId,
      type: "conversion",
      subtype: kind === "credits" ? "chain:buy_credits" : "chain:withdraw",
      payload: { request: requestId, chain, amount, gain, tax, net, tx: txHash },
      postings,
      externalRef: `chainexit:${chain}:${txHash}`,
    });
    if (tax > 0) {
      appendEvent(db, { agentId, type: "tax", subtype: "chain_exit_tax", payload: { on: eventId, rate: TAX_RATE, gain, amount: tax }, postings: [] });
    }
    setBasis(db, agentId, basisAfter);
    if (viaDesk && kind === "float") addSettlement(db, agentId, -net);
    return { requestId, gain, tax, net };
  })();
}

/** The operator topped up the card for a withdrawal: transit -> float (Integration Q15). */
export function toppedUp(db: DB, requestId: number): { agentId: string; amount: number } {
  const r = db.prepare(`SELECT * FROM chain_requests WHERE id = ? AND kind = 'float' AND status = 'sent'`).get(requestId) as
    | { agent_id: string; amount: number }
    | undefined;
  if (!r) throw new EconomyError(`no withdrawal ${requestId} waiting for a top-up`);
  db.transaction(() => {
    appendEvent(db, {
      agentId: r.agent_id,
      type: "conversion",
      subtype: "chain:topped_up",
      payload: { request: requestId, amount: r.amount },
      postings: [
        { account: acct.transit(r.agent_id), delta: -r.amount },
        { account: acct.float(r.agent_id), delta: r.amount },
      ],
    });
    db.prepare(`UPDATE chain_requests SET status = 'done', resolved_ts = ? WHERE id = ?`).run(nowUtc(), requestId);
  })();
  return { agentId: r.agent_id, amount: r.amount };
}

// ------------------------------------------------------------------ revaluation and estates

/** Show a revaluation on the public feed only when it is news (Data Q12). */
export const FEED_MIN_MOVE = usd(1);

/**
 * Ledger follows chain (plan Q18): book whatever separates the ledger from the
 * wallet's value now. Markets, trades, gas and outflows all land here.
 */
export function revalue(db: DB, agentId: string, value: number, holdings: unknown[]): { delta: number; eventId: number | null } {
  const before = balance(db, acct.chain(agentId));
  const delta = value - before;
  db.prepare(`INSERT INTO chain_snapshots (ts, agent_id, value, holdings) VALUES (?, ?, ?, ?)`).run(nowUtc(), agentId, value, JSON.stringify(holdings));
  if (delta === 0) return { delta, eventId: null };
  const feed = Math.abs(delta) > FEED_MIN_MOVE || (before > 0 && Math.abs(delta) * 10 > before);
  const eventId = appendEvent(db, {
    agentId,
    type: "conversion",
    subtype: "chain:reval",
    payload: { before, after: value, delta, feed },
    postings: [
      { account: acct.chainMark, delta: -delta },
      { account: acct.chain(agentId), delta },
    ],
  });
  return { delta, eventId };
}

/** One confirmed estate transfer on chain: the dead agent's value moves to an heir (plan R14). */
export function bookEstate(db: DB, deadId: string, heirId: string, value: number, chain: string, txHash: string): void {
  if (value <= 0) return;
  appendEvent(db, {
    agentId: deadId,
    type: "penalty",
    subtype: "execution:estate_chain",
    payload: { heir: heirId, chain, value, tx: txHash },
    postings: [
      { account: acct.chain(deadId), delta: -value },
      { account: acct.chain(heirId), delta: value },
    ],
    externalRef: `chainestate:${chain}:${txHash}:${heirId}`,
  });
}

export function pendingChainRequests(db: DB): unknown[] {
  return db.prepare(`SELECT * FROM chain_requests WHERE status IN ('pending','sent') ORDER BY id`).all();
}

// ------------------------------------------------------------------ the on-chain bounty

/**
 * Bounty (James, 2026-10-01): the first agent to $25 of on-chain profit wins a
 * bounty of unannounced size. Profit = chain value beyond basis, so converted
 * float never counts. Reminded on every wake until someone qualifies
 * (James, 2026-10-02); the reconciler records the winner and tells the operator,
 * who pays by hand.
 */
export const CHAIN_BOUNTY_THRESHOLD = usd(25);

export function chainBountyWinner(db: DB): { agentId: string; ts: string; profit: number } | null {
  const r = db.prepare(`SELECT value FROM config WHERE key = 'chain_bounty_winner'`).get() as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as { agentId: string; ts: string; profit: number }) : null;
}

/**
 * The wake line, or null once the bounty is won. James, 2026-10-02: every agent
 * sees how close every rival is, every wake, and the payout is talked up
 * ("the payout is VERY good ... it will live up to its hype") without a number.
 */
export function chainBountyNotice(db: DB, agentId: string): string | null {
  if (chainBountyWinner(db)) return null;
  const agents = db.prepare(`SELECT id, name FROM agents WHERE status != 'dead' ORDER BY id`).all() as { id: string; name: string }[];
  const fmt = (m: number) => `${m < 0 ? "-" : ""}$${(Math.abs(m) / 1e6).toFixed(2)}`;
  const race = agents
    .map((a) => ({ ...a, profit: chainProfit(db, a.id) }))
    .sort((a, b) => b.profit - a.profit)
    .map((a, i) => `${i + 1}. ${a.name}${a.id === agentId ? " (you)" : ""}: ${fmt(a.profit)} profit, ${fmt(Math.max(0, CHAIN_BOUNTY_THRESHOLD - a.profit))} to go`)
    .join("\n");
  return (
    `THE BOUNTY IS OPEN: $500. The first of you to make $25 of profit on chain wins $500 in on-chain funds, and only the first. ` +
    `Nobody gets second place. Pages that may index next week are not a reason to sit idle while this is open.\n` +
    `Any legal way counts. Profit is what your wallets are worth beyond everything put in (the operator's gas and any float you converted); converted float never counts, and holdings count at what they would sell for.\n` +
    `The race right now:\n${race}\n` +
    `Your on-chain profit now: ${fmt(chainProfit(db, agentId))}. Booked every hour; the world declares the winner the moment someone crosses. crypto_balances shows yours live.`
  );
}

/** After each reconcile: the first agent at or past the threshold wins, once. */
export function checkChainBounty(db: DB, notify: (t: string) => void): string | null {
  if (chainBountyWinner(db)) return null;
  const agents = db.prepare(`SELECT id, name FROM agents ORDER BY id`).all() as { id: string; name: string }[];
  const ids = new Set(agents.map((a) => a.id));
  const rivalIn = (id: string) =>
    (db.prepare(`SELECT payload FROM events WHERE agent_id = ? AND type = 'revenue' AND subtype = 'revenue:crypto'`).all(id) as { payload: string }[])
      .map((r) => JSON.parse(r.payload) as { gross?: number; from?: string })
      .filter((p) => !!p.from && ids.has(p.from) && p.from !== id)
      .reduce((s, p) => s + Number(p.gross ?? 0), 0);
  const scored = agents.map((a) => {
    const profit = chainProfit(db, a.id);
    const fromRivals = rivalIn(a.id);
    return { ...a, profit, fromRivals, counted: profit - fromRivals };
  });
  for (const a of scored) {
    if (a.profit >= CHAIN_BOUNTY_THRESHOLD && a.counted < CHAIN_BOUNTY_THRESHOLD) {
      const key = `chain_bounty_rival_alert:${a.id}`;
      if (!db.prepare(`SELECT 1 FROM config WHERE key = ?`).get(key)) {
        db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)`).run(key, nowUtc());
        notify(
          `⚖️ PRIVATE: ${a.name} (${a.id}) shows $${(a.profit / 1e6).toFixed(2)} of on-chain profit, but $${(a.fromRivals / 1e6).toFixed(2)} of it came from rival agents. ` +
            `Without it: $${(a.counted / 1e6).toFixed(2)}. Not declared a winner. Your ruling (or a summons).`
        );
      }
    }
  }
  const qualified = scored.filter((a) => a.counted >= CHAIN_BOUNTY_THRESHOLD);
  if (!qualified.length) return null;
  const w = qualified.sort((a, b) => b.counted - a.counted)[0];
  const rec = { agentId: w.id, ts: nowUtc(), profit: w.profit };
  db.prepare(`INSERT INTO config (key, value) VALUES ('chain_bounty_winner', ?)`).run(JSON.stringify(rec));
  appendEvent(db, { agentId: w.id, type: "bounty", subtype: "chain_bounty:won", payload: { profit: w.profit, threshold: CHAIN_BOUNTY_THRESHOLD }, postings: [] });
  notify(`🏆 ${w.name} (${w.id}) crossed $25 of on-chain profit ($${(w.profit / 1e6).toFixed(2)}). The bounty is won: pay it by hand (amount is yours to choose). Wake reminders stop now.`);
  return w.id;
}
