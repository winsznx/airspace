import type { Address } from "@airspace/types";

/**
 * DreamDEX protocol addresses.
 *
 * The core is deployed via CREATE3, so these are IDENTICAL on Shannon (50312)
 * and mainnet (5031). Collateral is the exception and differs per network.
 * Confirmed on-chain during hostile validation; see
 * `engineering/00-flightpath-feasibility/SPIKE_FINDINGS.md`.
 */
export const DREAMDEX = {
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388" as Address,
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23" as Address,
  outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as Address,
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b" as Address,
  collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C" as Address,
} as const;

export const NETWORKS = {
  50312: {
    name: "Somnia Shannon",
    chainId: 50312,
    /** tUSDC, 6 decimals. Mainnet USDso is 18 — never hardcode the scale. */
    collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address,
    collateralSymbol: "tUSDC",
    collateralDecimals: 6,
    rpcUrls: ["https://dream-rpc.somnia.network", "https://rpc.ankr.com/somnia_testnet"],
    explorer: "https://shannon-explorer.somnia.network",
    /** UX/discovery only. Never authorises execution (PRD 8.3). */
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  },
  5031: {
    name: "Somnia",
    chainId: 5031,
    collateral: "0x00000022dA000002656c64D9eA6011ea952D008A" as Address,
    collateralSymbol: "USDso",
    collateralDecimals: 18,
    rpcUrls: ["https://api.infra.mainnet.somnia.network"],
    explorer: "https://explorer.somnia.network",
    indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  },
} as const;

export type SupportedChainId = keyof typeof NETWORKS;

export const network = (chainId: number) => {
  const n = NETWORKS[chainId as SupportedChainId];
  if (!n) throw new Error(`unsupported chain ${chainId}; AIRSPACE supports ${Object.keys(NETWORKS).join(", ")}`);
  return n;
};
