import { describe, expect, it } from "vitest";
import { encodeEventTopics, type Log, type PublicClient } from "viem";
import { airspacePortfolioAbi } from "@airspace/sdk";
import {
  agentsFromEvents,
  configuredDomainsFromEvents,
  intentsFromEvents,
  receiptsFromEvents,
  reservationsFromEvents,
  toStoredEvent,
  trackedMarketsFromEvents,
  type RefusalRecord,
  type StoredEvent,
} from "./portfolio-log.js";
import { mapLimit } from "./portfolio-live.js";
import { scanPortfolioLogs } from "./rpc.js";

// The numbers below are a real order placed on Shannon: Momentum's 70-contract
// BUY YES on market 0x…1a927, later released by a permissionless releaseOrder.
const POOL = "0xC09e4a5bDee2899962727125fB5eaEB896798e46";
const AGENT = "0x7273dE585311a5139Ef83f0F6Dbb29F3e57b3389";
const MARKET = "0x000000000000000000000000000000000000000000000000000000000001a927";
const DOMAIN = "0x8cd7b896145e4ddab4d54284b6abde1e070094eda1696dc681934d76dd12afbe";
const INTENT = "0x42deca2e7d081942cc316c131ff904e4914f13626abaa7add78cdf04f17cbc90";
const RESTING_ORDER = "0x66ee649f582fef5c9e9b63bc061df9e2dd57ee0a9aa91ddd137a65a1d31967e6";

const ev = (block: number, logIndex: number, name: string, args: Record<string, unknown>, ts = 1_000 + block): StoredEvent => ({
  block: String(block),
  logIndex,
  tx: `0x${block.toString(16).padStart(64, "0")}`,
  ts,
  name,
  args,
});

const admitted = ev(485889662, 3, "IntentAdmitted", {
  intentHash: INTENT,
  marketId: MARKET,
  agent: AGENT,
  domain: DOMAIN,
  pool: POOL,
  marketNonce: "119",
  kind: 0,
  price: "295000",
  quantity: "70000000",
  orderId: "18446744073709905293",
  strategyVersion: `0x${"00".repeat(32)}`,
});

const reconciled = ev(485889662, 4, "IntentReconciled", {
  intentHash: INTENT,
  reserveRequired: "20650000",
  filledQty: "0",
  filledCost: "0",
  restingQty: "70000000",
  directionalBefore: "0",
  directionalAfter: "0",
  domainUsageBefore: "0",
  domainUsageAfter: "70000000",
  committedAfter: "20650000",
});

const released = ev(485894407, 1, "ReservationReleased", {
  orderKey: RESTING_ORDER,
  marketId: MARKET,
  qtyReleased: "70000000",
  collateralReleased: "20650000",
});

describe("toStoredEvent", () => {
  it("decodes a raw log against the portfolio ABI and stringifies bigints", () => {
    const topics = encodeEventTopics({ abi: airspacePortfolioAbi, eventName: "AgentRevoked", args: { agent: AGENT } });
    const log = { blockNumber: 12n, logIndex: 2, transactionHash: `0x${"ab".repeat(32)}`, data: "0x", topics } as unknown as Log;
    const e = toStoredEvent(log, 99);
    expect(e).toMatchObject({ block: "12", logIndex: 2, ts: 99, name: "AgentRevoked" });
    expect((e!.args.agent as string).toLowerCase()).toBe(AGENT.toLowerCase());
  });

  it("drops a log the ABI does not know rather than throwing", () => {
    const log = { blockNumber: 1n, logIndex: 0, transactionHash: `0x${"cd".repeat(32)}`, data: "0x", topics: [`0x${"11".repeat(32)}`] } as unknown as Log;
    expect(toStoredEvent(log, 1)).toBeNull();
  });

  it("drops a pending log with no block position", () => {
    const log = { blockNumber: null, logIndex: null, transactionHash: null, data: "0x", topics: [] } as unknown as Log;
    expect(toStoredEvent(log, 1)).toBeNull();
  });
});

describe("agentsFromEvents", () => {
  it("keeps every registered address and lets the latest registration win", () => {
    const first = ev(10, 0, "AgentSet", { agent: AGENT, enabled: true, policy: { strategyId: "0xaaa" } });
    const again = ev(20, 0, "AgentSet", { agent: AGENT, enabled: true, policy: { strategyId: "0xbbb" } });
    const other = ev(15, 0, "AgentSet", { agent: "0x51F19F71e9d073AAB39f6fd003F424984390E5A0", enabled: true, policy: { strategyId: "0x0" } });
    const agents = agentsFromEvents([again, other, first]);
    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.address === AGENT)).toMatchObject({ strategyId: "0xbbb", registeredBlock: "20" });
  });
});

describe("configuredDomainsFromEvents", () => {
  it("returns only domains whose latest policy is configured", () => {
    const events = [
      ev(1, 0, "DomainPolicySet", { domain: "0xd1", policy: { configured: true } }),
      ev(2, 0, "DomainPolicySet", { domain: "0xd2", policy: { configured: true } }),
      ev(3, 0, "DomainPolicySet", { domain: "0xd2", policy: { configured: false } }),
    ];
    expect(configuredDomainsFromEvents(events)).toEqual(["0xd1"]);
  });
});

describe("intents and receipts", () => {
  const refusal: RefusalRecord = {
    intentHash: `0x${"ee".repeat(32)}`,
    agent: AGENT,
    marketId: MARKET,
    pool: POOL,
    marketNonce: "119",
    kind: 0,
    orderType: 3,
    price: "550000",
    quantity: "200000000",
    agentNonce: "3",
    refusal: 22,
    tx: `0x${"ff".repeat(32)}`,
    block: "485900000",
    ts: 5_000,
  };

  it("lists newest first, merges recovered refusals, and keeps exact integers", () => {
    const rows = intentsFromEvents([admitted, reconciled], [refusal]);
    expect(rows.map((r) => r.status)).toEqual(["REFUSED", "ADMITTED"]);
    expect(rows[1]).toMatchObject({
      intent_hash: INTENT,
      agent_address: AGENT.toLowerCase(),
      price: "295000",
      quantity: "70000000",
      order_id: "18446744073709905293",
      order_type: 3,
      pool_address: POOL.toLowerCase(),
    });
    expect(rows[0]).toMatchObject({ refusal_code: 22, order_id: null });
  });

  it("builds an admitted receipt from IntentReconciled joined to its IntentAdmitted", () => {
    const [r] = receiptsFromEvents([admitted, reconciled], []);
    expect(r).toMatchObject({
      decision: "ADMITTED",
      agent_address: AGENT.toLowerCase(),
      market_id: MARKET,
      domain_hash: DOMAIN,
      resting_qty: "70000000",
      domain_usage_after: "70000000",
      committed_after: "20650000",
    });
    expect(r!.provenance.decision).toBe("contract");
  });

  it("builds a refused receipt with no fabricated fills", () => {
    const [r] = receiptsFromEvents([], [refusal]);
    expect(r).toMatchObject({ decision: "REFUSED", refusal_code: 22, filled_qty: null, resting_qty: null });
  });
});

describe("reservationsFromEvents", () => {
  it("derives the contract's own order key and open quantity from the events", () => {
    const [r] = reservationsFromEvents([admitted, reconciled]);
    expect(r).toMatchObject({
      order_key: RESTING_ORDER,
      qty_open: 70_000_000n,
      collateral_reserved: 20_650_000n,
      kind: 0,
      market_nonce: 119,
    });
  });

  it("reduces the open quantity by every release that names its key, in any arrival order", () => {
    const [r] = reservationsFromEvents([released, reconciled, admitted]);
    expect(r).toMatchObject({ qty_open: 0n, collateral_reserved: 0n, source_block: 485894407 });
  });

  it("supports a partial release", () => {
    const partial = ev(485894407, 1, "ReservationReleased", { orderKey: RESTING_ORDER, marketId: MARKET, qtyReleased: "20000000", collateralReleased: "5000000" });
    const [r] = reservationsFromEvents([admitted, reconciled, partial]);
    expect(r).toMatchObject({ qty_open: 50_000_000n, collateral_reserved: 15_650_000n });
  });

  it("records no reservation for an order that filled completely", () => {
    const filled = { ...reconciled, args: { ...reconciled.args, restingQty: "0", filledQty: "70000000" } };
    expect(reservationsFromEvents([admitted, filled])).toEqual([]);
  });
});

describe("trackedMarketsFromEvents", () => {
  const tracked = ev(100, 0, "MarketTracked", { marketId: MARKET, domain: DOMAIN, pool: POOL, marketNonce: "119" });

  it("tracks a market, flags redemption, and orders by latest activity", () => {
    const later = ev(300, 0, "Redeemed", { marketId: MARKET, outcomeIdx: 1, amount: "5" });
    const m = ev(200, 0, "MarketTracked", { marketId: `0x${"22".repeat(32)}`, domain: DOMAIN, pool: POOL, marketNonce: "1" });
    const rows = trackedMarketsFromEvents([tracked, m, later]);
    expect(rows.map((r) => r.market_id)).toEqual([MARKET, `0x${"22".repeat(32)}`]);
    expect(rows[0]).toMatchObject({ redeemed: true, source_block: 300 });
  });

  it("drops a pruned market", () => {
    const pruned = ev(150, 0, "MarketPruned", { marketId: MARKET, domain: DOMAIN });
    expect(trackedMarketsFromEvents([tracked, pruned])).toEqual([]);
  });
});

describe("mapLimit", () => {
  it("preserves order and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("scanPortfolioLogs", () => {
  const client = (head: bigint, failFrom: bigint | null) =>
    ({
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (failFrom !== null && fromBlock === failFrom) throw new Error("rpc down");
        return [{ blockNumber: fromBlock, logIndex: 0 } as unknown as Log];
      },
    }) as unknown as PublicClient;

  it("scans to the head in 1000-block windows and reports completion", async () => {
    const r = await scanPortfolioLogs(client(2_999n, null), POOL, 0n);
    expect(r.complete).toBe(true);
    expect(r.scannedThrough).toBe(2_999n);
    expect(r.logs).toHaveLength(3);
  });

  it("never advances past a window that failed, so the next scan retries it", async () => {
    const r = await scanPortfolioLogs(client(4_999n, 2_000n), POOL, 0n);
    expect(r.complete).toBe(false);
    expect(r.scannedThrough).toBe(1_999n);
    expect(r.logs).toHaveLength(2);
  });

  it("is complete immediately when already at the head", async () => {
    const r = await scanPortfolioLogs(client(100n, null), POOL, 500n);
    expect(r).toMatchObject({ complete: true, logs: [] });
  });
});
