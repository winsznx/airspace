import { useEffect, useState } from "react";
import { Link, useMatch } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type PortfolioSnapshot } from "../lib/api";
import { collateral, contracts, pct } from "../lib/format";
import { ConnectButton } from "../wallet";

/**
 * The header, as a Dynamic Island.
 *
 * Apple's model has three presentations — compact, minimal and expanded — and a
 * compact one is split into a LEADING and a TRAILING side around the camera,
 * which must still read as one piece of information. That structure is kept
 * literally here: brand leads, wallet trails, and the space between them is the
 * activity area.
 *
 * The part worth taking seriously is WHAT goes in it. A Live Activity surfaces
 * something happening right now — a timer, a call, a delivery. A pill that
 * morphs with nothing live inside is decoration, which this product rejects
 * everywhere else. So the centre carries the one thing that is genuinely live
 * and genuinely the point: the shared risk envelope, usage against ceiling.
 *
 * On the landing page there is no portfolio, so there is no activity, and the
 * island stays narrow rather than inventing something to display.
 *
 * Motion is a real spring — stiffness 400, damping 30, the constants the
 * Dynamic Island recreations converge on — expressed as a CSS `linear()` curve
 * so it costs no animation library. It overshoots 2.8% and settles in 333ms.
 */

/** Scrolled past this, the island contracts. */
const CONTRACT_AT = 24;

function useScrolled(threshold = CONTRACT_AT) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

/**
 * Live envelope state for the island.
 *
 * Polls rather than opening a WebSocket: the control room already holds a live
 * socket for the same portfolio, and a second one for a header badge would be
 * two subscriptions for one screen.
 */
function useEnvelope(address: string | undefined) {
  return useQuery({
    queryKey: ["island", address],
    enabled: Boolean(address),
    queryFn: () => api.portfolio(address!),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

/** The tightest true thing that fits: the domain closest to its ceiling. */
function hottest(snap: PortfolioSnapshot | undefined) {
  const configured = (snap?.domains ?? []).filter((d) => d.configured && BigInt(d.ceiling) > 0n);
  if (configured.length === 0) return null;
  return configured
    .map((d) => ({ ...d, ratio: pct(d.usage, d.ceiling) }))
    .sort((a, b) => b.ratio - a.ratio)[0]!;
}

export function IslandHeader() {
  const scrolled = useScrolled();
  // Both matchers run unconditionally: `a ?? b` would short-circuit the second
  // hook and break the rules of hooks the moment the first one matched.
  const deep = useMatch("/app/:address/*");
  const shallow = useMatch("/app/:address");
  const raw = (deep ?? shallow)?.params.address;
  const address = raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : undefined;

  const { data } = useEnvelope(address);
  const domain = hottest(data);

  // Expanded whenever there is something to say AND the reader is at the top.
  const state = scrolled ? "compact" : "expanded";
  const live = Boolean(domain);

  const tone = !domain ? "idle" : domain.ratio >= 100 ? "over" : domain.ratio >= 80 ? "tight" : "ok";

  return (
    <div className="island-dock">
      <header className="island" data-state={state} data-live={live ? "yes" : "no"} data-tone={tone}>
        {/* leading */}
        <Link to="/" className="island-lead" aria-label="AIRSPACE home">
          <span className="island-mark" aria-hidden />
          <span className="island-word">AIRSPACE</span>
        </Link>

        {/* the activity area — only ever populated by something real */}
        <div className="island-core" aria-live="polite">
          {domain ? (
            <div className="island-activity" key={domain.domain}>
              <span className="island-ring" aria-hidden>
                <span className="island-ring-fill" style={{ width: `${Math.min(100, domain.ratio)}%` }} />
              </span>
              <span className="island-figure">
                <strong className="num">{contracts(domain.usage)}</strong>
                <span className="island-slash">/</span>
                <span className="num">{contracts(domain.ceiling)}</span>
              </span>
              <span className="island-caption">
                {tone === "over" ? "over ceiling" : tone === "tight" ? "near ceiling" : "envelope"}
              </span>
            </div>
          ) : null}
        </div>

        {/* trailing */}
        <div className="island-trail">
          {address ? (
            <Link to="/app" className="island-back" title="All portfolios">
              <span className="island-back-word">Portfolios</span>
              <span className="island-back-icon" aria-hidden>
                ◍
              </span>
            </Link>
          ) : null}
          <ConnectButton />
        </div>
      </header>

      {/* Expanded detail, hung beneath the pill the way a Live Activity expands. */}
      {domain && !scrolled ? (
        <div className="island-sheet" role="status">
          <span>
            free <strong className="num">{collateral(data?.freeCollateral ?? "0")}</strong>
          </span>
          <span className="island-sep" aria-hidden />
          <span>
            committed <strong className="num">{collateral(data?.committedCapital ?? "0")}</strong>
          </span>
          <span className="island-sep" aria-hidden />
          <span>
            {domain.liveMarkets} live market{domain.liveMarkets === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
