import { formatUnits } from "@airspace/risk";

/**
 * Display helpers. Every value arrives as a bigint or a decimal string and is
 * converted here, once, at the presentation edge. Nothing upstream of this file
 * uses a float for a protocol quantity.
 */

/** Contracts are quoted in collateral-scale units: 1e6 == one contract at 6dp. */
export const contracts = (raw: bigint | string, decimals = 6): string => {
  const v = typeof raw === "string" ? BigInt(raw || "0") : raw;
  const s = formatUnits(v < 0n ? -v : v, decimals, 2);
  return (v < 0n ? "-" : "") + s;
};

export const collateral = (raw: bigint | string, decimals = 6): string => {
  const v = typeof raw === "string" ? BigInt(raw || "0") : raw;
  return formatUnits(v, decimals, 2);
};

/** A YES-side price shown as a probability. */
export const probability = (raw: bigint | string, one = 1_000_000n): string => {
  const v = typeof raw === "string" ? BigInt(raw || "0") : raw;
  return `${formatUnits((v * 10000n) / one, 2, 1)}%`;
};

export const pct = (part: bigint | string, whole: bigint | string): number => {
  const a = typeof part === "string" ? BigInt(part || "0") : part;
  const b = typeof whole === "string" ? BigInt(whole || "0") : whole;
  if (b === 0n) return 0;
  return Number((a * 10000n) / b) / 100;
};

export const shortAddress = (a?: string): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const shortHash = (h?: string): string => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

/**
 * DreamDEX market ids are sequential integers left-padded to bytes32, so the
 * first 26 characters of every one of them are zeros. Truncating the front the
 * way we truncate a hash would render every market identically, which is worse
 * than useless. Show the number instead when it is genuinely small.
 */
export function marketLabel(id?: string): string {
  if (!id) return "—";
  try {
    const n = BigInt(id);
    if (n > 0n && n < 1_000_000_000n) return `#${n.toString()}`;
  } catch {
    /* not a hex quantity; fall through to the hash form */
  }
  return shortHash(id);
}

export const CADENCE_LABEL: Record<number, string> = {
  60: "1m",
  300: "5m",
  900: "15m",
  1800: "30m",
  3600: "1h",
  14400: "4h",
  86400: "24h",
};
export const cadenceLabel = (s: number): string => CADENCE_LABEL[s] ?? (s > 0 ? `${s}s` : "unclassified");

export function countdown(seconds: number): string {
  if (seconds <= 0) return "expired";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function timeAgo(iso?: string | number | null): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
