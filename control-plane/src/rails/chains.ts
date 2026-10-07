/**
 * The chains the crypto rails run on: Base and Robinhood Chain (plan R3d,
 * 2026-10-01), Ethereum (2026-10-04, plan-eth.md). One key per agent signs on
 * all of them: an EVM address is the same on every EVM chain.
 *
 * Every address here was read live before it went in: Kyber's whitelist and a
 * real WETH -> USDG route on Robinhood, a real USDC swap on a Base fork, and
 * USDG's symbol() on chain. The Kyber router has the same address on both.
 */

export type ChainKey = "base" | "robinhood" | "ethereum";

export interface ChainCfg {
  key: ChainKey;
  chainId: number;
  /** Alchemy subdomain: https://<alchemy>.g.alchemy.com/v2/<key> */
  alchemy: string;
  /** Alchemy Prices API network name */
  pricesNetwork: string;
  /** KyberSwap aggregator path segment */
  kyber: string;
  /** the dollar coin the operator funds and withdraws in */
  stable: { address: string; symbol: string; decimals: number };
  weth: string;
  /** contracts the swap helper may send a swap to */
  routers: string[];
  explorer: string;
}

export const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

export const CHAINS: Record<ChainKey, ChainCfg> = {
  base: {
    key: "base",
    chainId: 8453,
    alchemy: "base-mainnet",
    pricesNetwork: "base-mainnet",
    kyber: "base",
    stable: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    weth: "0x4200000000000000000000000000000000000006",
    routers: [KYBER_ROUTER],
    explorer: "https://basescan.org",
  },
  robinhood: {
    key: "robinhood",
    chainId: 4663,
    alchemy: "robinhood-mainnet",
    pricesNetwork: "robinhood-mainnet",
    kyber: "robinhood",
    stable: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", decimals: 6 },
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    routers: [KYBER_ROUTER],
    explorer: "https://robinhoodchain.blockscout.com",
  },
  // Added 2026-10-04 for bug-bounty payouts that arrive as USDC on Ethereum (Patch, gate #52).
  // Gas here is real money; the desk holds nothing on this chain.
  ethereum: {
    key: "ethereum",
    chainId: 1,
    alchemy: "eth-mainnet",
    pricesNetwork: "eth-mainnet",
    kyber: "ethereum",
    stable: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    routers: [KYBER_ROUTER],
    explorer: "https://etherscan.io",
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

/** Chainalysis sanctions oracle on Base. It screens every chain's counterparties (same addresses). */
export const SANCTIONS_ORACLE = "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B";

/** Uniswap's Permit2, same address on every chain it is deployed to. */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Kyber's and the ERC-7528 placeholder for the native coin. */
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export function chainCfg(key: unknown): ChainCfg {
  const k = String(key ?? "base").toLowerCase();
  if (k === "base" || k === "robinhood" || k === "ethereum") return CHAINS[k];
  if (k === "eth" || k === "mainnet") return CHAINS.ethereum;
  throw new Error(`unknown chain: ${String(key)} (use "base", "robinhood" or "ethereum")`);
}

export const lc = (a: string) => a.toLowerCase();
export const sameAddr = (a?: string | null, b?: string | null) => !!a && !!b && lc(a) === lc(b);

/**
 * Solana (2026-10-07, plan-sol.md): a fourth chain for payouts that only come
 * on Solana (Superteam, for Patch). Not an EVM chain, so it is not in CHAINS or
 * CHAIN_KEYS and never reaches the EVM rail; rails/solana.ts serves it.
 * Base58 is case-sensitive: never lc() a Solana address or signature.
 */
export const SOLANA = {
  key: "solana" as const,
  stable: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
  /** the native coin's id in holdings and previews */
  native: "SOL",
  wsol: "So11111111111111111111111111111111111111112",
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  explorer: "https://solscan.io",
};

export const isSolanaKey = (key: unknown): boolean => String(key ?? "").toLowerCase() === "solana" || String(key ?? "").toLowerCase() === "sol";
