import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { NetworkGuard } from "./wallet";
import { Landing } from "./routes/landing";
import { NavLinkTab, LoadingCard } from "./components/ui";
import { IslandHeader } from "./components/island";

/**
 * Everything behind a wallet is lazy. Landing is the front door and stays a
 * static import so it paints with no loading flash; the authenticated surface
 * — portfolios, the control room, agents, activity, positions, recovery,
 * settings — is a separate download that a visitor to `/` never fetches.
 */
const Portfolios = lazy(() => import("./routes/portfolios").then((m) => ({ default: m.Portfolios })));
const CreatePortfolio = lazy(() => import("./routes/create").then((m) => ({ default: m.CreatePortfolio })));
const ControlRoom = lazy(() => import("./routes/control-room").then((m) => ({ default: m.ControlRoom })));
const AgentsPage = lazy(() => import("./routes/agents").then((m) => ({ default: m.AgentsPage })));
const EventContractsPage = lazy(() => import("./routes/markets").then((m) => ({ default: m.EventContractsPage })));
const Activity = lazy(() => import("./routes/activity").then((m) => ({ default: m.Activity })));
const IntentDetail = lazy(() => import("./routes/activity").then((m) => ({ default: m.IntentDetail })));
const PositionsPage = lazy(() => import("./routes/positions").then((m) => ({ default: m.PositionsPage })));
const RecoveryPage = lazy(() => import("./routes/recovery").then((m) => ({ default: m.RecoveryPage })));
const SettingsPage = lazy(() => import("./routes/settings").then((m) => ({ default: m.SettingsPage })));

function RouteFallback() {
  return (
    <div className="page" style={{ paddingBlock: 24 }}>
      <LoadingCard rows={4} />
    </div>
  );
}

function PortfolioTabs() {
  const { address = "" } = useParams();
  const { pathname } = useLocation();
  const base = `/app/${address}`;
  const tabs = [
    { to: base, label: "Control room" },
    { to: `${base}/markets`, label: "Event Contracts" },
    { to: `${base}/agents`, label: "Agents" },
    { to: `${base}/activity`, label: "Activity" },
    { to: `${base}/positions`, label: "Positions" },
    { to: `${base}/recovery`, label: "Recovery" },
    { to: `${base}/settings`, label: "Policies" },
  ];
  return (
    <nav className="tabs" aria-label="Portfolio sections">
      {tabs.map((t) => (
        <NavLinkTab
          key={t.to}
          to={t.to}
          active={t.to === base ? pathname === base || pathname === `${base}/` : pathname.startsWith(t.to)}
        >
          {t.label}
        </NavLinkTab>
      ))}
    </nav>
  );
}

function PortfolioShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page" style={{ paddingBlock: 24 }}>
      <PortfolioTabs />
      <div style={{ marginTop: 24 }} className="stack">
        <NetworkGuard />
        {children}
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
      <IslandHeader />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<Portfolios />} />
          <Route path="/app/new" element={<CreatePortfolio />} />
          <Route
            path="/app/:address"
            element={
              <PortfolioShell>
                <ControlRoom />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/markets"
            element={
              <PortfolioShell>
                <EventContractsPage />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/agents"
            element={
              <PortfolioShell>
                <AgentsPage />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/activity"
            element={
              <PortfolioShell>
                <Activity />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/activity/:intentHash"
            element={
              <PortfolioShell>
                <IntentDetail />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/positions"
            element={
              <PortfolioShell>
                <PositionsPage />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/recovery"
            element={
              <PortfolioShell>
                <RecoveryPage />
              </PortfolioShell>
            }
          />
          <Route
            path="/app/:address/settings"
            element={
              <PortfolioShell>
                <SettingsPage />
              </PortfolioShell>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
