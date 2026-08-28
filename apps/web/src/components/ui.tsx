import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { explorerAddress, explorerTx } from "../lib/chain";
import { shortAddress, shortHash } from "../lib/format";

export function Card({ children, className = "", lg = false }: { children: ReactNode; className?: string; lg?: boolean }) {
  return <div className={`card${lg ? " card-lg" : ""} ${className}`}>{children}</div>;
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode | undefined;
  tone?: "mint" | "ember" | "amber" | undefined;
}) {
  const color = tone === "mint" ? "var(--mint)" : tone === "ember" ? "var(--ember)" : tone === "amber" ? "var(--amber)" : undefined;
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value num" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "pass" | "fail" | "accent" | "warn" | "neutral" }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function Notice({
  kind = "info",
  title,
  children,
  action,
}: {
  kind?: "info" | "warn" | "error" | undefined;
  title: string;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className={`notice notice-${kind}`}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: "var(--carbon)" }}>{title}</div>
        {children ? <div className="muted" style={{ marginTop: 2 }}>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode | undefined; action?: ReactNode | undefined }) {
  return (
    <div className="empty">
      <div style={{ fontWeight: 500, fontSize: 18, letterSpacing: "-0.32px" }}>{title}</div>
      {children ? <p className="muted" style={{ marginTop: 8, maxWidth: 460, marginInline: "auto" }}>{children}</p> : null}
      {action ? <div style={{ marginTop: 20 }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ h = 20, w = "100%" }: { h?: number; w?: string | number }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden />;
}

export function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={i === 0 ? 14 : 22} w={i === 0 ? "40%" : "100%"} />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: (() => void) | undefined }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Notice
      kind="error"
      title="Could not load this"
      action={
        retry ? (
          <button className="btn btn-outline btn-sm" onClick={retry}>
            Try again
          </button>
        ) : undefined
      }
    >
      {msg}
    </Notice>
  );
}

export function Freshness({ fetchedAt, stale }: { fetchedAt?: number | undefined; stale?: { since: number; reason: string } | undefined }) {
  if (stale) {
    return (
      <span className="freshness freshness-stale" title={`Last good read ${new Date(stale.since).toLocaleTimeString()}`}>
        <span className="dot" /> Delayed — showing last known state
      </span>
    );
  }
  if (!fetchedAt) return <span className="freshness dim"><span className="dot" /> Connecting</span>;
  return (
    <span className="freshness freshness-live">
      <span className="dot" /> Live
    </span>
  );
}

export function AddressLink({ address, label }: { address?: string | undefined; label?: string | undefined }) {
  if (!address) return <span className="dim">—</span>;
  return (
    <a className="hash" href={explorerAddress(address)} target="_blank" rel="noreferrer" title={address}>
      {label ?? shortAddress(address)}
    </a>
  );
}

export function TxLink({ hash, label }: { hash?: string | null | undefined; label?: string | undefined }) {
  if (!hash) return <span className="dim">—</span>;
  return (
    <a className="hash" href={explorerTx(hash)} target="_blank" rel="noreferrer" title={hash}>
      {label ?? shortHash(hash)}
    </a>
  );
}

export function Copyable({ value, display }: { value: string; display?: string | undefined }) {
  return (
    <button
      className="hash"
      style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
      title="Copy"
      onClick={() => void navigator.clipboard?.writeText(value)}
    >
      {display ?? shortHash(value)}
    </button>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="table-wrap">
      <div className="table-scroll">{children}</div>
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="row-between" style={{ padding: "12px 4px" }}>
      <span className="caption">
        {from}–{to} of {total}
      </span>
      <div className="row">
        <button className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button className="btn btn-ghost btn-sm" disabled={to >= total} onClick={() => onChange(offset + limit)}>
          Next
        </button>
      </div>
    </div>
  );
}

/** Buttons inside a table cell: never wrap onto two lines mid-word. */
export function TableActions({ children }: { children: ReactNode }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
      {children}
    </div>
  );
}

export function NavLinkTab({ to, children, active }: { to: string; children: ReactNode; active: boolean }) {
  return (
    <Link to={to} className={`tab${active ? " tab-active" : ""}`}>
      {children}
    </Link>
  );
}
