import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CeilingLine, AGENT_COLORS } from "../components/ceiling";
import { GateStack } from "../components/gates";
import { Tag } from "../components/ui";
import {
  CrossAgentDiagram,
  IntentPipeline,
  RecoveryDiagram,
  ReservationDiagram,
  RollingMarketsDiagram,
  SharedCapitalDiagram,
} from "../components/diagrams";

const K = 1_000_000n;

/**
 * Landing.
 *
 * The page argues one thing: an order can be correct on its own and still be
 * refused. Each section carries one claim and one diagram that makes the claim
 * legible without reading the prose, so the mechanism does the selling.
 */

function Section({
  eyebrow,
  title,
  lead,
  children,
  band = false,
  id,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  children: ReactNode;
  band?: boolean;
  id?: string;
}) {
  const inner = (
    <div className="page section" {...(id ? { id } : {})}>
      <div className="stack" style={{ gap: 32 }}>
        <div style={{ maxWidth: 680 }}>
          <div className="caption">{eyebrow}</div>
          <h2 style={{ marginTop: 8 }}>{title}</h2>
          <p className="muted" style={{ marginTop: 12, fontSize: 17 }}>
            {lead}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
  return band ? <section className="band">{inner}</section> : <section>{inner}</section>;
}

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
      <section className="page hero">
        <div className="hero-copy">
          <span className="tag tag-accent" style={{ marginBottom: 20 }}>
            Live on Somnia Shannon · DreamDEX Event Contracts
          </span>
          <h1 className="display" style={{ marginTop: 16 }}>
            Your agents can each follow the rules and still break your portfolio.
          </h1>
          <p className="muted" style={{ fontSize: 18, marginTop: 20, maxWidth: 560 }}>
            AIRSPACE lets independent DreamDEX trading agents share one capital pool while enforcing one
            portfolio-wide risk envelope across all of them. A trade can be rejected purely because of what the
            other agents already hold.
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

        <div className="hero-figure">
          <CrossAgentDiagram />
        </div>
      </section>

      {/* ------------------------------------------- the capacity moment */}
      <Section
        band
        id="mechanism"
        eyebrow="15-minute tUSDC risk domain"
        title="Three agents. One ceiling."
        lead="Two agents fill the room. The third is refused — not for being too large, but for being third."
      >
        <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.15fr) minmax(0,1fr)", gap: 40 }}>
          <div className="panel">
            <CeilingLine segments={segments} ceiling={500n * K} proposed={{ amount: 150n * K, fits: false }} />
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
              The third intent is refused. Not because it is too large, but because the first two already used
              the room.
            </p>
          </div>

          <div className="stack" style={{ gap: 16 }}>
            <div>
              <div className="caption">Mean-reversion agent · 150 contracts</div>
              <h3 style={{ marginTop: 6 }}>Every check it controls passes.</h3>
            </div>
            <GateStack gates={gates} />
            <div className="notice notice-error">
              <div>
                <div style={{ fontWeight: 500, color: "var(--carbon)" }}>Blocked by portfolio risk</div>
                <div className="muted" style={{ marginTop: 2 }}>
                  This order is valid on its own. Combined with what other agents already hold and have
                  reserved, it would push the domain over its ceiling.
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ------------------------------------------------- shared capital */}
      <Section
        eyebrow="Capital efficiency"
        title="One capital pool. Many strategies."
        lead="The cautious alternative is three isolated pots of 500. That protects the boundaries and strands the money, and still gives you no view of aggregate risk."
      >
        <figure className="figure figure-scroll">
          <SharedCapitalDiagram />
          <figcaption className="figure-note">
            Every strategy draws on the same base under its own limit, and all of them meet at one
            portfolio-wide envelope. Capital that a quiet strategy is not using is available to a busy one,
            without either of them being able to breach the whole.
          </figcaption>
        </figure>
      </Section>

      {/* --------------------------------------------------- reservations */}
      <Section
        band
        eyebrow="Unfilled orders"
        title="Reservations count before they fill."
        lead="A resting order carries the risk it will create when it fills, so it occupies the envelope from the moment it is admitted."
      >
        <figure className="figure figure-scroll">
          <ReservationDiagram />
          <figcaption className="figure-note">
            Neither of the first two orders has traded. Both already hold their capacity, which is what stops
            several agents quietly queueing up orders that only breach the limit later, all at once.
          </figcaption>
        </figure>
      </Section>

      {/* ------------------------------------------------- rolling markets */}
      <Section
        eyebrow="Structural risk domains"
        title="Markets roll. The rules don't."
        lead="DreamDEX mints a new 15-minute market every 15 minutes. A limit that needs a transaction per market is a limit nobody maintains."
      >
        <figure className="figure figure-scroll">
          <RollingMarketsDiagram />
          <figcaption className="figure-note">
            A domain is derived on chain from the market's creator, collateral and canonical cadence, in the
            same call that enforces it. A market minted one second ago lands under the right ceiling with no
            configuration. It is a cadence domain and never an asset: sibling series share one ceiling by
            design, so switching between them does not escape it.
          </figcaption>
        </figure>
      </Section>

      {/* ---------------------------------------------------- owner escape */}
      <Section
        band
        eyebrow="Recovery"
        title="The owner always has an exit."
        lead="Every other guarantee here is conditional on something. This one is conditional only on your key."
      >
        <figure className="figure figure-scroll">
          <RecoveryDiagram />
          <figcaption className="figure-note">
            Withdrawal reads no policy, no agent state, no market state and no keeper. It works with every agent
            revoked, the policy expired, this interface gone and the backend offline — from any wallet, block
            explorer or script.
          </figcaption>
        </figure>
      </Section>

      {/* ----------------------------------------------- intent to proof */}
      <Section
        eyebrow="What happens to an order"
        title="From intent to proof."
        lead="Six stages. The contract decides at stage three, and every stage after it is measured rather than assumed."
      >
        <figure className="figure">
          <IntentPipeline />
          <figcaption className="figure-note">
            Admission and the gate display come from one evaluation path in the contract, so what the interface
            shows you cannot drift from what was enforced. Fills are read from token balances rather than
            accumulated, and the receipt records which values the contract asserted and which a worker merely
            observed.
          </figcaption>
        </figure>
      </Section>

      {/* -------------------------------------------------- honest limits */}
      <Section
        band
        eyebrow="Limits"
        title="What AIRSPACE does not claim."
        lead="The contract enforces a cadence domain: creator, collateral and canonical cadence, all read from the DreamDEX registry during execution."
      >
        <div className="stack" style={{ gap: 20, maxWidth: 720 }}>
          <p className="muted">
            It cannot tell BTC from ETH, and it never claims to — sibling series of the same cadence
            deliberately share one ceiling. AIRSPACE bounds how much exposure your agents may hold at once. It
            does not make that exposure profitable, and it does not remove market risk.
          </p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <Tag tone="neutral">Not an AI trader</Tag>
            <Tag tone="neutral">Not a prediction-market terminal</Tag>
            <Tag tone="neutral">Market risk is not eliminated</Tag>
            <Tag tone="neutral">Unaudited testnet contracts</Tag>
          </div>
        </div>
      </Section>

      {/* --------------------------------------------------------- evidence */}
      <section className="page section">
        <div className="panel cta">
          <div className="stack" style={{ gap: 10, maxWidth: 620 }}>
            <div className="caption">Evidence</div>
            <h2>See how AIRSPACE survived hostile validation.</h2>
            <p className="muted">
              Three independently-keyed agents ran live against one portfolio: 32 orders admitted, 21 refused by
              the shared envelope. Thirteen adversarial cases, thirteen passes. Every figure here came off the
              chain.
            </p>
          </div>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <Link className="btn btn-primary" to="/app">
              Open the control room
            </Link>
            <a
              className="btn btn-outline"
              href="https://shannon-explorer.somnia.network/address/0x342d200aCF529905CC815D4ff9841053ea1c2D61"
              target="_blank"
              rel="noreferrer"
            >
              View the contracts
            </a>
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
