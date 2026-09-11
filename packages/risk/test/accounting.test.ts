import { describe, expect, it } from "vitest";
import {
  abs,
  committedCapital,
  domainRiskUsage,
  explainAdmission,
  formatContracts,
  formatProbability,
  formatUnits,
  marketDirectionalExposure,
  marketExposureBounds,
  marketWorstCaseExposure,
  maximumLoss,
  onLot,
  onTick,
  parseUnits,
  quantizeDown,
  reserveFor,
  type MarketPosition,
} from "../src/index.js";
import { Gate, Refusal, type AdmissionView } from "@airspace/types";

const ONE = 1_000_000n;
const mk = (p: Partial<MarketPosition>): MarketPosition => ({
  marketId: "0x01",
  yesBalance: 0n,
  noBalance: 0n,
  yesLong: 0n,
  yesShort: 0n,
  noLong: 0n,
  noShort: 0n,
  settled: false,
  ...p,
});

describe("directional exposure (realized only, mirrors the contract getter of the same name)", () => {
  it("a complete YES+NO set carries zero directional risk", () => {
    // Within a market, YES and NO are complementary fixed payouts, so a
    // matched pair is worth exactly one collateral unit either way.
    expect(marketDirectionalExposure(mk({ yesBalance: 100n, noBalance: 100n }))).toBe(0n);
  });

  it("derives from the realized YES/NO imbalance", () => {
    expect(marketDirectionalExposure(mk({ yesBalance: 150n, noBalance: 100n }))).toBe(50n);
    expect(marketDirectionalExposure(mk({ yesBalance: 100n, noBalance: 150n }))).toBe(-50n);
  });

  it("ignores unfilled reservations entirely — they are not realized", () => {
    expect(marketDirectionalExposure(mk({ yesBalance: 20n, yesLong: 80n, noShort: 40n }))).toBe(20n);
  });

  it("a settled market is a fixed claim, not a bet", () => {
    expect(marketDirectionalExposure(mk({ yesBalance: 100n, settled: true }))).toBe(0n);
  });
});

describe("exposure bounds and worst case (this is what admission gates on)", () => {
  it("a resting BUY widens the bound on its own side", () => {
    expect(marketExposureBounds(mk({ yesLong: 80n }))).toEqual({ up: 80n, dn: 0n });
    expect(marketExposureBounds(mk({ noLong: 60n }))).toEqual({ up: 0n, dn: -60n });
  });

  it("a resting SELL widens the SAME bound as a buy of that side, not the opposite one", () => {
    // Its tokens are already escrowed — verified live, where a pool's outcome
    // balance equalled its resting ask depth exactly — so what it exposes is
    // the escrow returning on cancel, which lands on the upper bound exactly
    // like a BUY_YES fill would.
    expect(marketExposureBounds(mk({ yesBalance: 100n, yesShort: 40n }))).toEqual({ up: 140n, dn: 100n });
  });

  it("opposing pending orders on one market are NEVER netted", () => {
    // The exact shape that made AIRSPACE 1.0.0 unsafe: a pending BUY_YES and a
    // pending BUY_NO can each fill without the other, so the worst case is the
    // LARGER side, not the difference between them.
    const p = mk({ yesLong: 120n, noLong: 90n });
    expect(marketExposureBounds(p)).toEqual({ up: 120n, dn: -90n });
    expect(marketWorstCaseExposure(p)).toBe(120n);
  });

  it("a held complete set plus a one-sided pending order is exposed by exactly that order", () => {
    const p = mk({ yesBalance: 250n, noBalance: 250n, yesLong: 60n });
    expect(marketWorstCaseExposure(p)).toBe(60n);
  });

  it("the historical failure: 1.0.0 reported 80, the corrected model reports the true 1,170", () => {
    // Shannon block 473455000: balYES 70, balNO 620, yesLong 1090, noLong 620.
    const p = mk({ yesBalance: 70n, noBalance: 620n, yesLong: 1090n, noLong: 620n });
    expect(marketWorstCaseExposure(p)).toBe(1170n);
    // The disproven formula, reproduced only to document the gap it left:
    const v1 = abs(p.yesBalance + p.yesLong - p.yesShort - (p.noBalance + p.noLong - p.noShort));
    expect(v1).toBe(80n);
  });

  it("a settled market carries no bound", () => {
    expect(marketWorstCaseExposure(mk({ yesLong: 500n, settled: true }))).toBe(0n);
  });
});

describe("domain risk usage", () => {
  it("sums per-market WORST CASE and never nets across markets", () => {
    // Long one market and short another is not a hedge: they resolve at
    // different times, and the domain does not even prove a shared underlying.
    const usage = domainRiskUsage([mk({ yesBalance: 100n }), mk({ noBalance: 100n })]);
    expect(usage).toBe(200n);
  });

  it("reproduces the canonical refusal arithmetic", () => {
    const a = mk({ yesLong: 180n });
    const b = mk({ yesLong: 240n });
    expect(domainRiskUsage([a, b])).toBe(420n);
    expect(domainRiskUsage([a, b, mk({ yesLong: 150n })])).toBe(570n);
  });
});

describe("reservation arithmetic", () => {
  it("a BUY_YES escrows price x quantity, ceil-rounded like the pool", () => {
    expect(reserveFor(0, 613_000n, 200_000_000n, ONE)).toBe(122_600_000n);
  });

  it("a BUY_NO escrows (1 - price) because NO = 1 - YES", () => {
    expect(reserveFor(2, 600_000n, 1_000_000n, ONE)).toBe(400_000n);
  });

  it("rounds up, never down, so the escrow is never understated", () => {
    expect(reserveFor(0, 1n, 1n, ONE)).toBe(1n);
  });
});

describe("committed capital (collateral not currently free — not a claim about open positions)", () => {
  it("is capital base minus free collateral", () => {
    expect(committedCapital(1000n, 700n)).toBe(300n);
  });
  it("floors at zero rather than going negative", () => {
    expect(committedCapital(1000n, 1200n)).toBe(0n);
  });
  it("floors at zero when profitable sell proceeds exceed the funded base, even with orders still open", () => {
    // This is the documented imprecision: it is a budget reading, not proof
    // nothing is committed. Solvency is separately gated on freeCollateral()
    // read from the token itself, never on this derived figure.
    expect(committedCapital(1000n, 1050n)).toBe(0n);
  });
});

describe("maximum loss", () => {
  it("the complete-set component is guaranteed back", () => {
    // 100 YES + 60 NO for 120: 60 pays out either way, so at most 60 is lost.
    expect(maximumLoss(100n, 60n, 120n)).toBe(60n);
  });
  it("never reports a negative loss", () => {
    expect(maximumLoss(100n, 100n, 50n)).toBe(0n);
  });
});

describe("grid conformance", () => {
  it("rejects off-tick and off-lot values", () => {
    expect(onTick(613_000n, 1000n)).toBe(true);
    expect(onTick(613_001n, 1000n)).toBe(false);
    expect(onLot(200_000_000n, 1000n)).toBe(true);
    expect(onLot(200_000_001n, 1000n)).toBe(false);
  });

  it("quantizes DOWN, so rounding can never breach a ceiling", () => {
    expect(quantizeDown(1999n, 1000n)).toBe(1000n);
    expect(quantizeDown(1000n, 1000n)).toBe(1000n);
  });
});

describe("formatting", () => {
  it("round-trips through integer arithmetic only", () => {
    expect(formatUnits(122_600_000n, 6)).toBe("122.6");
    expect(parseUnits("122.6", 6)).toBe(122_600_000n);
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(formatUnits(-500_000n, 6)).toBe("-0.5");
  });

  it("rejects more precision than the venue has", () => {
    expect(() => parseUnits("1.1234567", 6)).toThrow();
  });

  it("renders a YES price as a probability", () => {
    expect(formatProbability(613_000n, ONE)).toBe("61.3%");
    expect(formatContracts(200_000_000n, ONE)).toBe("200");
  });
});

describe("admission explanation", () => {
  const base: AdmissionView = {
    refusal: Refusal.NONE,
    gates: 0xffff,
    domain: "0xdead",
    cadenceSec: 3600,
    pool: "0x00",
    expiry: 0n,
    reserveRequired: 0n,
    marketDirectionalBefore: 0n,
    marketDirectionalAfter: 0n,
    domainUsageBefore: 420n,
    domainUsageAfter: 570n,
    domainCeiling: 500n,
    committedAfter: 0n,
    globalCommittedCeiling: 0n,
    agentCommittedAfter: 0n,
    agentCommittedCeiling: 0n,
  };

  it("names the portfolio gate as the single blocking one", () => {
    const gatesWithoutDomain = 0xffff & ~Gate.DOMAIN_CAPACITY;
    const e = explainAdmission({ ...base, refusal: Refusal.DOMAIN_RISK_EXCEEDED, gates: gatesWithoutDomain });
    expect(e.admitted).toBe(false);
    expect(e.blockingGate).toBe("portfolio");
    expect(e.gates.filter((g) => g.blocking)).toHaveLength(1);
    expect(e.gates.find((g) => g.key === "portfolio")?.pass).toBe(false);
    // Everything before the blocking gate passed.
    expect(e.gates.find((g) => g.key === "agent")?.pass).toBe(true);
    expect(e.arithmetic).toEqual({ before: 420n, requested: 150n, after: 570n, ceiling: 500n });
  });

  it("carries trader-facing copy rather than a Solidity error name", () => {
    const e = explainAdmission({ ...base, refusal: Refusal.MARKET_GENERATION_MISMATCH });
    expect(e.copy?.title).toBe("Stale market generation");
    expect(e.copy?.detail).toContain("Pools are recycled");
  });

  it("reports an admitted intent with no blocking gate", () => {
    const e = explainAdmission(base);
    expect(e.admitted).toBe(true);
    expect(e.blockingGate).toBeNull();
    expect(e.copy).toBeNull();
  });
});

describe("abs", () => {
  it("handles both signs", () => {
    expect(abs(-5n)).toBe(5n);
    expect(abs(5n)).toBe(5n);
  });
});
