/**
 * Editorial system diagrams.
 *
 * These explain mechanisms, not moods. Each one has to be readable in about two
 * seconds by someone who has never seen AIRSPACE, so every element on the canvas
 * carries meaning and nothing is there for texture.
 *
 * Colour is load-bearing and consistent across all six:
 *
 *   lavender / iris / magenta   the three independent agents
 *   sky                         DreamDEX, and only DreamDEX
 *   mint                        admitted
 *   ember                       blocked by risk
 *   fog / ash                   structure and inert scaffolding
 *
 * Blue never means anything but "the venue", so a reader learns the vocabulary
 * once and it holds for the whole page. DESIGN.md reserves Ember for chart fills
 * and illustration, which is exactly this.
 *
 * Everything is inline SVG on a `viewBox`, so it stays crisp, scales with the
 * column, and picks up the same CSS custom properties as the rest of the app.
 */

const AGENT = ["var(--lavender)", "var(--iris)", "var(--magenta)"] as const;

/** Arrowheads, defined once per diagram that needs them. */
function Marker({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill={color} />
    </marker>
  );
}

// ---------------------------------------------------------------------------
// 1. Hero — three agents, one pool, one envelope, one refusal
// ---------------------------------------------------------------------------

export function CrossAgentDiagram() {
  const agents = [
    { label: "Momentum", y: 74 },
    { label: "Oracle", y: 214 },
    { label: "Mean-rev", y: 354 },
  ];

  return (
    <svg className="diagram" viewBox="0 0 580 428" role="img" aria-labelledby="d1-title d1-desc">
      <title id="d1-title">Three agents share one capital pool behind one risk envelope</title>
      <desc id="d1-desc">
        Three independent agents draw on a single shared capital pool. Two of their orders pass through the
        portfolio risk envelope to DreamDEX. The third is refused at the envelope because the first two have
        already used the available room.
      </desc>

      <defs>
        {AGENT.map((c, i) => (
          <Marker key={i} id={`d1-a${i}`} color={c} />
        ))}
      </defs>

      {/* the envelope, drawn first so paths sit above it */}
      <rect x="392" y="30" width="40" height="368" rx="20" fill="var(--lavender)" opacity="0.07" />
      <line x1="412" y1="30" x2="412" y2="398" stroke="var(--lavender)" strokeWidth="2" />
      <text x="412" y="18" className="d-label" textAnchor="middle" fill="var(--lavender)">
        RISK ENVELOPE
      </text>

      {/* agents */}
      {agents.map((a, i) => (
        <g key={a.label}>
          <rect x="0" y={a.y} width="140" height="60" rx="16" fill="var(--paper)" stroke="var(--fog)" />
          <circle cx="24" cy={a.y + 30} r="6" fill={AGENT[i]} />
          <text x="42" y={a.y + 35} className="d-node">
            {a.label}
          </text>
          <text x="42" y={a.y + 50} className="d-sub">
            own key
          </text>
        </g>
      ))}

      {/* agents into the pool */}
      {agents.map((a, i) => (
        <path
          key={`in-${i}`}
          d={`M140 ${a.y + 30} C 176 ${a.y + 30}, 176 214, 208 214`}
          fill="none"
          stroke={AGENT[i]}
          strokeWidth="2"
        />
      ))}

      {/* the shared pool */}
      <rect x="208" y="166" width="152" height="96" rx="20" fill="var(--linen)" stroke="var(--fog)" />
      <text x="284" y="204" className="d-node" textAnchor="middle">
        Shared capital
      </text>
      <text x="284" y="226" className="d-sub" textAnchor="middle">
        one pool
      </text>
      <text x="284" y="246" className="d-sub" textAnchor="middle">
        one set of ceilings
      </text>

      {/* pool out to the envelope, one path per agent */}
      {agents.map((a, i) => (
        <path
          key={`out-${i}`}
          className={i < 2 ? "d-flow" : undefined}
          d={`M360 214 C 384 214, 384 ${a.y + 30}, 412 ${a.y + 30}`}
          fill="none"
          stroke={AGENT[i]}
          strokeWidth="2"
        />
      ))}

      {/* admitted: through the envelope to the venue */}
      {[agents[0]!, agents[1]!].map((a, i) => (
        <path
          key={`ok-${i}`}
          d={`M412 ${a.y + 30} C 444 ${a.y + 30}, 448 214, 470 214`}
          fill="none"
          stroke={AGENT[i]}
          strokeWidth="2"
          markerEnd={`url(#d1-a${i})`}
        />
      ))}

      {/* refused: stops dead at the envelope */}
      <g>
        <line x1="404" y1="360" x2="420" y2="408" stroke="var(--ember)" strokeWidth="2" strokeLinecap="round" />
        <line x1="420" y1="360" x2="404" y2="408" stroke="var(--ember)" strokeWidth="2" strokeLinecap="round" />
        <text x="412" y="424" className="d-label" textAnchor="middle" fill="var(--ember)">
          REFUSED
        </text>
      </g>

      {/* the venue */}
      <rect x="470" y="150" width="110" height="128" rx="20" fill="var(--paper)" stroke="var(--sky)" strokeOpacity="0.4" />
      <circle cx="525" cy="188" r="7" fill="var(--sky)" />
      <text x="525" y="222" className="d-node" textAnchor="middle">
        DreamDEX
      </text>
      <text x="525" y="242" className="d-sub" textAnchor="middle">
        event
      </text>
      <text x="525" y="258" className="d-sub" textAnchor="middle">
        contracts
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 2. One pool, many strategies
// ---------------------------------------------------------------------------

export function SharedCapitalDiagram() {
  const strategies = [
    { label: "Momentum", sub: "follows the move", x: 20 },
    { label: "Oracle", sub: "follows a signal", x: 268 },
    { label: "Mean-rev", sub: "fades the extreme", x: 516 },
  ];

  return (
    <svg className="diagram" viewBox="0 0 716 316" role="img" aria-labelledby="d2-title d2-desc">
      <title id="d2-title">One capital base serving three different strategies</title>
      <desc id="d2-desc">
        A single capital base supplies three unlike strategies through separately governed allocations, instead
        of splitting the money into three isolated pots.
      </desc>

      <defs>
        <Marker id="d2-arrow" color="var(--ash)" />
      </defs>

      {strategies.map((s, i) => (
        <g key={s.label}>
          <rect x={s.x} y="0" width="180" height="72" rx="18" fill="var(--paper)" stroke="var(--fog)" />
          <circle cx={s.x + 26} cy="30" r="6" fill={AGENT[i]} />
          <text x={s.x + 44} y="35" className="d-node">
            {s.label}
          </text>
          <text x={s.x + 26} y="56" className="d-sub">
            {s.sub}
          </text>

          {/* allocation path down into the pool, through its own limit */}
          <line x1={s.x + 90} y1="72" x2={s.x + 90} y2="116" stroke="var(--ash)" strokeWidth="1.5" />
          <rect x={s.x + 50} y="116" width="80" height="34" rx="17" fill="var(--linen)" stroke="var(--fog)" />
          <text x={s.x + 90} y="138" className="d-sub" textAnchor="middle">
            its limit
          </text>
          <line
            x1={s.x + 90}
            y1="150"
            x2={s.x + 90}
            y2="196"
            stroke="var(--ash)"
            strokeWidth="1.5"
            markerEnd="url(#d2-arrow)"
          />
        </g>
      ))}

      {/* the pool itself */}
      <rect x="20" y="204" width="676" height="92" rx="28" fill="var(--lavender)" opacity="0.08" />
      <rect x="20" y="204" width="676" height="92" rx="28" fill="none" stroke="var(--lavender)" strokeOpacity="0.45" />
      <text x="358" y="242" className="d-node" textAnchor="middle">
        One capital base
      </text>
      <text x="358" y="268" className="d-sub" textAnchor="middle">
        every strategy draws from the same money, under one portfolio-wide envelope
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 3. Reservations count before they fill
// ---------------------------------------------------------------------------

export function ReservationDiagram() {
  // 500 contracts of capacity across 620 units of canvas.
  const S = 620 / 500;
  const x0 = 60;
  const aW = 180 * S;
  const bW = 240 * S;
  const ceiling = x0 + 500 * S;

  return (
    <svg className="diagram" viewBox="0 0 800 330" role="img" aria-labelledby="d3-title d3-desc">
      <title id="d3-title">Resting orders occupy capacity before they fill</title>
      <desc id="d3-desc">
        Two unfilled orders of 180 and 240 contracts already occupy 420 of a 500-contract ceiling. A third
        order of 150 would reach 570 and is refused, even though nothing has traded yet.
      </desc>

      {/* unfilled order tickets, floating above the container */}
      {[
        { x: x0, w: aW, label: "Agent A", qty: "180", color: AGENT[0] },
        { x: x0 + aW, w: bW, label: "Agent B", qty: "240", color: AGENT[1] },
      ].map((t) => (
        <g key={t.label}>
          <rect
            x={t.x + 8}
            y="16"
            width={t.w - 16}
            height="56"
            rx="14"
            fill="var(--paper)"
            stroke={t.color}
            strokeDasharray="5 4"
          />
          <text x={t.x + t.w / 2} y="40" className="d-node" textAnchor="middle">
            {t.label}
          </text>
          <text x={t.x + t.w / 2} y="60" className="d-sub" textAnchor="middle">
            {t.qty} resting, not filled
          </text>
          <line
            x1={t.x + t.w / 2}
            y1="72"
            x2={t.x + t.w / 2}
            y2="146"
            stroke={t.color}
            strokeWidth="1.5"
            strokeDasharray="3 4"
          />
        </g>
      ))}

      {/* the capacity container */}
      <rect x={x0} y="146" width={500 * S} height="66" rx="20" fill="var(--paper)" stroke="var(--fog)" />
      <rect x={x0} y="146" width={aW} height="66" rx="20" fill={AGENT[0]} opacity="0.22" />
      <rect x={x0 + aW} y="146" width={bW} height="66" fill={AGENT[1]} opacity="0.22" />

      <text x={x0 + aW / 2} y="186" className="d-node" textAnchor="middle">
        180
      </text>
      <text x={x0 + aW + bW / 2} y="186" className="d-node" textAnchor="middle">
        240
      </text>
      <text x={x0 + aW + bW + 50} y="186" className="d-sub" textAnchor="middle">
        80 left
      </text>

      {/* the ceiling: a hard rule you can cross */}
      <line x1={ceiling} y1="128" x2={ceiling} y2="252" stroke="var(--carbon)" strokeWidth="2" />
      <text x={ceiling} y="120" className="d-label" textAnchor="middle" fill="var(--carbon)">
        CEILING 500
      </text>

      {/* the third order, drawn past the rule */}
      <rect
        x={x0 + aW + bW}
        y="230"
        width={150 * S}
        height="42"
        rx="14"
        fill="var(--ember)"
        opacity="0.16"
        stroke="var(--ember)"
      />
      <text x={x0 + aW + bW + 90 * S} y="256" className="d-node" textAnchor="middle" fill="var(--ember)">
        Agent C asks 150
      </text>

      <text x={x0} y="300" className="d-eq">
        180 + 240 + 150 = 570 &gt; 500 — refused before a single contract trades
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 4. Markets roll, the rules don't
// ---------------------------------------------------------------------------

export function RollingMarketsDiagram() {
  const cards = [
    { id: "#1428", asset: "BTC", state: "settled" },
    { id: "#1429", asset: "BTC", state: "settled" },
    { id: "#1430", asset: "ETH", state: "live" },
    { id: "#1431", asset: "BTC", state: "new" },
  ];

  return (
    <svg className="diagram" viewBox="0 0 716 300" role="img" aria-labelledby="d4-title d4-desc">
      <title id="d4-title">Successive market generations inherit the same domain</title>
      <desc id="d4-desc">
        Four successive fifteen-minute DreamDEX markets, including different underlyings, all fall into the same
        structural cadence domain and are governed by the same ceiling with no owner transaction.
      </desc>

      <defs>
        <Marker id="d4-arrow" color="var(--fog)" />
      </defs>

      {cards.map((c, i) => {
        const x = 20 + i * 176;
        const fresh = c.state === "new";
        return (
          <g key={c.id}>
            <rect
              x={x}
              y="10"
              width="152"
              height="82"
              rx="18"
              fill="var(--paper)"
              stroke={fresh ? "var(--lavender)" : "var(--fog)"}
            />
            <text x={x + 20} y="42" className="d-node">
              {c.asset} 15m
            </text>
            <text x={x + 20} y="64" className="d-sub">
              {c.id}
            </text>
            <text x={x + 20} y="82" className="d-label" fill={fresh ? "var(--lavender)" : "var(--ash)"}>
              {c.state.toUpperCase()}
            </text>

            {i < cards.length - 1 && (
              <line
                x1={x + 152}
                y1="51"
                x2={x + 168}
                y2="51"
                stroke="var(--fog)"
                strokeWidth="2"
                markerEnd="url(#d4-arrow)"
              />
            )}

            {/* every generation drops into the same envelope */}
            <line
              x1={x + 76}
              y1="92"
              x2={x + 76}
              y2="186"
              stroke={fresh ? "var(--lavender)" : "var(--fog)"}
              strokeWidth="1.5"
              strokeDasharray="4 5"
            />
          </g>
        );
      })}

      <rect x="20" y="186" width="676" height="94" rx="26" fill="var(--lavender)" opacity="0.08" />
      <rect x="20" y="186" width="676" height="94" rx="26" fill="none" stroke="var(--lavender)" strokeOpacity="0.45" />
      <text x="358" y="222" className="d-node" textAnchor="middle">
        One 15-minute cadence domain
      </text>
      <text x="358" y="246" className="d-mono" textAnchor="middle">
        keccak256(creator, collateral, canonicalCadence)
      </text>
      <text x="358" y="268" className="d-sub" textAnchor="middle">
        derived on chain during execution — no configuration, no owner transaction
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 5. The owner always has an exit
// ---------------------------------------------------------------------------

export function RecoveryDiagram() {
  const gone = [
    { label: "Agents", x: 40 },
    { label: "Backend", x: 268 },
    { label: "Keeper", x: 496 },
  ];

  return (
    <svg className="diagram" viewBox="0 0 716 340" role="img" aria-labelledby="d5-title d5-desc">
      <title id="d5-title">Owner recovery depends on nothing but the owner key</title>
      <desc id="d5-desc">
        Agents, the backend and the keeper can all be unavailable. The owner still withdraws directly from the
        portfolio contract, which checks ownership and nothing else.
      </desc>

      <defs>
        <Marker id="d5-arrow" color="var(--carbon)" />
      </defs>

      {gone.map((g) => (
        <g key={g.label} opacity="0.55">
          <rect
            x={g.x}
            y="0"
            width="180"
            height="62"
            rx="16"
            fill="var(--paper)"
            stroke="var(--fog)"
            strokeDasharray="6 5"
          />
          <text x={g.x + 62} y="38" className="d-node" fill="var(--ash)">
            {g.label}
          </text>
          <line
            x1={g.x + 26}
            y1="22"
            x2={g.x + 42}
            y2="40"
            stroke="var(--ember)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1={g.x + 42}
            y1="22"
            x2={g.x + 26}
            y2="40"
            stroke="var(--ember)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* the path that is not there */}
          <line
            x1={g.x + 90}
            y1="62"
            x2={g.x + 90}
            y2="128"
            stroke="var(--fog)"
            strokeWidth="1.5"
            strokeDasharray="4 6"
          />
        </g>
      ))}

      <text x="358" y="108" className="d-label" textAnchor="middle" fill="var(--ash)">
        ALL UNAVAILABLE
      </text>

      {/* the contract */}
      <rect x="188" y="128" width="340" height="82" rx="22" fill="var(--paper)" stroke="var(--fog)" />
      <text x="358" y="162" className="d-node" textAnchor="middle">
        AirspacePortfolio
      </text>
      <text x="358" y="186" className="d-sub" textAnchor="middle">
        holds the collateral
      </text>

      {/* the owner path, the only solid line on the canvas */}
      <rect x="20" y="140" width="132" height="58" rx="16" fill="var(--paper)" stroke="var(--carbon)" />
      <text x="86" y="167" className="d-node" textAnchor="middle">
        Owner key
      </text>
      <text x="86" y="186" className="d-sub" textAnchor="middle">
        the only input
      </text>
      <line x1="152" y1="169" x2="188" y2="169" stroke="var(--carbon)" strokeWidth="2" markerEnd="url(#d5-arrow)" />

      <line x1="358" y1="210" x2="358" y2="252" stroke="var(--carbon)" strokeWidth="2" markerEnd="url(#d5-arrow)" />

      <rect x="228" y="252" width="260" height="58" rx="16" fill="var(--mint-wash)" stroke="var(--mint)" strokeOpacity="0.5" />
      <text x="358" y="280" className="d-node" textAnchor="middle">
        withdraw(token, to, amount)
      </text>
      <text x="358" y="299" className="d-sub" textAnchor="middle">
        reads no policy, no agent, no market, no keeper
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 6. From intent to proof
// ---------------------------------------------------------------------------

/**
 * Rendered in CSS rather than SVG on purpose.
 *
 * Six stages in a fixed-ratio `viewBox` would shrink to unreadable type on a
 * phone. As flow layout the stages wrap instead, so the diagram degrades into a
 * two-column grid rather than into 4px text.
 */
export function IntentPipeline() {
  const stages = [
    { n: "01", label: "Agent intent", sub: "signed by the agent's own key", tone: "agent" },
    { n: "02", label: "Local policy", sub: "the agent's own limits", tone: "agent" },
    { n: "03", label: "Portfolio admission", sub: "every other agent's state", tone: "envelope" },
    { n: "04", label: "DreamDEX execution", sub: "the order reaches the venue", tone: "venue" },
    { n: "05", label: "Reconciliation", sub: "measured from balances", tone: "envelope" },
    { n: "06", label: "Receipt", sub: "the decision, with its arithmetic", tone: "proof" },
  ] as const;

  return (
    <ol className="pipeline" aria-label="From intent to proof">
      {stages.map((s) => (
        <li key={s.n} className={`pipeline-step pipeline-${s.tone}`}>
          <span className="pipeline-dot" aria-hidden />
          <span className="pipeline-n">{s.n}</span>
          <span className="pipeline-label">{s.label}</span>
          <span className="pipeline-sub">{s.sub}</span>
        </li>
      ))}
    </ol>
  );
}
