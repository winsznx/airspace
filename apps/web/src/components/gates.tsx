import type { GateResult } from "../lib/api";
import { contracts } from "../lib/format";
import { Tag } from "./ui";

/**
 * The gate stack.
 *
 * Pass/fail values come from the CONTRACT's own bitmask via previewIntent, so
 * this is a rendering of the enforced decision, not a second implementation of
 * it. Gates after the blocking one were never evaluated, and are shown as
 * "not reached" rather than as failures — claiming they failed would be untrue.
 */
export function GateStack({ gates }: { gates: GateResult[] }) {
  const blockIdx = gates.findIndex((g) => g.blocking);
  return (
    <div className="gates">
      {gates.map((g, i) => {
        const skipped = blockIdx >= 0 && i > blockIdx;
        return (
          <div key={g.key} className={`gate${g.blocking ? " gate-blocking" : ""}${skipped ? " gate-skipped" : ""}`}>
            <span className="gate-name">{g.label}</span>
            {skipped ? (
              <span className="caption">not reached</span>
            ) : g.pass ? (
              <Tag tone="pass">PASS</Tag>
            ) : (
              <Tag tone="fail">FAIL</Tag>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Verdict({
  admitted,
  copy,
  arithmetic,
  decimals = 6,
}: {
  admitted: boolean;
  copy?: { title: string; detail: string; action: string } | null | undefined;
  arithmetic?: { before: string; requested: string; after: string; ceiling: string } | null | undefined;
  decimals?: number | undefined;
}) {
  return (
    <div className={`verdict ${admitted ? "verdict-admitted" : "verdict-blocked"} stack`}>
      <div className="verdict-title">{admitted ? "Admitted" : "Blocked"}</div>

      {arithmetic && !admitted && (
        <div className="equation">
          <span>{contracts(arithmetic.before, decimals)}</span>
          <span className="dim">already committed</span>
          <span>+</span>
          <span>{contracts(arithmetic.requested, decimals)}</span>
          <span className="dim">requested</span>
          <span>=</span>
          <strong>{contracts(arithmetic.after, decimals)}</strong>
          <span className="dim">&gt;</span>
          <strong>{contracts(arithmetic.ceiling, decimals)}</strong>
          <span className="dim">ceiling</span>
        </div>
      )}

      {arithmetic && admitted && (
        <div className="equation">
          <span>{contracts(arithmetic.before, decimals)}</span>
          <span>+</span>
          <span>{contracts(arithmetic.requested, decimals)}</span>
          <span>=</span>
          <strong>{contracts(arithmetic.after, decimals)}</strong>
          <span className="dim">of</span>
          <strong>{contracts(arithmetic.ceiling, decimals)}</strong>
        </div>
      )}

      {copy && (
        <div className="stack" style={{ gap: 4 }}>
          <div style={{ fontWeight: 500 }}>{copy.title}</div>
          <p className="muted">{copy.detail}</p>
          <p className="caption" style={{ color: "var(--graphite)" }}>
            What you can do: {copy.action}
          </p>
        </div>
      )}
    </div>
  );
}
