import { contracts, pct } from "../lib/format";

/**
 * The ceiling line — AIRSPACE's signature element.
 *
 * Domain capacity renders as stacked segments attributed to each agent, against
 * ONE hard rule at the configured ceiling. A proposed intent draws past that
 * rule when it would breach it, so `570 > 500` is something you SEE rather than
 * something you read. A generic progress bar has no line you can cross; this is
 * the whole product in one control.
 */

export interface Segment {
  label: string;
  amount: bigint;
  color: string;
}

/** Colours are assigned per agent so a segment is identifiable at a glance. */
export const AGENT_COLORS = ["#918df6", "#2c78fc", "#d6409f", "#ffa600", "#33c758", "#9580ff"];

export function CeilingLine({
  segments,
  ceiling,
  proposed,
  decimals = 6,
  showLegend = true,
}: {
  segments: Segment[];
  ceiling: bigint;
  /** A pending intent, drawn beyond the current usage. */
  proposed?: { amount: bigint; fits: boolean } | undefined;
  decimals?: number | undefined;
  showLegend?: boolean | undefined;
}) {
  const used = segments.reduce((a, s) => a + s.amount, 0n);
  const total = used + (proposed?.amount ?? 0n);

  // Scale so the ceiling always sits at 78% of the track when nothing overshoots,
  // leaving room for an overshoot to be visible rather than clipped.
  const scaleTo = total > ceiling ? total : (ceiling * 100n) / 78n;
  const w = (v: bigint) => (scaleTo === 0n ? 0 : Math.min(100, Number((v * 10000n) / scaleTo) / 100));

  const usedPct = w(used);
  const ceilingPct = w(ceiling);
  const proposedW = proposed ? w(proposed.amount) : 0;

  return (
    <div className="ceiling">
      <div className="ceiling-track">
        <div className="ceiling-fill" style={{ width: `${usedPct}%` }}>
          {segments
            .filter((s) => s.amount > 0n)
            .map((s) => (
              <div
                key={s.label}
                className="ceiling-seg"
                style={{
                  width: used === 0n ? "0%" : `${Number((s.amount * 10000n) / used) / 100}%`,
                  background: s.color,
                }}
                title={`${s.label}: ${contracts(s.amount, decimals)}`}
              />
            ))}
        </div>

        {proposed && proposed.amount > 0n && (
          <div
            className={`ceiling-proposed${proposed.fits ? " fits" : ""}`}
            style={{ left: `${usedPct}%`, width: `${proposedW}%` }}
            title={`Proposed: ${contracts(proposed.amount, decimals)}`}
          />
        )}

        <div
          className="ceiling-line"
          style={{ left: `${ceilingPct}%` }}
          data-label={`ceiling ${contracts(ceiling, decimals)}`}
        />
      </div>

      {showLegend && (
        <div className="ceiling-legend">
          {segments
            .filter((s) => s.amount > 0n)
            .map((s) => (
              <span key={s.label} className="ceiling-key">
                <span className="ceiling-swatch" style={{ background: s.color }} />
                {s.label} <span className="num" style={{ color: "var(--carbon)" }}>{contracts(s.amount, decimals)}</span>
              </span>
            ))}
          {proposed && proposed.amount > 0n && (
            <span className="ceiling-key">
              <span
                className="ceiling-swatch"
                style={{ background: proposed.fits ? "var(--lavender)" : "var(--ember)", opacity: 0.75 }}
              />
              proposed <span className="num" style={{ color: "var(--carbon)" }}>{contracts(proposed.amount, decimals)}</span>
            </span>
          )}
          <span className="ceiling-key dim" style={{ marginLeft: "auto" }}>
            {contracts(used, decimals)} / {contracts(ceiling, decimals)} used
            {ceiling > 0n ? ` · ${pct(used, ceiling).toFixed(0)}%` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
