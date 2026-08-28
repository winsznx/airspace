import { Link } from "react-router-dom";
import { CeilingLine, AGENT_COLORS } from "../components/ceiling";
import { GateStack } from "../components/gates";
import { Tag } from "../components/ui";

const K = 1_000_000n;

/**
 * Landing.
 *
 * The hero IS the mechanism: the ceiling line with three agents' contributions
 * and a third intent drawn past the rule. Someone who has never heard of
 * AIRSPACE should understand the problem before they finish reading the
 * headline.
 */
export function Landing() {
  const segments = [
    { label: "Momentum agent", amount: 180n * K, color: AGENT_COLORS[0]! },
    { label: "Oracle agent", amount: 240n * K, color: AGENT_COLORS[1]! },
  ];

  const gates = [
    { key: "agent", label: "Agent policy", pass: true, blocking: false },
    { key: "market", label: "Market trading", pass: true, blocking: false },
    { key: "generation", label: "Market generation", pass: true, blocking: false },
    { key: "grid", label: "Tick / lot", pass: true, blocking: false },
    { key: "price", label: "Price ceiling", pass: true, blocking: false },
    { key: "headroom", label: "Market headroom", pass: true, blocking: false },
    { key: "portfolio", label: "Portfolio domain", pass: false, blocking: true },
  ];

  return (
    <main>
      {/* ---------------------------------------------------------- hero */}
      <section className="page" style={{ paddingBlock: "72px 56px" }}>
        <div style={{ maxWidth: 780 }}>
          <span className="tag tag-accent" style={{ marginBottom: 20 }}>
            Live on Somnia Shannon · DreamDEX Event Contracts
          </span>
          <h1 className="display" style={{ marginTop: 16 }}>
            Your agents can each follow the rules and still break your portfolio.
          </h1>
          <p className="muted" style={{ fontSize: 18, marginTop: 20, maxWidth: 620 }}>
            AIRSPACE lets independent DreamDEX trading agents share one capital pool while
            enforcing one portfolio-wide risk envelope across all of them. A trade can be
            rejected purely because of what the other agents already hold.
          </p>
          <div className="row" style={{ marginTop: 28, gap: 12 }}>
            <Link className="btn btn-primary" to="/app">
              Open the control room
            </Link>
            <a className="btn btn-ghost" href="#mechanism">
              See how it works
            </a>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------- the ceiling line */}
      <section className="band">
        <div className="page section" id="mechanism">
          <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.15fr) minmax(0,1fr)", gap: 40 }}>
            <div className="stack" style={{ gap: 24 }}>
              <div>
                <div className="caption">15-minute tUSDC risk domain</div>
                <h2 style={{ marginTop: 6 }}>Three agents. One ceiling.</h2>
              </div>

              <div className="panel">
                <CeilingLine
                  segments={segments}
                  ceiling={500n * K}
                  proposed={{ amount: 150n * K, fits: false }}
                />
                <hr className="divider" style={{ margin: "24px 0 16px" }} />
                <div className="equation" style={{ fontSize: 16 }}>
                  <span>180</span>
                  <span className="dim">+</span>
                  <span>240</span>
                  <span className="dim">+</span>
                  <span>150</span>
                  <span className="dim">=</span>
                  <strong>570</strong>
                  <span className="dim">&gt;</span>
                  <strong>500</strong>
                </div>
                <p className="caption" style={{ marginTop: 10 }}>
                  The third intent is refused. Not because it is too large, but because
                  the first two already used the room.
                </p>
              </div>
            </div>

            <div className="stack" style={{ gap: 16 }}>
              <div>
                <div className="caption">Mean-reversion agent · 150 contracts</div>
                <h3 style={{ marginTop: 6 }}>Every check it controls passes.</h3>
              </div>
              <GateStack gates={gates} />
              <div className="notice notice-error">
                <div>
                  <div style={{ fontWeight: 500, color: "var(--carbon)" }}>
                    Blocked by portfolio risk
                  </div>
                  <div className="muted" style={{ marginTop: 2 }}>
                    This order is valid on its own. Combined with what other agents already
                    hold and have reserved, it would push the domain over its ceiling.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ what it is */}
      <section className="page section">
        <div className="grid grid-3">
          {[
            {
              t: "Reservations count before they fill",
              d: "A resting order carries the risk it will create when it fills, so it occupies the envelope from the moment it is admitted. Several agents cannot quietly queue up orders that only breach the limit later.",
            },
            {
              t: "No per-market setup, ever",
              d: "Risk domains are derived on-chain from the market's creator, collateral and canonical cadence. A market minted one second ago enters the right domain with no configuration and no owner transaction.",
            },
            {
              t: "The owner can always get out",
              d: "Withdrawal reads no policy, no agent state, no market state and no keeper. It works with every agent revoked, the policy expired and the backend offline.",
            },
          ].map((f) => (
            <div key={f.t} className="stack" style={{ gap: 10 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "var(--lavender)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>
                  {f.t.charAt(0)}
                </span>
              </div>
              <h3>{f.t}</h3>
              <p className="muted">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- honest limits */}
      <section className="band">
        <div className="page section">
          <div style={{ maxWidth: 720 }}>
            <h2>What AIRSPACE does not claim</h2>
            <p className="muted" style={{ marginTop: 12 }}>
              The contract enforces a <strong style={{ color: "var(--carbon)" }}>cadence domain</strong>:
              creator, collateral and canonical cadence, all read from the DreamDEX registry
              during execution. It cannot tell BTC from ETH, and it never claims to — sibling
              series of the same cadence deliberately share one ceiling, so switching between
              them does not escape it.
            </p>
            <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
              <Tag tone="neutral">Not an AI trader</Tag>
              <Tag tone="neutral">Not a prediction-market terminal</Tag>
              <Tag tone="neutral">Market risk is not eliminated</Tag>
              <Tag tone="neutral">Unaudited testnet contracts</Tag>
            </div>
          </div>
        </div>
      </section>

      <footer className="page" style={{ paddingBlock: 40, borderTop: "1px solid var(--fog)" }}>
        <div className="row-between">
          <span className="caption">One capital pool. Many trading agents. One shared risk envelope.</span>
          <div className="row">
            <a className="caption" href="https://shannon-explorer.somnia.network" target="_blank" rel="noreferrer">
              Shannon explorer
            </a>
            <Link className="caption" to="/app">
              Open app
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
