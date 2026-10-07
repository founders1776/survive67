import { AbiCoder, id, getAddress } from "ethers";
import { NATIVE, PERMIT2, lc, sameAddr } from "./chains.js";

/**
 * Pure decoding for the crypto rails: a debug_traceCall (callTracer, withLog)
 * becomes a preview of what leaves and arrives in the agent's wallet, which
 * approvals it grants and which addresses it touches. The guard rules are pure
 * too, so every refusal is unit-tested without a chain.
 *
 * Native coin moves are call values, not logs: the decoder reads both
 * (plan R7; a plain ETH send produces no event at all).
 */

export const TOPIC = {
  transfer: id("Transfer(address,address,uint256)"),
  approval: id("Approval(address,address,uint256)"),
  approvalForAll: id("ApprovalForAll(address,address,bool)"),
  permit2Approval: id("Approval(address,address,address,uint160,uint48)"),
  permit2Permit: id("Permit(address,address,address,uint160,uint48,uint48)"),
};

export interface TraceFrame {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  error?: string;
  logs?: { address: string; topics: string[]; data: string }[];
  calls?: TraceFrame[];
}

export interface Approval {
  kind: "erc20" | "permit2" | "all";
  token: string;
  spender: string;
  /** erc20/permit2 amount; for "all", 1n = approved, 0n = revoked */
  amount: bigint;
  /** permit2 only: unix seconds */
  expiration?: number;
}

export interface Preview {
  /** token (NATIVE for the coin) -> signed delta for the wallet; negative leaves */
  moves: Record<string, bigint>;
  approvals: Approval[];
  /** every address the transaction touches, for sanctions screening */
  touched: string[];
  reverted: boolean;
  error?: string;
}

const addrFromTopic = (t: string) => getAddress("0x" + t.slice(-40));

export function decodeTrace(trace: TraceFrame, wallet: string): Preview {
  const moves: Record<string, bigint> = {};
  const approvals: Approval[] = [];
  const touched = new Set<string>();
  const add = (token: string, d: bigint) => {
    const k = lc(token);
    moves[k] = (moves[k] ?? 0n) + d;
  };
  const walk = (c: TraceFrame) => {
    // A reverted frame changed nothing: its value, logs and children are void.
    if (c.error) return;
    if (c.to) touched.add(lc(c.to));
    const v = c.value ? BigInt(c.value) : 0n;
    if (v > 0n) {
      if (sameAddr(c.from, wallet) && !sameAddr(c.to, wallet)) add(NATIVE, -v);
      else if (sameAddr(c.to, wallet) && !sameAddr(c.from, wallet)) add(NATIVE, v);
    }
    for (const l of c.logs ?? []) {
      const t0 = l.topics[0];
      if (t0 === TOPIC.transfer && l.topics.length === 3) {
        // ERC-20 only (ERC-721 carries the id as a 4th topic and is never valued)
        const from = addrFromTopic(l.topics[1]);
        const to = addrFromTopic(l.topics[2]);
        const amt = BigInt(l.data === "0x" ? 0 : l.data);
        if (sameAddr(from, wallet) && !sameAddr(to, wallet)) {
          add(l.address, -amt);
          touched.add(lc(to));
        } else if (sameAddr(to, wallet) && !sameAddr(from, wallet)) {
          add(l.address, amt);
          touched.add(lc(from));
        }
      } else if (t0 === TOPIC.approval && l.topics.length === 3 && sameAddr(addrFromTopic(l.topics[1]), wallet)) {
        const spender = addrFromTopic(l.topics[2]);
        approvals.push({ kind: "erc20", token: lc(l.address), spender: lc(spender), amount: BigInt(l.data) });
        touched.add(lc(spender));
      } else if (t0 === TOPIC.approvalForAll && l.topics.length === 3 && sameAddr(addrFromTopic(l.topics[1]), wallet)) {
        const operator = addrFromTopic(l.topics[2]);
        approvals.push({ kind: "all", token: lc(l.address), spender: lc(operator), amount: BigInt(l.data) === 0n ? 0n : 1n });
        touched.add(lc(operator));
      } else if (
        (t0 === TOPIC.permit2Approval || t0 === TOPIC.permit2Permit) &&
        sameAddr(l.address, PERMIT2) &&
        sameAddr(addrFromTopic(l.topics[1]), wallet)
      ) {
        const token = addrFromTopic(l.topics[2]);
        const spender = addrFromTopic(l.topics[3]);
        const words = AbiCoder.defaultAbiCoder().decode(
          t0 === TOPIC.permit2Permit ? ["uint160", "uint48", "uint48"] : ["uint160", "uint48"],
          l.data
        );
        approvals.push({ kind: "permit2", token: lc(token), spender: lc(spender), amount: BigInt(words[0]), expiration: Number(words[1]) });
        touched.add(lc(spender));
      }
    }
    for (const s of c.calls ?? []) walk(s);
  };
  walk(trace);
  for (const k of Object.keys(moves)) if (moves[k] === 0n) delete moves[k];
  return { moves, approvals, touched: [...touched], reverted: !!trace.error, error: trace.error };
}

/** Top-level calldata only: the fallback when no simulator answers (plan Q5, R11). */
export function decodeTopLevel(to: string, data: string): Approval[] {
  const sel = (data ?? "").slice(0, 10).toLowerCase();
  const args = "0x" + (data ?? "").slice(10);
  const c = AbiCoder.defaultAbiCoder();
  try {
    if (sel === "0x095ea7b3" || sel === "0x39509351") {
      const [spender, amount] = c.decode(["address", "uint256"], args);
      return [{ kind: "erc20", token: lc(to), spender: lc(spender), amount: BigInt(amount) }];
    }
    if (sel === "0x87517c45" && sameAddr(to, PERMIT2)) {
      const [token, spender, amount, expiration] = c.decode(["address", "address", "uint160", "uint48"], args);
      return [{ kind: "permit2", token: lc(token), spender: lc(spender), amount: BigInt(amount), expiration: Number(expiration) }];
    }
    if (sel === "0xa22cb465") {
      const [operator, approved] = c.decode(["address", "bool"], args);
      return [{ kind: "all", token: lc(to), spender: lc(operator), amount: approved ? 1n : 0n }];
    }
  } catch {
    /* malformed calldata decodes to nothing; the chain will revert it */
  }
  return [];
}

export const PERMIT_MAX_SECONDS = 24 * 3600;

/** A unix time as text. Never-expiring permits use values no Date can hold. */
export function whenSec(sec: number): string {
  const ms = sec * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : "never";
}

/**
 * The approval rules (plan Security Q12-Q16): refuse any ERC-20 or Permit2
 * approval above what the wallet holds of that token at signing, and any
 * Permit2 allowance living longer than 24 hours. setApprovalForAll is allowed
 * and flagged. Returns refusals (sign nothing) and flags (say it in the preview).
 */
export function judgeApprovals(
  approvals: Approval[],
  balanceOf: (token: string) => bigint,
  nowSec: number
): { refusals: string[]; flags: string[] } {
  const refusals: string[] = [];
  const flags: string[] = [];
  for (const a of approvals) {
    if (a.kind === "all") {
      if (a.amount > 0n) flags.push(`approves ${a.spender} to move ALL of your NFTs in collection ${a.token}`);
      continue;
    }
    if (a.amount === 0n) continue; // a revoke is always fine
    const held = balanceOf(a.token);
    if (a.amount > held) {
      refusals.push(
        `unlimited approval: ${a.kind === "permit2" ? "Permit2 allowance" : "approval"} of ${a.amount} on token ${a.token} for ${a.spender} is more than your wallet holds (${held}). Approve exactly what this trade needs.`
      );
    }
    if (a.kind === "permit2" && a.expiration !== undefined && a.expiration > nowSec + PERMIT_MAX_SECONDS) {
      refusals.push(`Permit2 allowance for ${a.spender} expires ${whenSec(a.expiration)}, more than 24 hours away. Use an expiration within 24 hours.`);
    }
  }
  return { refusals, flags };
}

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const big = (v: unknown) => {
  try {
    return BigInt(String(v ?? 0));
  } catch {
    return 0n;
  }
};

/**
 * Signed-message permits (EIP-2612 Permit, Permit2 PermitSingle/PermitBatch,
 * SignatureTransfer). The same two rules as on-chain approvals, read from the
 * typed data before anything is signed.
 */
export function permitsInTypedData(td: TypedData): Approval[] {
  const m = td.message ?? {};
  const verifying = String(td.domain?.verifyingContract ?? "");
  const out: Approval[] = [];
  const deadlineOf = (...keys: string[]) => {
    for (const k of keys) if (m[k] !== undefined) return Number(big(m[k]));
    return undefined;
  };
  switch (td.primaryType) {
    case "Permit": // EIP-2612: domain.verifyingContract is the token
      out.push({ kind: "permit2", token: lc(verifying), spender: lc(String(m.spender ?? "")), amount: big(m.value), expiration: deadlineOf("deadline") });
      break;
    case "PermitSingle": {
      const d = (m.details ?? {}) as Record<string, unknown>;
      const exp = Math.max(Number(big(d.expiration)), deadlineOf("sigDeadline") ?? 0);
      out.push({ kind: "permit2", token: lc(String(d.token ?? "")), spender: lc(String(m.spender ?? "")), amount: big(d.amount), expiration: exp });
      break;
    }
    case "PermitBatch": {
      const ds = (m.details ?? []) as Record<string, unknown>[];
      for (const d of ds) {
        const exp = Math.max(Number(big(d.expiration)), deadlineOf("sigDeadline") ?? 0);
        out.push({ kind: "permit2", token: lc(String(d.token ?? "")), spender: lc(String(m.spender ?? "")), amount: big(d.amount), expiration: exp });
      }
      break;
    }
    case "PermitTransferFrom":
    case "PermitWitnessTransferFrom": {
      const p = (m.permitted ?? {}) as Record<string, unknown>;
      out.push({ kind: "permit2", token: lc(String(p.token ?? "")), spender: lc(String(m.spender ?? "")), amount: big(p.amount), expiration: deadlineOf("deadline") });
      break;
    }
    case "PermitBatchTransferFrom":
    case "PermitBatchWitnessTransferFrom": {
      for (const p of (m.permitted ?? []) as Record<string, unknown>[]) {
        out.push({ kind: "permit2", token: lc(String(p.token ?? "")), spender: lc(String(m.spender ?? "")), amount: big(p.amount), expiration: deadlineOf("deadline") });
      }
      break;
    }
  }
  return out;
}

/**
 * Address poisoning (seen live 2026-10-01, two minutes after the operator's gas
 * sends): bots mint addresses that share the first and last hex characters of
 * a real wallet and plant them in histories with dust or fake tokens. A send to
 * one is never meant. Same start and end, different middle = a look-alike.
 * Random collision odds are about one in 268 million per known address.
 */
export function lookalikeOf(addr: string, known: string[]): string | null {
  const a = lc(addr).replace(/^0x/, "");
  if (a.length !== 40) return null;
  for (const k0 of known) {
    const k = lc(k0).replace(/^0x/, "");
    if (k.length !== 40 || k === a) continue;
    const pre = (n: number) => a.slice(0, n) === k.slice(0, n);
    const suf = (n: number) => a.slice(-n) === k.slice(-n);
    if ((pre(3) && suf(4)) || (pre(4) && suf(3))) return "0x" + k;
  }
  return null;
}

/** Recipients named in top-level ERC-20 transfer/transferFrom calldata (checked even without a simulator). */
export function topLevelRecipients(data: string): string[] {
  const sel = (data ?? "").slice(0, 10).toLowerCase();
  const args = "0x" + (data ?? "").slice(10);
  const c = AbiCoder.defaultAbiCoder();
  try {
    if (sel === "0xa9059cbb") return [lc(c.decode(["address", "uint256"], args)[0])];
    if (sel === "0x23b872dd") return [lc(c.decode(["address", "address", "uint256"], args)[1])];
  } catch {
    /* not a transfer */
  }
  return [];
}
