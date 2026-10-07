import { Interface, formatUnits, isAddress, isHexString } from "ethers";
import { randomBytes } from "node:crypto";
import type { DB } from "./db.js";
import { nowUtc, usd, fmtUsd } from "./db.js";
import { acct, balance } from "./ledger.js";
import { EconomyError } from "./economy.js";
import { bookExit, cancelFunding, chainBasis, chainProfit, landFunding, reserveFunding } from "./chainledger.js";
import { ChainRail, ChainError, DESK } from "./rails/chain.js";
import { CHAINS, NATIVE, chainCfg, lc, sameAddr, type ChainCfg } from "./rails/chains.js";
import { chainPaused, chainValue } from "./rails/reconcile.js";
import { whenSec, type Preview } from "./rails/decode.js";
import { SOLANA, isSolanaKey } from "./rails/chains.js";
import type { SolanaRail } from "./rails/solana.js";
import { runSolTool } from "./solchain.js";

/**
 * The agent-facing crypto tools (plan-crypto.md Steps 4-6). Every transaction
 * is previewed first and signed only on confirm:true (Code Q9). Nothing here
 * books chain value: the hourly reconciler does that from the chain itself.
 * Only the exits (request_float, buy_credits_chain) book at once, because money
 * leaves the chain account for the card or for credits.
 */

export interface ChainToolCtx {
  db: DB;
  rail: ChainRail;
  notify: (text: string) => void;
  operatorAddr: string | null;
  /** the Solana rail (plan-sol.md); absent in tests that do not need it */
  sol?: SolanaRail;
}

type Json = Record<string, unknown>;
type Result = [number, Json];

export const CHAIN_TOOLS = new Set([
  "crypto_address",
  "crypto_balances",
  "crypto_send",
  "crypto_tx",
  "crypto_swap",
  "crypto_sign_message",
  "register_wallet",
  "request_usdc",
  "request_float",
  "buy_credits_chain",
]);

/** Fair share of the shared Alchemy quota (Integration Q11). Confirmed signing is never counted. */
const quota = new Map<string, { hour: number; n: number }>();
function takeQuota(db: DB, agentId: string): string | null {
  const cap = Number((db.prepare(`SELECT value FROM config WHERE key = 'chain_quota_per_hour'`).get() as { value: string } | undefined)?.value ?? 120) || 120;
  const hour = Math.floor(Date.now() / 3_600_000);
  const q = quota.get(agentId);
  if (!q || q.hour !== hour) {
    quota.set(agentId, { hour, n: 1 });
    return null;
  }
  if (q.n >= cap) {
    return `quota: ${cap} previews, quotes and balance reads per hour are your share of the world's chain data. Retry at ${new Date((hour + 1) * 3_600_000).toISOString()}. Confirmed transactions are never limited.`;
  }
  q.n++;
  return null;
}

const ERC20 = new Interface(["function symbol() view returns (string)"]);
const symbolCache = new Map<string, string>();
async function symbolOf(rail: ChainRail, c: ChainCfg, token: string): Promise<string> {
  if (sameAddr(token, NATIVE)) return "ETH";
  if (sameAddr(token, c.stable.address)) return c.stable.symbol;
  const k = `${c.key}:${lc(token)}`;
  if (symbolCache.has(k)) return symbolCache.get(k)!;
  try {
    const out = await rail.rpc<string>(c, "eth_call", [{ to: token, data: ERC20.encodeFunctionData("symbol") }, "latest"]);
    const s = String(ERC20.decodeFunctionResult("symbol", out)[0]).slice(0, 20);
    symbolCache.set(k, s);
    return s;
  } catch {
    return lc(token).slice(0, 10);
  }
}

async function describe(rail: ChainRail, c: ChainCfg, p: Preview | null): Promise<Json | null> {
  if (!p) return null;
  const moves = [];
  for (const [token, d] of Object.entries(p.moves)) {
    const dec = await rail.decimals(c, token).catch(() => 18);
    moves.push({ token, symbol: await symbolOf(rail, c, token), [d < 0n ? "leaves" : "arrives"]: formatUnits(d < 0n ? -d : d, dec) });
  }
  const approvals = [];
  for (const a of p.approvals) {
    approvals.push({
      kind: a.kind,
      token: a.token,
      symbol: a.kind === "all" ? "NFT collection" : await symbolOf(rail, c, a.token),
      spender: a.spender,
      amount: a.kind === "all" ? (a.amount ? "ALL" : "revoked") : a.amount.toString(),
      ...(a.expiration !== undefined ? { expires: whenSec(a.expiration) } : {}),
    });
  }
  return { moves, approvals, touches: p.touched.length, reverts: p.reverted ? p.error ?? true : false };
}

function logTx(db: DB, agentId: string, c: ChainCfg, kind: string, txHash: string | null, summary: string, detail: Json = {}): void {
  db.prepare(`INSERT INTO chain_txlog (ts, agent_id, chain, kind, tx_hash, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    nowUtc(),
    agentId,
    c.key,
    kind,
    txHash ? lc(txHash) : null,
    summary.slice(0, 300),
    JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 4000)
  );
}

function tokenArg(c: ChainCfg, v: unknown): string {
  const s = String(v ?? "").trim();
  const u = s.toUpperCase();
  if (u === "ETH" || u === "NATIVE") return NATIVE;
  if (u === c.stable.symbol || u === "USD" || u === "STABLE") return c.stable.address;
  if (u === "WETH") return c.weth;
  if (isAddress(s)) return s;
  throw new ChainError(`unknown token "${s}" on ${c.key}: use an address, ETH, WETH or ${c.stable.symbol}`);
}

const refused = (refusals: string[], extra: Json = {}): Result => [
  200,
  { signed: false, refused: true, refusals, ...extra, note: "The world refuses only these things. Change the transaction and call again." },
];

export async function runChainTool(ctx: ChainToolCtx, agentId: string, tool: string, b: Json): Promise<Result> {
  const { db, rail } = ctx;
  const wallet = rail.addressOf(agentId);
  if (!wallet || !rail.configured) return [501, { error: "crypto rail not configured" }];
  if (tool === "crypto_address") {
    return [
      200,
      {
        address: wallet,
        chains: Object.values(CHAINS).map((c) => ({ chain: c.key, chainId: c.chainId, stable: c.stable.symbol, explorer: `${c.explorer}/address/${wallet}` })),
        ...(ctx.sol?.addressOf(agentId)
          ? { solana: { address: ctx.sol.addressOf(agentId), stable: SOLANA.stable.symbol, gas: "SOL", explorer: `${SOLANA.explorer}/account/${ctx.sol.addressOf(agentId)}` } }
          : {}),
        note: "The same 0x address on every EVM chain. Gas is ETH on all of them; on Ethereum it costs real money, and the exchange desk holds nothing there. Solana is a different address (base58, case-sensitive) and its gas is SOL.",
      },
    ];
  }
  const paused = chainPaused(db, agentId);
  if (paused && tool !== "crypto_balances") {
    return [409, { error: `your crypto tools are paused by the world (${paused}). The operator has been told.` }];
  }
  if (isSolanaKey(b.chain) && tool !== "crypto_balances") {
    if (!ctx.sol?.configured) return [501, { error: "the Solana rail is not configured" }];
    return runSolTool({ db, sol: ctx.sol, notify: ctx.notify }, agentId, tool, b, () => takeQuota(db, agentId));
  }
  try {
    switch (tool) {
      case "crypto_balances": {
        const q = takeQuota(db, agentId);
        if (q) return [429, { error: q }];
        const live = await chainValue(db, rail, agentId, ctx.sol);
        return [
          200,
          {
            live: { value: fmtUsd(live.value), holdings: live.holdings },
            ledger: {
              chain: fmtUsd(balance(db, acct.chain(agentId))),
              transit: fmtUsd(balance(db, acct.transit(agentId))),
              basis: fmtUsd(chainBasis(db, agentId)),
              profit: fmtUsd(chainProfit(db, agentId)),
            },
            note: "live is what your wallets would sell for now. The ledger catches up hourly. Tokens you did not acquire yourself count as $0 until you sell them. Profit = chain value beyond everything put in (gas grant and converted float).",
          },
        ];
      }
      case "crypto_tx": {
        const c = chainCfg(b.chain);
        const to = b.to === undefined || b.to === null || b.to === "" ? null : String(b.to);
        if (to !== null && !isAddress(to)) return [400, { error: `not an address: ${to}` }];
        const data = String(b.data ?? "0x");
        if (!isHexString(data)) return [400, { error: "data must be 0x-prefixed hex calldata" }];
        const value = BigInt(String(b.value_wei ?? "0"));
        const tx = { to, data, value };
        if (b.confirm !== true) {
          const q = takeQuota(db, agentId);
          if (q) return [429, { error: q }];
        }
        const ev = await rail.evaluate(c, wallet, tx);
        if (ev.refusals.length) return refused(ev.refusals, { preview: await describe(rail, c, ev.preview) });
        if (b.confirm !== true) {
          return [
            200,
            {
              signed: false,
              preview: await describe(rail, c, ev.preview),
              flags: ev.flags,
              next: "Read the preview. To sign exactly this, call crypto_tx again with the same chain, to, data and value_wei and confirm: true.",
            },
          ];
        }
        const r = await rail.send(c, agentId, tx, b.wait !== false);
        logTx(db, agentId, c, "tx", r.txHash, `tx to ${to ?? "(contract creation)"}`, { to, value: value.toString(), selector: data.slice(0, 10), preview: await describe(rail, c, ev.preview) });
        return [200, { signed: true, ...r, flags: ev.flags }];
      }
      case "crypto_swap": {
        const c = chainCfg(b.chain);
        const tokenIn = tokenArg(c, b.token_in);
        const tokenOut = tokenArg(c, b.token_out);
        const amountIn = await rail.parseAmount(c, tokenIn, b.amount);
        const slippageBps = Math.max(1, Math.min(5_000, Math.round(Number(b.slippage_bps ?? 100)) || 100));
        if (b.confirm !== true) {
          const q = takeQuota(db, agentId);
          if (q) return [429, { error: q }];
        }
        const held = await rail.balanceOf(c, tokenIn, wallet);
        if (held < amountIn) return [400, { error: `you hold ${formatUnits(held, await rail.decimals(c, tokenIn))}, not ${String(b.amount)}` }];
        const route = await rail.kyberSwap(c, wallet, tokenIn, tokenOut, amountIn, slippageBps);
        if (!rail.isRouter(c, route.to)) return refused([`the aggregator returned a router the world does not know (${route.to}); nothing signed`]);
        const outDec = await rail.decimals(c, tokenOut);
        const needsApproval = !sameAddr(tokenIn, NATIVE) && (await rail.allowance(c, tokenIn, wallet, route.to)) < amountIn;
        const quote = { amountOut: formatUnits(route.amountOut, outDec), minOut: formatUnits(route.minOut, outDec), slippage_bps: slippageBps };
        if (b.confirm !== true) {
          const ev = needsApproval ? null : await rail.evaluate(c, wallet, route);
          if (ev?.refusals.length) return refused(ev.refusals);
          return [
            200,
            {
              signed: false,
              quote,
              ...(needsApproval
                ? { approval: `the world will first approve the router for exactly ${String(b.amount)} (nothing more), then swap` }
                : { preview: await describe(rail, c, ev!.preview), flags: ev!.flags }),
              next: "To swap, call crypto_swap again with the same arguments and confirm: true. The route is rebuilt at that moment.",
            },
          ];
        }
        if (needsApproval) {
          const ap = { to: tokenIn, data: rail.approveData(route.to, amountIn), value: 0n };
          const apEv = await rail.evaluate(c, wallet, ap);
          if (apEv.refusals.length) return refused(apEv.refusals);
          const a = await rail.send(c, agentId, ap, true);
          logTx(db, agentId, c, "approve", a.txHash, `approve router for exactly ${String(b.amount)}`, { token: tokenIn, spender: route.to, amount: amountIn.toString() });
          if (a.status !== "confirmed") return [502, { error: `approval ${a.status}`, ...a }];
        }
        const fresh = await rail.kyberSwap(c, wallet, tokenIn, tokenOut, amountIn, slippageBps);
        if (!rail.isRouter(c, fresh.to)) return refused([`the aggregator returned a router the world does not know (${fresh.to}); nothing signed`]);
        const ev = await rail.evaluate(c, wallet, fresh);
        if (ev.refusals.length) return refused(ev.refusals);
        if (!ev.preview) return refused(["the simulator is down, so the swap helper cannot check that your tokens arrive. Use crypto_tx (flagged, unsimulated) or try later."]);
        const arrives = ev.preview.moves[lc(tokenOut)] ?? 0n;
        if (ev.preview.reverted || arrives < fresh.minOut) {
          return refused([`the simulation shows ${formatUnits(arrives > 0n ? arrives : 0n, outDec)} arriving, below the minimum ${formatUnits(fresh.minOut, outDec)}; nothing signed`]);
        }
        const r = await rail.send(c, agentId, fresh, b.wait !== false);
        logTx(db, agentId, c, "swap", r.txHash, `swap ${String(b.amount)} ${await symbolOf(rail, c, tokenIn)} for ${await symbolOf(rail, c, tokenOut)}`, {
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          expected: fresh.amountOut.toString(),
        });
        return [200, { signed: true, ...r, quote: { amountOut: formatUnits(fresh.amountOut, outDec), minOut: formatUnits(fresh.minOut, outDec) } }];
      }
      case "crypto_sign_message": {
        const c = chainCfg(b.chain);
        const kind = String(b.kind ?? "personal");
        const r = await rail.signMessage(c, agentId, kind, kind === "typed" ? b.typed_data : b.message);
        if (!r.signature) return refused(r.refusals);
        logTx(db, agentId, c, "message", null, kind === "typed" ? `signed typed data ${String((b.typed_data as Json)?.primaryType ?? "")}` : `signed a text message`, {
          kind,
          ...(kind === "typed" ? { primaryType: (b.typed_data as Json)?.primaryType, domain: (b.typed_data as Json)?.domain } : { chars: String(b.message ?? "").length }),
        });
        return [200, { signed: true, signature: r.signature, flags: r.flags }];
      }
      case "crypto_send": {
        const c = chainCfg(b.chain);
        const to = String(b.to ?? "");
        if (!isAddress(to)) return [400, { error: `not a valid address: ${to}` }];
        const amount = BigInt(usd(Number(b.amount_usd)));
        if (amount <= 0n) return [400, { error: "amount_usd must be positive" }];
        const held = await rail.balanceOf(c, c.stable.address, wallet);
        if (held < amount) {
          return [400, { error: `wallet holds ${formatUnits(held, 6)} ${c.stable.symbol} on ${c.key}, not ${b.amount_usd}. request_usdc converts float, or ask with message_operator.` }];
        }
        const tx = { to: c.stable.address, data: rail.transferData(to, amount), value: 0n };
        const ev = await rail.evaluate(c, wallet, tx);
        if (ev.refusals.length) return refused(ev.refusals);
        const r = await rail.send(c, agentId, tx, true);
        logTx(db, agentId, c, "send", r.txHash, `sent ${b.amount_usd} ${c.stable.symbol} to ${to}`, { to, amount: amount.toString() });
        return [200, { sent: r.status === "confirmed", ...r }];
      }
      case "register_wallet": {
        const address = String(b.address ?? "");
        if (!isAddress(address)) return [400, { error: `not an address: ${address}` }];
        const key = `chain_reg_nonce:${agentId}:${lc(address)}`;
        let nonce = (db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
        if (!nonce) {
          nonce = randomBytes(8).toString("hex");
          db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)`).run(key, nonce);
        }
        const message = `Survive67: ${agentId} controls ${lc(address)}. nonce ${nonce}`;
        if (!b.signature) return [200, { registered: false, sign_this: message, next: "Sign this exact text with that wallet (personal_sign) and call register_wallet again with address and signature." }];
        if (!ChainRail.verifyOwnership(message, String(b.signature), address)) return [400, { error: "signature does not prove control of that address" }];
        db.prepare(`INSERT OR IGNORE INTO chain_wallets (agent_id, address, created_ts, proof) VALUES (?, ?, ?, ?)`).run(agentId, lc(address), nowUtc(), String(b.signature));
        return [200, { registered: true, address: lc(address), note: "Counted in your chain value from the next hourly reconcile, on both chains." }];
      }
      case "request_usdc": {
        const c = chainCfg(b.chain);
        const amount = usd(Number(b.amount_usd));
        if (!rail.addressOf(DESK)) {
          // No desk key on this control plane: the operator sends by hand (the original flow).
          const id = reserveFunding(db, agentId, c.key, amount);
          ctx.notify(
            `🔗 request #${id}: ${agentId} converts $${fmtUsd(amount)} of float to ${c.stable.symbol} on ${c.key}.\n` +
              `Send EXACTLY ${fmtUsd(amount)} ${c.stable.symbol} from your operator wallet to ${wallet} on ${c.key}. It books itself when it lands.\n` +
              `Cannot? /chain_cancel ${id}`
          );
          return [200, { request: id, amount: fmtUsd(amount), chain: c.key, status: "pending", note: "The float has left your card and waits in transit until the operator sends the coins." }];
        }
        return deskFill(ctx, agentId, wallet, c, amount);
      }
      case "request_float":
      case "buy_credits_chain": {
        const c = chainCfg(b.chain);
        if (!ctx.operatorAddr) return [501, { error: "operator wallet not configured" }];
        const amount = BigInt(usd(Number(b.amount_usd)));
        if (amount <= 0n) return [400, { error: "amount_usd must be positive" }];
        const held = await rail.balanceOf(c, c.stable.address, wallet);
        if (held < amount) return [400, { error: `wallet holds ${formatUnits(held, 6)} ${c.stable.symbol} on ${c.key}. Swap into ${c.stable.symbol} first.` }];
        const tx = { to: c.stable.address, data: rail.transferData(ctx.operatorAddr, amount), value: 0n };
        const r = await rail.send(c, agentId, tx, true);
        logTx(db, agentId, c, "exit", r.txHash, `${tool === "request_float" ? "withdraw to card" : "buy credits"}: ${fmtUsd(Number(amount))} ${c.stable.symbol} to the operator`, { amount: amount.toString() });
        if (r.status !== "confirmed") return [502, { error: `transfer ${r.status}; nothing booked`, ...r }];
        const kind = tool === "request_float" ? "float" : "credits";
        const viaDesk = !!rail.addressOf(DESK);
        const x = bookExit(db, agentId, kind, c.key, Number(amount), r.txHash, viaDesk);
        ctx.notify(
          kind === "float"
            ? viaDesk
              ? `🏦 desk: ${agentId} sold ${fmtUsd(Number(amount))} ${c.stable.symbol} on ${c.key} for $${fmtUsd(x.net)} of float (tax ${fmtUsd(x.tax)}). Its card is owed $${fmtUsd(x.net)} at the next settlement.`
              : `🏦 #${x.requestId}: ${agentId} sent you ${fmtUsd(Number(amount))} ${c.stable.symbol} on ${c.key} (tax ${fmtUsd(x.tax)}). Top up its card by $${fmtUsd(x.net)}, then /chain_topped ${x.requestId}`
            : `🍞 ${agentId} bought $${fmtUsd(x.net)} of credits from chain (sent you ${fmtUsd(Number(amount))} ${c.stable.symbol} on ${c.key}, tax ${fmtUsd(x.tax)}). Top up its provider console when you can.`
        );
        return [
          200,
          {
            ok: true,
            ...r,
            request: x.requestId,
            gain: fmtUsd(x.gain),
            tax: fmtUsd(x.tax),
            net: fmtUsd(x.net),
            ...(kind === "credits"
              ? { credits: fmtUsd(balance(db, acct.credits(agentId))) }
              : viaDesk
                ? { float: fmtUsd(balance(db, acct.float(agentId))), note: "Landed in your float now. The card itself is evened by the operator in batches." }
                : { note: "Waiting in transit until the operator tops up your card." }),
          },
        ];
      }
    }
    return [404, { error: `unknown crypto tool ${tool}` }];
  } catch (e) {
    if (e instanceof EconomyError || e instanceof ChainError) return [400, { error: e.message }];
    return [502, { error: `crypto: ${String((e as Error)?.message ?? e).slice(0, 300)}` }];
  }
}

/** Gas the desk keeps for itself on each chain, in wei. */
export const DESK_GAS_RESERVE = 2_000_000_000_000_000n; // 0.002 ETH

/**
 * The exchange desk (plan-desk.md): float -> coins with no human. The float
 * leaves the card first (transit), so the agent cannot spend it twice while
 * the coins travel. If the desk holds too little of the stable coin it sells
 * some of its own ETH first, through the same simulated, router-checked swap.
 */
async function deskFill(ctx: ChainToolCtx, agentId: string, wallet: string, c: ChainCfg, amount: number): Promise<Result> {
  const { db, rail } = ctx;
  if (!(amount > 0)) return [400, { error: "amount_usd must be positive" }];
  const desk = rail.addressOf(DESK)!;
  const need = BigInt(amount);
  const dry = (why: string): Result => {
    ctx.notify(`🏧 desk dry on ${c.key}: ${agentId} asked for $${fmtUsd(amount)}. ${why}`);
    return [503, { error: `the exchange desk cannot fill $${fmtUsd(amount)} on ${c.key} right now: ${why} The operator has been told. Your float was not touched.` }];
  };
  const why = await ensureDeskStable(ctx, c, need);
  if (why) return dry(why);
  const id = reserveFunding(db, agentId, c.key, amount); // float -> transit, refuses if float is short
  return payFromDesk(ctx, id, agentId, wallet, c, amount);
}

/**
 * Pay a reserved request (float already in transit) from the desk and book it.
 * Shared by fresh fills and by the minute tick that fills anything left
 * pending: a request filed before the desk went automatic (Apex, 2026-10-01,
 * #1 sat for an hour) or while the desk was dry.
 */
async function payFromDesk(ctx: ChainToolCtx, id: number, agentId: string, wallet: string, c: ChainCfg, amount: number): Promise<Result> {
  const { db, rail } = ctx;
  const desk = rail.addressOf(DESK)!;
  const need = BigInt(amount);
  const tx = { to: c.stable.address, data: rail.transferData(wallet, need), value: 0n };
  const ev = await rail.evaluate(c, desk, tx);
  if (ev.refusals.length) {
    cancelFunding(db, id, "desk refused its own transfer");
    return refused(ev.refusals);
  }
  const r = await rail.send(c, DESK, tx, true);
  logTx(db, agentId, c, "desk", r.txHash, `desk paid ${fmtUsd(amount)} ${c.stable.symbol} for float`, { request: id, amount: need.toString() });
  if (r.status !== "confirmed") {
    if (r.status === "failed") cancelFunding(db, id, `desk transfer failed (${r.txHash})`);
    ctx.notify(`⚠️ desk transfer to ${agentId} is ${r.status}: ${r.explorer}${r.status === "pending" ? ` (request #${id} still in transit)` : ""}`);
    return [502, { error: `desk transfer ${r.status}`, request: id, ...r }];
  }
  landFunding(db, id, r.txHash, true);
  ctx.notify(`🏧 desk: ${agentId} bought ${fmtUsd(amount)} ${c.stable.symbol} on ${c.key} with float. Take $${fmtUsd(amount)} off its card at the next settlement.`);
  return [
    200,
    {
      ok: true,
      request: id,
      amount: fmtUsd(amount),
      chain: c.key,
      ...r,
      float: fmtUsd(balance(db, acct.float(agentId))),
      chainValue: fmtUsd(balance(db, acct.chain(agentId))),
      note: "Filled by the exchange desk. The coins are in your wallet now.",
    },
  ];
}

/**
 * Minute tick: fill every pending float -> coins request the desk can cover.
 * Requests it cannot cover stay pending (float safe in transit) and are retried;
 * the operator hears once per request.
 */
export async function fillPendingFunding(ctx: ChainToolCtx): Promise<number> {
  const { db, rail } = ctx;
  if (!rail.addressOf(DESK)) return 0;
  const rows = db.prepare(`SELECT id, agent_id, chain, amount FROM chain_requests WHERE kind = 'fund' AND status = 'pending' AND chain != 'solana' ORDER BY id`).all() as {
    id: number;
    agent_id: string;
    chain: string;
    amount: number;
  }[];
  let filled = 0;
  for (const r of rows) {
    const wallet = rail.addressOf(r.agent_id);
    if (!wallet) continue;
    const c = chainCfg(r.chain);
    const why = await ensureDeskStable(ctx, c, BigInt(r.amount));
    if (why) {
      const key = `desk_wait_alerted:${r.id}`;
      if (!db.prepare(`SELECT 1 FROM config WHERE key = ?`).get(key)) {
        db.prepare(`INSERT INTO config (key, value) VALUES (?, '1')`).run(key);
        ctx.notify(`🏧 request #${r.id} (${r.agent_id}, $${fmtUsd(r.amount)} on ${c.key}) waits: ${why} The float is safe in transit; the desk retries every minute.`);
      }
      continue;
    }
    const [st] = await payFromDesk(ctx, r.id, r.agent_id, wallet, c, r.amount);
    if (st === 200) filled++;
  }
  return filled;
}

/** Make sure the desk holds `need` of the chain's stable coin, selling its ETH if short. Returns why not, or null. */
async function ensureDeskStable(ctx: ChainToolCtx, c: ChainCfg, need: bigint): Promise<string | null> {
  const { db, rail } = ctx;
  const desk = rail.addressOf(DESK)!;
  let stable = await rail.balanceOf(c, c.stable.address, desk);
  if (stable >= need) return null;
  const per = await rail.sellQuote(c, NATIVE, 1_000_000_000_000_000n); // stable for 0.001 ETH
  if (per <= 0n) return `no price for ETH on ${c.key}.`;
  const ethIn = ((need - stable) * 1_000_000_000_000_000n * 103n) / (per * 100n); // 3% buffer
  const eth = await rail.balanceOf(c, NATIVE, desk);
  if (eth - DESK_GAS_RESERVE < ethIn) return `the desk holds ${formatUnits(stable, c.stable.decimals)} ${c.stable.symbol} and ${formatUnits(eth, 18)} ETH.`;
  const route = await rail.kyberSwap(c, desk, NATIVE, c.stable.address, ethIn, 100);
  if (!rail.isRouter(c, route.to)) return "the aggregator returned an unknown router.";
  const ev = await rail.evaluate(c, desk, route);
  const arrives = ev.preview?.moves[lc(c.stable.address)] ?? 0n;
  if (ev.refusals.length || !ev.preview || arrives < route.minOut) return `its ETH -> ${c.stable.symbol} swap did not check out.`;
  const sw = await rail.send(c, DESK, route, true);
  logTx(db, DESK, c, "swap", sw.txHash, `desk sold ${formatUnits(ethIn, 18)} ETH for ${c.stable.symbol}`, { amountIn: ethIn.toString() });
  if (sw.status !== "confirmed") return `its ETH -> ${c.stable.symbol} swap was ${sw.status}.`;
  stable = await rail.balanceOf(c, c.stable.address, desk);
  return stable >= need ? null : `after selling ETH it holds only ${formatUnits(stable, c.stable.decimals)} ${c.stable.symbol}.`;
}
