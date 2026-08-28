import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi } from "viem";
import { parseUnits } from "@airspace/risk";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { useMarkets, usePortfolio } from "../hooks/portfolio";
import { useWrite } from "../hooks/tx";
import { TxStatus } from "../components/tx";
import { useIsWrongNetwork } from "../wallet";
import { Card, Empty, ErrorState, LoadingCard, Notice, Tag } from "../components/ui";
import { cadenceLabel, collateral, contracts, probability, shortHash } from "../lib/format";

export function SettingsPage() {
  const { address = "" } = useParams();
  const { address: wallet } = useAccount();
  const markets = useMarkets(60);

  const domains = useMemo(() => {
    const seen = new Map<string, { cadence: number; creator: string; collateralToken: string; count: number }>();
    for (const m of markets.data?.markets ?? []) {
      if (!m.domain) continue;
      const e = seen.get(m.domain);
      if (e) e.count += 1;
      else seen.set(m.domain, { cadence: m.cadenceSec, creator: m.creator, collateralToken: m.collateral, count: 1 });
    }
    return [...seen.entries()].sort((a, b) => a[1].cadence - b[1].cadence);
  }, [markets.data]);

  const portfolio = usePortfolio(address, domains.map(([d]) => d));

  if (portfolio.isLoading && !portfolio.data) return <LoadingCard rows={6} />;
  if (portfolio.isError && !portfolio.data) {
    return <ErrorState error={portfolio.error} retry={() => void portfolio.refetch()} />;
  }

  const snap = portfolio.data!;
  const isOwner = Boolean(wallet) && snap.owner.toLowerCase() === wallet?.toLowerCase();

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 24 }}>Policies</h1>
        <p className="muted" style={{ marginTop: 4, maxWidth: 660 }}>
          Everything here is enforced by the portfolio contract at execution time. Changing a policy does not
          unwind exposure that already exists, it changes what is admitted from the next intent onward.
        </p>
      </div>

      {!isOwner ? (
        <Notice kind="info" title="View only">
          Policy changes require the owner key.
        </Notice>
      ) : null}

      <Funding portfolio={address} snap={snap} isOwner={isOwner} onDone={() => void portfolio.refetch()} />

      <GlobalPolicy portfolio={address} isOwner={isOwner} onDone={() => void portfolio.refetch()} />

      <section className="stack" style={{ gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20 }}>Risk domains</h2>
          <p className="muted" style={{ marginTop: 4, maxWidth: 660 }}>
            A domain is derived on chain from a market's creator, collateral and canonical cadence. It is not
            an asset: every series of the same cadence from the same creator shares one ceiling, so an agent
            cannot escape a limit by switching between sibling markets.
          </p>
        </div>

        {markets.isLoading ? (
          <LoadingCard rows={3} />
        ) : domains.length === 0 ? (
          <Empty title="No live markets to derive a domain from">
            Domains come from markets that currently exist on DreamDEX. When a new series is minted its domain
            appears here with no configuration on your part.
          </Empty>
        ) : (
          domains.map(([domain, meta]) => (
            <DomainPolicyCard
              key={domain}
              portfolio={address}
              domain={domain}
              meta={meta}
              snapshot={snap.domains.find((d) => d.domain === domain)}
              isOwner={isOwner}
              onDone={() => void portfolio.refetch()}
            />
          ))
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Funding({
  portfolio,
  snap,
  isOwner,
  onDone,
}: {
  portfolio: string;
  snap: { collateralToken: string; capitalBase: string };
  isOwner: boolean;
  onDone: () => void;
}) {
  const { address: wallet } = useAccount();
  const wrongNetwork = useIsWrongNetwork();
  const approveTx = useWrite();
  const fundTx = useWrite();
  const baseTx = useWrite();
  const [amount, setAmount] = useState("");
  const [base, setBase] = useState("");

  const token = snap.collateralToken as `0x${string}`;

  const walletBalance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: Boolean(wallet) },
  });

  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: wallet ? [wallet, portfolio as `0x${string}`] : undefined,
    query: { enabled: Boolean(wallet) },
  });

  const amountWei = amount ? parseUnits(amount, 6) : 0n;
  const have = (walletBalance.data as bigint | undefined) ?? 0n;
  const allowed = (allowance.data as bigint | undefined) ?? 0n;
  const needsApproval = amountWei > allowed;
  const overBalance = amountWei > have;

  return (
    <Card lg>
      <div className="stack">
        <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="stat-label">Capital</div>
            <p className="muted" style={{ marginTop: 4 }}>
              Fund the pool, then declare the capital base every ceiling is measured against.
            </p>
          </div>
          <span className="caption">
            Your balance <strong className="num" style={{ color: "var(--carbon)" }}>{collateral(have)}</strong>
          </span>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="stack">
            <label className="field">
              <span className="field-label">Deposit amount</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                aria-invalid={overBalance}
                onChange={(e) => setAmount(e.target.value)}
              />
              {overBalance ? (
                <span className="field-error">More than your wallet holds.</span>
              ) : (
                <span className="field-hint">Transferred from your wallet into the portfolio.</span>
              )}
            </label>

            <TxStatus state={approveTx} onDismiss={approveTx.reset} />
            <TxStatus state={fundTx} onDismiss={fundTx.reset} />

            <div className="row">
              {needsApproval && amountWei > 0n ? (
                <button
                  className="btn btn-outline"
                  disabled={!wallet || approveTx.busy || wrongNetwork || overBalance}
                  onClick={async () => {
                    const h = await approveTx.send({
                      address: token,
                      abi: erc20Abi,
                      functionName: "approve",
                      args: [portfolio as `0x${string}`, amountWei],
                    });
                    if (h) void allowance.refetch();
                  }}
                >
                  {approveTx.busy ? (
                    <>
                      <span className="spinner" /> Approving
                    </>
                  ) : (
                    "Approve"
                  )}
                </button>
              ) : null}
              <button
                className="btn btn-primary"
                disabled={!wallet || amountWei === 0n || needsApproval || overBalance || fundTx.busy || wrongNetwork}
                onClick={async () => {
                  const h = await fundTx.send({
                    address: portfolio as `0x${string}`,
                    abi: airspacePortfolioAbi,
                    functionName: "fund",
                    args: [amountWei],
                  });
                  if (h) {
                    setAmount("");
                    void walletBalance.refetch();
                    void allowance.refetch();
                    onDone();
                  }
                }}
              >
                {fundTx.busy ? (
                  <>
                    <span className="spinner" /> Depositing
                  </>
                ) : (
                  "Deposit"
                )}
              </button>
            </div>
          </div>

          <div className="stack">
            <label className="field">
              <span className="field-label">Capital base</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                placeholder={collateral(snap.capitalBase)}
                value={base}
                onChange={(e) => setBase(e.target.value)}
                disabled={!isOwner}
              />
              <span className="field-hint">
                Currently {collateral(snap.capitalBase)}. Free collateral is measured as base minus what is
                committed, so this must not exceed what the portfolio actually holds.
              </span>
            </label>

            <TxStatus state={baseTx} onDismiss={baseTx.reset} />

            <div className="row">
              <button
                className="btn btn-outline"
                disabled={!isOwner || !base || baseTx.busy || wrongNetwork}
                onClick={async () => {
                  const h = await baseTx.send({
                    address: portfolio as `0x${string}`,
                    abi: airspacePortfolioAbi,
                    functionName: "setCapitalBase",
                    args: [parseUnits(base || "0", 6)],
                  });
                  if (h) {
                    setBase("");
                    onDone();
                  }
                }}
              >
                {baseTx.busy ? (
                  <>
                    <span className="spinner" /> Saving
                  </>
                ) : (
                  "Set capital base"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const GLOBAL_DEFAULTS = {
  maxCommittedCapital: "5000",
  maxReservedCollateral: "3000",
  maxSingleOrderNotional: "500",
  maxBuyPrice: "0.95",
  minSellPrice: "0.05",
  minHeadroomSec: "60",
  policyExpiryDays: "30",
};

function GlobalPolicy({
  portfolio,
  isOwner,
  onDone,
}: {
  portfolio: string;
  isOwner: boolean;
  onDone: () => void;
}) {
  const wrongNetwork = useIsWrongNetwork();
  const tx = useWrite();
  const [f, setF] = useState(GLOBAL_DEFAULTS);
  const set = (k: keyof typeof GLOBAL_DEFAULTS, v: string) => setF((p) => ({ ...p, [k]: v }));

  const current = useReadContract({
    address: portfolio as `0x${string}`,
    abi: airspacePortfolioAbi,
    functionName: "globalPolicy",
  });

  const p = current.data as
    | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]
    | undefined;
  const expiry = p ? Number(p[6]) : 0;
  const expired = expiry > 0 && expiry * 1000 < Date.now();
  const unset = p ? p[0] === 0n && p[6] === 0n : false;

  return (
    <Card lg>
      <div className="stack">
        <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="stat-label">Global policy</div>
            <p className="muted" style={{ marginTop: 4 }}>
              The outermost limits. Every intent is checked against these before anything else.
            </p>
          </div>
          {unset ? (
            <Tag tone="warn">Not set — everything is refused</Tag>
          ) : expired ? (
            <Tag tone="fail">Expired {new Date(expiry * 1000).toLocaleDateString()}</Tag>
          ) : (
            <Tag tone="pass">Active until {new Date(expiry * 1000).toLocaleDateString()}</Tag>
          )}
        </div>

        {p && !unset ? (
          <div className="grid grid-4">
            <div>
              <div className="stat-label">Committed capital</div>
              <div className="num" style={{ color: "var(--carbon)" }}>{collateral(p[0])}</div>
            </div>
            <div>
              <div className="stat-label">Reserved collateral</div>
              <div className="num" style={{ color: "var(--carbon)" }}>{collateral(p[1])}</div>
            </div>
            <div>
              <div className="stat-label">Single order</div>
              <div className="num" style={{ color: "var(--carbon)" }}>{collateral(p[2])}</div>
            </div>
            <div>
              <div className="stat-label">Price band</div>
              <div className="num" style={{ color: "var(--carbon)" }}>
                {probability(p[4])} – {probability(p[3])}
              </div>
            </div>
          </div>
        ) : null}

        {isOwner ? (
          <>
            <hr className="divider" />
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <label className="field">
                <span className="field-label">Max committed capital</span>
                <input className="input" value={f.maxCommittedCapital} onChange={(e) => set("maxCommittedCapital", e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Max reserved collateral</span>
                <input className="input" value={f.maxReservedCollateral} onChange={(e) => set("maxReservedCollateral", e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Max single order</span>
                <input className="input" value={f.maxSingleOrderNotional} onChange={(e) => set("maxSingleOrderNotional", e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Max buy price</span>
                <input className="input" value={f.maxBuyPrice} onChange={(e) => set("maxBuyPrice", e.target.value)} />
                <span className="field-hint">{probability(parseUnits(f.maxBuyPrice || "0", 6))}</span>
              </label>
              <label className="field">
                <span className="field-label">Min sell price</span>
                <input className="input" value={f.minSellPrice} onChange={(e) => set("minSellPrice", e.target.value)} />
                <span className="field-hint">{probability(parseUnits(f.minSellPrice || "0", 6))}</span>
              </label>
              <label className="field">
                <span className="field-label">Minimum expiry headroom</span>
                <input className="input" value={f.minHeadroomSec} onChange={(e) => set("minHeadroomSec", e.target.value)} />
                <span className="field-hint">
                  Seconds a market must still have left. Stops agents entering a series about to roll.
                </span>
              </label>
              <label className="field">
                <span className="field-label">Policy expires in (days)</span>
                <input className="input" value={f.policyExpiryDays} onChange={(e) => set("policyExpiryDays", e.target.value)} />
                <span className="field-hint">
                  After this, every intent is refused until you renew. Withdrawal is unaffected.
                </span>
              </label>
            </div>

            <TxStatus state={tx} onDismiss={tx.reset} />

            <div className="row">
              <button
                className="btn btn-primary"
                disabled={tx.busy || wrongNetwork}
                onClick={async () => {
                  const days = Math.max(1, Math.floor(Number(f.policyExpiryDays) || 1));
                  const h = await tx.send({
                    address: portfolio as `0x${string}`,
                    abi: airspacePortfolioAbi,
                    functionName: "setGlobalPolicy",
                    args: [
                      {
                        maxCommittedCapital: parseUnits(f.maxCommittedCapital || "0", 6),
                        maxReservedCollateral: parseUnits(f.maxReservedCollateral || "0", 6),
                        maxSingleOrderNotional: parseUnits(f.maxSingleOrderNotional || "0", 6),
                        maxBuyPrice: parseUnits(f.maxBuyPrice || "0", 6),
                        minSellPrice: parseUnits(f.minSellPrice || "0", 6),
                        minHeadroomSec: BigInt(Math.max(0, Math.floor(Number(f.minHeadroomSec) || 0))),
                        policyExpiry: BigInt(Math.floor(Date.now() / 1000) + days * 86400),
                      },
                    ],
                  });
                  if (h) {
                    void current.refetch();
                    onDone();
                  }
                }}
              >
                {tx.busy ? (
                  <>
                    <span className="spinner" /> Saving
                  </>
                ) : (
                  "Save global policy"
                )}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DomainPolicyCard({
  portfolio,
  domain,
  meta,
  snapshot,
  isOwner,
  onDone,
}: {
  portfolio: string;
  domain: string;
  meta: { cadence: number; creator: string; collateralToken: string; count: number };
  snapshot?: { usage: string; ceiling: string; committedCeiling: string; liveMarkets: number; configured: boolean } | undefined;
  isOwner: boolean;
  onDone: () => void;
}) {
  const wrongNetwork = useIsWrongNetwork();
  const tx = useWrite();
  const configured = snapshot?.configured ?? false;

  const [risk, setRisk] = useState(configured ? collateral(snapshot!.ceiling).replace(/,/g, "") : "500");
  const [committed, setCommitted] = useState(
    configured ? collateral(snapshot!.committedCeiling).replace(/,/g, "") : "1000",
  );
  const [maxLive, setMaxLive] = useState(String(configured ? snapshot!.liveMarkets || 8 : 8));
  const [editing, setEditing] = useState(false);

  return (
    <Card lg>
      <div className="stack">
        <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontWeight: 500, color: "var(--carbon)" }}>{cadenceLabel(meta.cadence)} cadence</span>
              {configured ? <Tag tone="pass">Configured</Tag> : <Tag tone="warn">No ceiling</Tag>}
              <span className="caption">{meta.count} live market{meta.count === 1 ? "" : "s"}</span>
            </div>
            <span className="caption hash" title={domain}>
              {shortHash(domain)} · creator {meta.creator.slice(0, 10)}… · collateral {meta.collateralToken.slice(0, 10)}…
            </span>
          </div>
          {isOwner ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing((e) => !e)}>
              {editing ? "Cancel" : configured ? "Edit" : "Set ceiling"}
            </button>
          ) : null}
        </div>

        {configured ? (
          <div className="grid grid-3">
            <div>
              <div className="stat-label">Risk usage now</div>
              <div className="num" style={{ color: "var(--carbon)" }}>{contracts(snapshot!.usage)}</div>
            </div>
            <div>
              <div className="stat-label">Risk ceiling</div>
              <div className="num" style={{ color: "var(--carbon)" }}>{contracts(snapshot!.ceiling)}</div>
            </div>
            <div>
              <div className="stat-label">Committed ceiling</div>
              <div className="num" style={{ color: "var(--carbon)" }}>{collateral(snapshot!.committedCeiling)}</div>
            </div>
          </div>
        ) : (
          <p className="muted">
            Nothing is admitted into this domain until a ceiling exists. That is the intended default: an
            unconfigured domain has no agreed limit to enforce.
          </p>
        )}

        {editing && isOwner ? (
          <>
            <hr className="divider" />
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <label className="field">
                <span className="field-label">Max gross directional exposure</span>
                <input className="input" value={risk} onChange={(e) => setRisk(e.target.value)} />
                <span className="field-hint">
                  Summed across markets without netting. Longs in one series do not offset shorts in another.
                </span>
              </label>
              <label className="field">
                <span className="field-label">Max committed capital</span>
                <input className="input" value={committed} onChange={(e) => setCommitted(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Max live markets</span>
                <input className="input" value={maxLive} onChange={(e) => setMaxLive(e.target.value)} />
                <span className="field-hint">Caps how many markets in this domain can be open at once.</span>
              </label>
            </div>

            <TxStatus state={tx} onDismiss={tx.reset} />

            <div className="row">
              <button
                className="btn btn-primary"
                disabled={tx.busy || wrongNetwork}
                onClick={async () => {
                  const h = await tx.send({
                    address: portfolio as `0x${string}`,
                    abi: airspacePortfolioAbi,
                    functionName: "setDomainPolicy",
                    args: [
                      domain as `0x${string}`,
                      {
                        configured: true,
                        maxDomainRiskUsage: parseUnits(risk || "0", 6),
                        maxDomainCommitted: parseUnits(committed || "0", 6),
                        maxLiveMarkets: Math.max(1, Math.floor(Number(maxLive) || 1)),
                      },
                    ],
                  });
                  if (h) {
                    setEditing(false);
                    onDone();
                  }
                }}
              >
                {tx.busy ? (
                  <>
                    <span className="spinner" /> Saving
                  </>
                ) : (
                  "Save domain policy"
                )}
              </button>
              {configured ? (
                <button
                  className="btn btn-danger"
                  disabled={tx.busy || wrongNetwork}
                  title="Refuse every future intent into this domain"
                  onClick={async () => {
                    const h = await tx.send({
                      address: portfolio as `0x${string}`,
                      abi: airspacePortfolioAbi,
                      functionName: "setDomainPolicy",
                      args: [
                        domain as `0x${string}`,
                        { configured: false, maxDomainRiskUsage: 0n, maxDomainCommitted: 0n, maxLiveMarkets: 0 },
                      ],
                    });
                    if (h) {
                      setEditing(false);
                      onDone();
                    }
                  }}
                >
                  Close domain
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}
