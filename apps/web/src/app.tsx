import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { ConnectButton, NetworkGuard } from "./wallet";
import { Landing } from "./routes/landing";
import { Portfolios } from "./routes/portfolios";
import { CreatePortfolio } from "./routes/create";
import { ControlRoom } from "./routes/control-room";
import { AgentsPage } from "./routes/agents";
import { Activity, IntentDetail } from "./routes/activity";
import { PositionsPage } from "./routes/positions";
import { RecoveryPage } from "./routes/recovery";
import { SettingsPage } from "./routes/settings";
import { NavLinkTab } from "./components/ui";

function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden />
          AIRSPACE
        </Link>
        <div className="row">
          <Link to="/app" className="btn btn-ghost btn-sm">
            Portfolios
          </Link>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

function PortfolioTabs() {
  const { address = "" } = useParams();
  const { pathname } = useLocation();
  const base = `/app/${address}`;
  const tabs = [
    { to: base, label: "Control room" },
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
      <TopBar />
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
    </>
  );
}
