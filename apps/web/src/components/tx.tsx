import type { TxState } from "../hooks/tx";
import { TxLink } from "./ui";

/** Every terminal and non-terminal state of a write, rendered honestly. */
export function TxStatus({ state, onDismiss }: { state: TxState; onDismiss?: () => void }) {
  if (state.phase === "idle") return null;

  if (state.phase === "signing") {
    return (
      <div className="notice notice-info">
        <span className="spinner" />
        <div>Confirm in your wallet.</div>
      </div>
    );
  }

  if (state.phase === "pending") {
    return (
      <div className="notice notice-info">
        <span className="spinner" />
        <div style={{ flex: 1 }}>
          Waiting for confirmation on Shannon. <TxLink hash={state.hash} />
        </div>
      </div>
    );
  }

  if (state.phase === "confirmed") {
    return (
      <div className="notice notice-info" style={{ borderColor: "rgba(51,199,88,.35)", background: "rgba(51,199,88,.06)" }}>
        <div style={{ flex: 1 }}>
          Confirmed. <TxLink hash={state.hash} />
        </div>
        {onDismiss ? (
          <button className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    );
  }

  if (state.phase === "rejected") {
    return (
      <div className="notice notice-warn">
        <div style={{ flex: 1 }}>{state.message}</div>
        {onDismiss ? (
          <button className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="notice notice-error">
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: "var(--carbon)" }}>
          {state.refusal ? state.refusal.title : "Transaction failed"}
        </div>
        <div className="muted" style={{ marginTop: 2 }}>
          {state.refusal ? state.refusal.detail : state.message}
        </div>
        {state.refusal?.action ? (
          <div className="muted" style={{ marginTop: 6 }}>
            <strong style={{ color: "var(--carbon)" }}>What to do:</strong> {state.refusal.action}
          </div>
        ) : null}
        {state.refusal ? (
          <div className="caption" style={{ marginTop: 6 }}>
            Refusal code {state.refusal.code} · {state.refusal.name}
          </div>
        ) : null}
        {state.hash ? (
          <div style={{ marginTop: 6 }}>
            <TxLink hash={state.hash} />
          </div>
        ) : null}
      </div>
      {onDismiss ? (
        <button className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
