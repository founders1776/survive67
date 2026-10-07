import type { DB } from "./db.js";
import { nowUtc, fmtUsd } from "./db.js";
import { acct, appendEvent } from "./ledger.js";
import { bookEstate } from "./chainledger.js";
import type { ChainRail } from "./rails/chain.js";
import { CHAINS, CHAIN_KEYS, NATIVE, lc, sameAddr, type ChainCfg } from "./rails/chains.js";
import type { SolanaRail } from "./rails/solana.js";
import { solEstate, solSweep } from "./solchain.js";

/**
 * Coins that must move on chain because the books say so: an executed agent's
 * estate (plan R14: redistribution on death, James 2026-10-01) and a breach
 * sweep (plan Q4). Booking a split in the ledger alone would be undone by the
 * next reconcile, so each share is booked from its confirmed transfer.
 */

/** Gas kept back per transfer when the native coin itself is being moved. */
async function gasReserve(rail: ChainRail, c: ChainCfg, transfers: number): Promise<bigint> {
  const price = BigInt(await rail.rpc<string>(c, "eth_gasPrice", []));
  return price * 90_000n * 2n * BigInt(Math.max(1, transfers));
}

function counted(db: DB, agentId: string, c: ChainCfg, token: string): boolean {
  if (sameAddr(token, NATIVE) || sameAddr(token, c.stable.address)) return true;
  const r = db.prepare(`SELECT solicited FROM chain_tokens WHERE agent_id = ? AND chain = ? AND token = ?`).get(agentId, c.key, lc(token)) as
    | { solicited: number }
    | undefined;
  return !!r?.solicited;
}

function log(db: DB, agentId: string, c: ChainCfg, kind: string, hash: string, summary: string, detail: Record<string, unknown>): void {
  db.prepare(`INSERT INTO chain_txlog (ts, agent_id, chain, kind, tx_hash, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    nowUtc(),
    agentId,
    c.key,
    kind,
    lc(hash),
    summary,
    JSON.stringify(detail)
  );
}

/** Move every counted holding of `from` to `recipients` in equal shares. Native goes last, net of gas. */
async function distribute(
  db: DB,
  rail: ChainRail,
  agentId: string,
  c: ChainCfg,
  recipients: string[],
  kind: "estate" | "sweep",
  onShare: (recipient: string, value: number, hash: string) => void
): Promise<{ moved: number; skipped: string[] }> {
  const from = rail.addressOf(agentId);
  if (!from) return { moved: 0, skipped: ["no wallet"] };
  const holds = (await rail.holdings(c, from)).filter((h) => counted(db, agentId, c, h.token));
  const tokens = holds.filter((h) => !sameAddr(h.token, NATIVE));
  const native = holds.find((h) => sameAddr(h.token, NATIVE))?.amount ?? 0n;
  const reserve = await gasReserve(rail, c, tokens.length * recipients.length + recipients.length);
  const skipped: string[] = [];
  let moved = 0;
  if (tokens.length && native < reserve) {
    skipped.push(`${c.key}: not enough ETH for gas to move ${tokens.length} token(s); the operator can grant gas and retry`);
    return { moved, skipped };
  }
  for (const h of tokens) {
    const share = h.amount / BigInt(recipients.length);
    if (share === 0n) continue;
    for (const to of recipients) {
      const r = await rail.send(c, agentId, { to: h.token, data: rail.transferData(to, share), value: 0n }, true);
      log(db, agentId, c, kind, r.txHash, `${kind}: ${share} of ${h.token} to ${to}`, { token: h.token, to, amount: share.toString() });
      if (r.status !== "confirmed") {
        skipped.push(`${c.key}: ${h.token} to ${to} ${r.status} (${r.txHash})`);
        continue;
      }
      const v = Number(await rail.sellQuote(c, h.token, share));
      onShare(to, v, r.txHash);
      moved++;
    }
  }
  const left = (await rail.balanceOf(c, NATIVE, from)) - (await gasReserve(rail, c, recipients.length));
  if (left > 0n) {
    const share = left / BigInt(recipients.length);
    for (const to of recipients) {
      if (share === 0n) break;
      const r = await rail.send(c, agentId, { to, data: "0x", value: share }, true);
      log(db, agentId, c, kind, r.txHash, `${kind}: ${share} wei ETH to ${to}`, { token: NATIVE, to, amount: share.toString() });
      if (r.status !== "confirmed") {
        skipped.push(`${c.key}: ETH to ${to} ${r.status} (${r.txHash})`);
        continue;
      }
      onShare(to, Number(await rail.sellQuote(c, NATIVE, share)), r.txHash);
      moved++;
    }
  }
  return { moved, skipped };
}

export async function chainEstate(db: DB, rail: ChainRail, deadId: string, heirs: string[], notify: (t: string) => void, sol?: SolanaRail): Promise<void> {
  if (!rail.configured || heirs.length === 0) return;
  const heirAddr = new Map(heirs.map((h) => [lc(rail.addressOf(h) ?? ""), h]));
  const recipients = [...heirAddr.keys()].filter(Boolean);
  if (recipients.length === 0) return;
  const notes: string[] = [];
  for (const key of CHAIN_KEYS) {
    const c = CHAINS[key];
    const r = await distribute(db, rail, deadId, c, recipients, "estate", (to, value, hash) => {
      bookEstate(db, deadId, heirAddr.get(lc(to))!, value, key, hash);
    });
    notes.push(`${key}: ${r.moved} transfer(s)${r.skipped.length ? `, skipped ${r.skipped.join("; ")}` : ""}`);
  }
  if (sol?.configured && sol.addressOf(deadId)) notes.push(await solEstate(db, sol, deadId, heirs).catch((e) => `solana: failed (${String((e as Error)?.message ?? e).slice(0, 100)})`));
  notify(`⚖️ chain estate of ${deadId} split among ${heirs.join(", ")}: ${notes.join(" | ")}`);
}

/**
 * After a breach alarm, on the operator's word: move what is left to the
 * operator's wallet, held in trust as transit (owed back to the agent).
 */
export async function chainSweep(db: DB, rail: ChainRail, agentId: string, operatorAddr: string | null, notify: (t: string) => void, sol?: SolanaRail): Promise<void> {
  if (!operatorAddr) throw new Error("operator wallet not configured (C67_OPERATOR_ADDR)");
  let total = 0;
  const notes: string[] = [];
  for (const key of CHAIN_KEYS) {
    const c = CHAINS[key];
    const r = await distribute(db, rail, agentId, c, [operatorAddr], "sweep", (_to, value, hash) => {
      total += value;
      appendEvent(db, {
        agentId,
        type: "conversion",
        subtype: "chain:swept",
        payload: { chain: key, value, tx: hash, why: "breach sweep, held by the operator in trust" },
        postings: [
          { account: acct.chain(agentId), delta: -value },
          { account: acct.transit(agentId), delta: value },
        ],
        externalRef: `chainsweep:${key}:${hash}`,
      });
    });
    notes.push(`${key}: ${r.moved} transfer(s)${r.skipped.length ? `, skipped ${r.skipped.join("; ")}` : ""}`);
  }
  if (sol?.configured && sol.addressOf(agentId)) {
    const s = await solSweep(db, sol, agentId).catch((e) => ({ total: 0, note: `solana: failed (${String((e as Error)?.message ?? e).slice(0, 100)})` }));
    total += s.total;
    notes.push(s.note);
  }
  if (total > 0) {
    db.prepare(`INSERT INTO chain_requests (agent_id, chain, kind, amount, status, created_ts, note) VALUES (?, 'base', 'float', ?, 'sent', ?, 'breach sweep')`).run(
      agentId,
      total,
      nowUtc()
    );
  }
  notify(`🧹 swept ${agentId}: $${fmtUsd(total)} now in your wallet, held for it as transit. ${notes.join(" | ")}. Return it as float with /chain_topped <id>.`);
}
