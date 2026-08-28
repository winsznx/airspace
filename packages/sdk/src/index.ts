/**
 * @airspace/sdk — the client for AIRSPACE portfolios.
 *
 * One capital pool. Many trading agents. One shared risk envelope.
 *
 * Design rule: nothing here weakens an on-chain check. `simulateAdmission` is
 * advisory and calls the portfolio's own `previewIntent`, so it returns the
 * contract's decision rather than a re-implementation of it. The portfolio
 * contract remains the only authority (PRD 23).
 *
 * All quantities are `bigint`. Formatting belongs to `@airspace/risk`.
 */

import type { Account, Address as ViemAddress, PublicClient, WalletClient, Hex as ViemHex } from "viem";
import { encodeAbiParameters, keccak256 } from "viem";
import type {
  Address,
  AdmissionView,
  AgentPolicy,
  DomainId,
  DomainPolicy,
  GlobalPolicy,
  Hex,
  Intent,
  Market,
  MarketId,
} from "@airspace/types";
import { Refusal } from "@airspace/types";
import { DREAMDEX, network, readMarket, readLiveState, discoverMarkets, domainKey } from "@airspace/protocol";
import { reserveFor } from "@airspace/risk";
import { airspacePortfolioAbi, airspacePortfolioFactoryAbi } from "./abi.js";

export { airspacePortfolioAbi, airspacePortfolioFactoryAbi } from "./abi.js";

/** Function-name unions derived from the generated ABI, so a typo cannot compile. */
type PortfolioAbi = typeof airspacePortfolioAbi;
type ReadFn = Extract<PortfolioAbi[number], { type: "function"; stateMutability: "view" | "pure" }>["name"];
type WriteFn = Extract<PortfolioAbi[number], { type: "function"; stateMutability: "nonpayable" | "payable" }>["name"];

export interface AirspaceConfig {
  chainId: number;
  factory: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

export interface PortfolioState {
  address: Address;
  owner: Address;
  collateralToken: Address;
  capitalBase: bigint;
  freeCollateral: bigint;
  committedCapital: bigint;
  reservedCollateral: bigint;
  globalPolicy: GlobalPolicy;
  globalPolicyHash: Hex;
  policyEpoch: bigint;
}

export interface DomainState {
  domain: DomainId;
  policy: DomainPolicy;
  usage: bigint;
  markets: MarketId[];
  liveMarkets: number;
  /** Remaining headroom before the ceiling refuses new exposure. */
  headroom: bigint;
}

export class Airspace {
  readonly chainId: number;
  readonly factory: Address;
  readonly pub: PublicClient;
  readonly wallet?: WalletClient;

  constructor(cfg: AirspaceConfig) {
    this.chainId = cfg.chainId;
    this.factory = cfg.factory;
    this.pub = cfg.publicClient;
    if (cfg.walletClient) this.wallet = cfg.walletClient;
    network(cfg.chainId); // fail fast on an unsupported chain
  }

  private requireWallet(): WalletClient {
    if (!this.wallet) throw new Error("a wallet client is required for write operations");
    return this.wallet;
  }

  // ------------------------------------------------------------- discovery

  /** Portfolios owned by an address, straight from the factory (no indexer). */
  async portfoliosOf(owner: Address): Promise<Address[]> {
    return (await this.pub.readContract({
      address: this.factory as ViemAddress,
      abi: airspacePortfolioFactoryAbi,
      functionName: "portfoliosOf",
      args: [owner as ViemAddress],
    })) as Address[];
  }

  /** The deterministic address a portfolio will occupy, before it exists. */
  async predictPortfolio(owner: Address, salt: Hex): Promise<Address> {
    return (await this.pub.readContract({
      address: this.factory as ViemAddress,
      abi: airspacePortfolioFactoryAbi,
      functionName: "portfolioFor",
      args: [owner as ViemAddress, salt as ViemHex],
    })) as Address;
  }

  async createPortfolio(owner: Address, salt: Hex, account?: Account | Address) {
    const w = this.requireWallet();
    const { request } = await this.pub.simulateContract({
      address: this.factory as ViemAddress,
      abi: airspacePortfolioFactoryAbi,
      functionName: "createPortfolio",
      args: [owner as ViemAddress, salt as ViemHex],
      account: (account ?? w.account) as Account,
    });
    return w.writeContract(request);
  }

  // ----------------------------------------------------------------- reads

  async portfolioState(portfolio: Address): Promise<PortfolioState> {
    const read = <T>(functionName: ReadFn, args: readonly unknown[] = []) =>
      this.pub.readContract({
        address: portfolio as ViemAddress,
        abi: airspacePortfolioAbi,
        functionName,
        args: args as never,
      }) as Promise<T>;

    const [owner, collateralToken, capitalBase, reservedCollateral, freeCollateral, committed, gp, gpHash, epoch] =
      await Promise.all([
        read<Address>("owner"),
        read<Address>("collateralToken"),
        read<bigint>("capitalBase"),
        read<bigint>("reservedCollateral"),
        read<bigint>("freeCollateral"),
        read<bigint>("committedCapital"),
        read<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]>("globalPolicy"),
        read<Hex>("globalPolicyHash"),
        read<bigint>("policyEpoch"),
      ]);

    return {
      address: portfolio,
      owner,
      collateralToken,
      capitalBase,
      freeCollateral,
      committedCapital: committed,
      reservedCollateral,
      globalPolicy: {
        maxCommittedCapital: gp[0],
        maxReservedCollateral: gp[1],
        maxSingleOrderNotional: gp[2],
        maxBuyPrice: gp[3],
        minSellPrice: gp[4],
        minHeadroomSec: gp[5],
        policyExpiry: gp[6],
      },
      globalPolicyHash: gpHash,
      policyEpoch: epoch,
    };
  }

  async domainState(portfolio: Address, domain: DomainId): Promise<DomainState> {
    const read = <T>(functionName: ReadFn, args: readonly unknown[]) =>
      this.pub.readContract({
        address: portfolio as ViemAddress,
        abi: airspacePortfolioAbi,
        functionName,
        args: args as never,
      }) as Promise<T>;

    const [dp, usage, markets, live] = await Promise.all([
      read<readonly [boolean, bigint, bigint, number]>("domainPolicy", [domain]),
      read<bigint>("domainRiskUsage", [domain]),
      read<MarketId[]>("domainMarkets", [domain]),
      read<number>("liveMarkets", [domain]),
    ]);

    const policy: DomainPolicy = {
      configured: dp[0],
      maxDomainRiskUsage: dp[1],
      maxDomainCommitted: dp[2],
      maxLiveMarkets: dp[3],
    };
    return {
      domain,
      policy,
      usage,
      markets,
      liveMarkets: live,
      headroom: policy.maxDomainRiskUsage > usage ? policy.maxDomainRiskUsage - usage : 0n,
    };
  }

  async agentState(portfolio: Address, agent: Address) {
    const read = <T>(fn: ReadFn, args: readonly unknown[]) =>
      this.pub.readContract({
        address: portfolio as ViemAddress,
        abi: airspacePortfolioAbi,
        functionName: fn,
        args: args as never,
      }) as Promise<T>;

    const [p, committed, nonce, lastTradeAt, policyHash] = await Promise.all([
      read<readonly [boolean, bigint, bigint, bigint, bigint, bigint, Hex]>("agentPolicy", [agent]),
      read<bigint>("agentCommitted", [agent]),
      read<bigint>("agentNonce", [agent]),
      read<bigint>("agentLastTradeAt", [agent]),
      read<Hex>("agentPolicyHash", [agent]),
    ]);
    const policy: AgentPolicy = {
      enabled: p[0],
      maxCommitted: p[1],
      maxOrderNotional: p[2],
      maxBuyPrice: p[3],
      minSellPrice: p[4],
      cooldownSec: p[5],
      strategyId: p[6],
    };
    return {
      address: agent,
      registered: policyHash !== "0x0000000000000000000000000000000000000000000000000000000000000000",
      policy,
      policyHash,
      committed,
      nonce,
      lastTradeAt,
    };
  }

  async reservation(portfolio: Address, pool: Address, marketNonce: bigint, orderId: bigint) {
    const key = orderKey(pool, marketNonce, orderId);
    const r = (await this.pub.readContract({
      address: portfolio as ViemAddress,
      abi: airspacePortfolioAbi,
      functionName: "orderRec",
      args: [key],
    })) as readonly [Address, MarketId, Address, bigint, bigint, number, bigint, bigint];
    return {
      key,
      agent: r[0],
      marketId: r[1],
      pool: r[2],
      marketNonce: r[3],
      orderId: r[4],
      kind: r[5],
      qtyOpen: r[6],
      collReserved: r[7],
      open: r[6] > 0n,
    };
  }

  // ------------------------------------------------------------- admission

  /**
   * Ask the portfolio contract what it would decide, without sending anything.
   * ADVISORY: state can change between preview and execution, and the contract
   * re-evaluates at execution time. This returns the contract's own decision.
   */
  async simulateAdmission(portfolio: Address, agent: Address, intent: Intent): Promise<AdmissionView> {
    const v = (await this.pub.readContract({
      address: portfolio as ViemAddress,
      abi: airspacePortfolioAbi,
      functionName: "previewIntent",
      args: [agent as ViemAddress, intentToTuple(intent)],
    })) as {
      refusal: number;
      gates: number;
      domain: Hex;
      cadenceSec: number;
      pool: Address;
      expiry: bigint;
      reserveRequired: bigint;
      marketDirectionalBefore: bigint;
      marketDirectionalAfter: bigint;
      domainUsageBefore: bigint;
      domainUsageAfter: bigint;
      domainCeiling: bigint;
      committedAfter: bigint;
      globalCommittedCeiling: bigint;
      agentCommittedAfter: bigint;
      agentCommittedCeiling: bigint;
    };
    return { ...v, refusal: v.refusal as Refusal, domain: v.domain as DomainId };
  }

  async submitIntent(portfolio: Address, intent: Intent, account?: Account | Address) {
    const w = this.requireWallet();
    const { request } = await this.pub.simulateContract({
      address: portfolio as ViemAddress,
      abi: airspacePortfolioAbi,
      functionName: "execute",
      args: [intentToTuple(intent)],
      account: (account ?? w.account) as Account,
    });
    return w.writeContract(request);
  }

  // ------------------------------------------------------------ owner ops

  private async ownerWrite(
    portfolio: Address,
    functionName: WriteFn,
    args: readonly unknown[],
    account?: Account | Address,
  ) {
    const w = this.requireWallet();
    const { request } = await this.pub.simulateContract({
      address: portfolio as ViemAddress,
      abi: airspacePortfolioAbi,
      functionName,
      args: args as never,
      account: (account ?? w.account) as Account,
    });
    return w.writeContract(request);
  }

  setGlobalPolicy = (p: Address, policy: GlobalPolicy, a?: Account | Address) =>
    this.ownerWrite(p, "setGlobalPolicy", [globalPolicyToTuple(policy)], a);

  setDomainPolicy = (p: Address, domain: DomainId, policy: DomainPolicy, a?: Account | Address) =>
    this.ownerWrite(p, "setDomainPolicy", [domain, domainPolicyToTuple(policy)], a);

  registerAgent = (p: Address, agent: Address, policy: AgentPolicy, a?: Account | Address) =>
    this.ownerWrite(p, "setAgent", [agent, agentPolicyToTuple(policy)], a);

  revokeAgent = (p: Address, agent: Address, a?: Account | Address) =>
    this.ownerWrite(p, "revokeAgent", [agent], a);

  fund = (p: Address, amount: bigint, a?: Account | Address) => this.ownerWrite(p, "fund", [amount], a);

  withdraw = (p: Address, token: Address, to: Address, amount: bigint, a?: Account | Address) =>
    this.ownerWrite(p, "withdraw", [token, to, amount], a);

  withdrawOutcome = (p: Address, id: bigint, to: Address, amount: bigint, a?: Account | Address) =>
    this.ownerWrite(p, "withdrawOutcome", [id, to, amount], a);

  cancelOrder = (p: Address, pool: Address, orderId: bigint, a?: Account | Address) =>
    this.ownerWrite(p, "cancelOrder", [pool, orderId], a);

  redeem = (
    p: Address,
    args: { operatorId: number; venueId: Hex; marketId: MarketId; outcomeIdx: number; amount: bigint },
    a?: Account | Address,
  ) => this.ownerWrite(p, "redeem", [args.operatorId, args.venueId, args.marketId, args.outcomeIdx, args.amount], a);

  // ------------------------------------------------------------ lifecycle
  // Permissionless: the chain supplies every number, the caller supplies none.

  releaseOrder = (p: Address, key: Hex, a?: Account | Address) => this.ownerWrite(p, "releaseOrder", [key], a);
  releaseSettled = (p: Address, marketId: MarketId, a?: Account | Address) =>
    this.ownerWrite(p, "releaseSettled", [marketId], a);
  pruneMarket = (p: Address, marketId: MarketId, a?: Account | Address) =>
    this.ownerWrite(p, "pruneMarket", [marketId], a);

  // ---------------------------------------------------------------- market

  readMarket = (marketId: MarketId) => readMarket(this.pub, marketId);
  readLiveState = (m: Market) => readLiveState(this.pub, m);
  discoverMarkets = (opts?: Parameters<typeof discoverMarkets>[1]) => discoverMarkets(this.pub, opts);
  domainKey = domainKey;
}

// ---------------------------------------------------------------------------
// Intent construction
// ---------------------------------------------------------------------------

export interface BuildIntentArgs {
  market: Market;
  kind: Intent["kind"];
  price: bigint;
  quantity: bigint;
  nonce: bigint;
  orderType?: Intent["orderType"];
  strategyVersion?: Hex;
  /** Order expiry, capped at the market's own. Defaults to the market cap. */
  expireTimestampNs?: bigint;
}

/**
 * Build an intent bound to the market's CURRENT generation.
 *
 * The generation is taken from the market read, never assumed: pools are
 * recycled across markets, so a pool address alone is not a market identity and
 * a stale generation is refused on-chain.
 */
export function buildIntent(a: BuildIntentArgs & { marketExpiryNs: bigint }): Intent {
  return {
    marketId: a.market.marketId,
    pool: a.market.pool,
    marketNonce: a.market.marketNonce,
    kind: a.kind,
    price: a.price,
    quantity: a.quantity,
    expireTimestampNs: a.expireTimestampNs ?? a.marketExpiryNs,
    orderType: a.orderType ?? 3,
    nonce: a.nonce,
    strategyVersion: a.strategyVersion ?? ("0x" + "00".repeat(32)) as Hex,
  };
}

/** `keccak256(pool, marketNonce, orderId)` — the generation is part of the key. */
export function orderKey(pool: Address, marketNonce: bigint, orderId: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint128" }], [pool, marketNonce, orderId]),
  );
}

export function intentHash(portfolio: Address, chainId: number, agent: Address, i: Intent): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        {
          type: "tuple",
          components: [
            { type: "bytes32" },
            { type: "address" },
            { type: "uint64" },
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint64" },
            { type: "uint8" },
            { type: "uint64" },
            { type: "bytes32" },
          ],
        },
      ],
      [portfolio, BigInt(chainId), agent, intentToTuple(i) as never],
    ),
  );
}

export const estimateReserve = reserveFor;

// ---------------------------------------------------------------------------
// Tuple encoders — field order is ABI-critical
// ---------------------------------------------------------------------------

export const intentToTuple = (i: Intent) =>
  ({
    marketId: i.marketId,
    pool: i.pool,
    marketNonce: i.marketNonce,
    kind: i.kind,
    price: i.price,
    quantity: i.quantity,
    expireTimestampNs: i.expireTimestampNs,
    orderType: i.orderType,
    nonce: i.nonce,
    strategyVersion: i.strategyVersion,
  }) as const;

export const globalPolicyToTuple = (p: GlobalPolicy) =>
  ({
    maxCommittedCapital: p.maxCommittedCapital,
    maxReservedCollateral: p.maxReservedCollateral,
    maxSingleOrderNotional: p.maxSingleOrderNotional,
    maxBuyPrice: p.maxBuyPrice,
    minSellPrice: p.minSellPrice,
    minHeadroomSec: p.minHeadroomSec,
    policyExpiry: p.policyExpiry,
  }) as const;

export const domainPolicyToTuple = (p: DomainPolicy) =>
  ({
    configured: p.configured,
    maxDomainRiskUsage: p.maxDomainRiskUsage,
    maxDomainCommitted: p.maxDomainCommitted,
    maxLiveMarkets: p.maxLiveMarkets,
  }) as const;

export const agentPolicyToTuple = (p: AgentPolicy) =>
  ({
    enabled: p.enabled,
    maxCommitted: p.maxCommitted,
    maxOrderNotional: p.maxOrderNotional,
    maxBuyPrice: p.maxBuyPrice,
    minSellPrice: p.minSellPrice,
    cooldownSec: p.cooldownSec,
    strategyId: p.strategyId,
  }) as const;

export { DREAMDEX, network };
