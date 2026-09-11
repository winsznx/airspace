import { describe, expect, it } from "vitest";
import { blockedKeys, jobKey, type JobRow } from "./planning.js";

const NOW = Date.parse("2026-09-19T20:00:00Z");
const MIN = 60_000;
const row = (over: Partial<JobRow>): JobRow => ({
  kind: "release-order",
  order_key: "0xaa",
  market_id: null,
  status: "PENDING",
  updated_at: new Date(NOW - 5 * MIN).toISOString(),
  ...over,
});

describe("jobKey", () => {
  it("distinguishes kind, order and market, and treats null and absent alike", () => {
    expect(jobKey("release-order", "0xaa", null)).toBe(jobKey("release-order", "0xaa", undefined));
    expect(jobKey("release-order", "0xaa")).not.toBe(jobKey("release-order", "0xbb"));
    expect(jobKey("release-settled", null, "0x01")).not.toBe(jobKey("prune-market", null, "0x01"));
  });
});

describe("blockedKeys", () => {
  const cooldowns = { doneMs: 6 * 60 * MIN, failedMs: 30 * MIN };

  it("blocks a job still in flight no matter how old it is", () => {
    const old = row({ status: "PENDING", updated_at: new Date(NOW - 5 * 60 * MIN).toISOString() });
    expect(blockedKeys([old], NOW, cooldowns).has(jobKey("release-order", "0xaa"))).toBe(true);
    const running = row({ status: "RUNNING", updated_at: new Date(NOW - 5 * 60 * MIN).toISOString() });
    expect(blockedKeys([running], NOW, cooldowns).has(jobKey("release-order", "0xaa"))).toBe(true);
  });

  it("blocks a finished job for hours, so a stuck projection row cannot be re-queued every minute", () => {
    const recent = row({ status: "DONE", updated_at: new Date(NOW - 5 * 60 * MIN).toISOString() });
    const expired = row({ status: "DONE", updated_at: new Date(NOW - 7 * 60 * MIN).toISOString() });
    expect(blockedKeys([recent], NOW, cooldowns).size).toBe(1);
    expect(blockedKeys([expired], NOW, cooldowns).size).toBe(0);
  });

  it("lets a failed job retry after a short cooldown", () => {
    const recent = row({ status: "FAILED", updated_at: new Date(NOW - 10 * MIN).toISOString() });
    const expired = row({ status: "FAILED", updated_at: new Date(NOW - 40 * MIN).toISOString() });
    expect(blockedKeys([recent], NOW, cooldowns).size).toBe(1);
    expect(blockedKeys([expired], NOW, cooldowns).size).toBe(0);
  });

  it("does not let one order's job block another's", () => {
    const blocked = blockedKeys([row({ order_key: "0xaa" })], NOW, cooldowns);
    expect(blocked.has(jobKey("release-order", "0xbb"))).toBe(false);
  });
});
