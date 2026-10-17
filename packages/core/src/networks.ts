// Payment rails BOXHAGGLE accepts. Values come from docs.paybox.sh, the PayBox
// plugin guide, the live PayAI facilitator /supported response and the live
// PayBox discover_services catalog (see docs/RECON.md).

export type RailId = "solana" | "base";

export interface Rail {
  id: RailId;
  /** x402 v1 network name. */
  v1Network: string;
  /** x402 v2 CAIP-2 network id. */
  v2Network: string;
  /** Chain id used by PayBox plugin proposals and swaps. */
  payboxChain: string;
  /** MoonX network id used by PayBox get_portfolio. */
  portfolioNetworkId: number;
  /** USDC asset (SPL mint or ERC-20 address). */
  usdc: string;
  family: "solana" | "evm";
  label: string;
}

export const RAILS: Readonly<Record<RailId, Rail>> = {
  solana: {
    id: "solana",
    v1Network: "solana",
    v2Network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payboxChain: "solana:mainnet",
    portfolioNetworkId: 1399811149,
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    family: "solana",
    label: "Solana",
  },
  base: {
    id: "base",
    v1Network: "base",
    v2Network: "eip155:8453",
    payboxChain: "eip155:8453",
    portfolioNetworkId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    family: "evm",
    label: "Base",
  },
};

export function railByNetwork(network: string): Rail | undefined {
  return Object.values(RAILS).find((rail) => rail.v1Network === network || rail.v2Network === network);
}
