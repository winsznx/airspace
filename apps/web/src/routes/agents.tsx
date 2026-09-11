import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount, useSignMessage } from "wagmi";
import { isAddress, keccak256, toHex, zeroHash } from "viem";
import { parseUnits } from "@airspace/risk";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { api } from "../lib/api";
import { useAgents, useList, usePortfolio } from "../hooks/portfolio";
import { useWrite } from "../hooks/tx";
import { TxStatus } from "../components/tx";
import { useIsWrongNetwork } from "../wallet";
import { AGENT_COLORS } from "../components/ceiling";
import {
  AddressLink,
  Card,
  Empty,
  ErrorState,
  LoadingCard,
  Notice,
  Tag,
  TxLink,
} from "../components/ui";
import { collateral, contracts, marketLabel, probability } from "../lib/format";
import type { AgentSummary, IntentRow, ReservationRow } from "../lib/api";

const BLANK = {
  address: "",
  name: "",
  maxCommitted: "1000",
  maxOrderNotional: "250",
  maxBuyPrice: "0.9",
  minSellPrice: "0.1",
  cooldownSec: "0",
  strategyId: "",
};

/**
 * Agents.
 *
 * An agent is an address with its own key and its own limits. AIRSPACE never
 * holds an agent key and never signs for one: registration only writes the
 * policy that constrains it.
 */
export function AgentsPage() {
  const { address = "" } = useParams();
  const { address: wallet } = useAccount();
  const portfolio = usePortfolio(address);
  const agents = useAgents(address);
  const reservations = useList<ReservationRow>(address, "reservations", { limit: 200 });
  const intents = useList<IntentRow>(address, "intents", { limit: 200 });
  const wrongNetwork = useIsWrongNetwork();
  const tx = useWrite();
  const [form, setForm] = useState(BLANK);
  const [open, setOpen] = useState(false);

  const isOwner = Boolean(wallet) && portfolio.data?.owner?.toLowerCase() === wallet?.toLowerCase();
  const list = agents.data?.agents ?? [];

  const set = (k: keyof typeof BLANK, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const addressValid = isAddress(form.address);
  const duplicate = list.some((a) => a.address.toLowerCase() === form.address.toLowerCase());

  const activityByAgent = useMemo(() => {
    const m = new Map<
      string,
      { markets: Set<string>; openOrders: number; reservedQty: bigint; admitted: number; refused: number; exposure: bigint }
    >();
    const get = (a: string) => {
      const k = a.toLowerCase();
      if (!m.has(k)) m.set(k, { markets: new Set(), openOrders: 0, reservedQty: 0n, admitted: 0, refused: 0, exposure: 0n });
      return m.get(k)!;
    };
    for (const r of reservations.data?.reservations ?? []) {
      if (!["RESERVED", "RESTING", "PARTIAL", "NEEDS_RECONCILIATION"].includes(r.state)) continue;
      const e = get(r.agent_address);
      e.markets.add(r.market_id);
      e.openOrders += 1;
      e.reservedQty += BigInt(r.qty_open);
    }
    for (const i of intents.data?.intents ?? []) {
      const e = get(i.agent_address);
      if (i.status === "ADMITTED") e.admitted += 1;
      else e.refused += 1;
    }
    // Realized positions aren't agent-scoped on chain — a market's balance
    // belongs to the portfolio, not any one agent — so that figure is shown at
    // the market level on the Event Contracts page, not attributed here.
    return m;
  }, [reservations.data, intents.data]);

  const { signMessageAsync } = useSignMessage();
  const [nameError, setNameError] = useState<string | null>(null);

  const submit = async () => {
    setNameError(null);
    const hash = await tx.send({
      address: address as `0x${string}`,
      abi: airspacePortfolioAbi,
      functionName: "setAgent",
      args: [
        form.address as `0x${string}`,
        {
          enabled: true,
          maxCommitted: parseUnits(form.maxCommitted || "0", 6),
          maxOrderNotional: parseUnits(form.maxOrderNotional || "0", 6),
          maxBuyPrice: parseUnits(form.maxBuyPrice || "0", 6),
          minSellPrice: parseUnits(form.minSellPrice || "0", 6),
          cooldownSec: BigInt(Math.max(0, Math.floor(Number(form.cooldownSec) || 0))),
          strategyId: form.strategyId ? keccak256(toHex(form.strategyId)) : zeroHash,
        },
      ],
    });
    if (!hash) return;

    // The label is cosmetic and off-chain, so a rejected or failed signature
    // here never rolls back the registration that already landed on chain —
    // it only means the agent shows up unnamed until it is set again.
    const name = form.name.trim();
    if (name) {
      try {
        const timestamp = Date.now();
        const message = [
          "AIRSPACE",
          "Set agent display name",
          `Portfolio: ${address.toLowerCase()}`,
          `Agent: ${form.address.toLowerCase()}`,
          `Name: ${name}`,
          `Timestamp: ${timestamp}`,
        ].join("\n");
        const signature = await signMessageAsync({ message });
        await api.setAgentName(address, form.address, { name, signature, timestamp });
      } catch (e) {
        setNameError(e instanceof Error ? e.message : "Could not save the display name.");
      }
    }

    setForm(BLANK);
    setOpen(false);
    void agents.refetch();
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24 }}>Agents</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Each agent holds its own key and calls the portfolio directly. Its own limits apply first, then the
            envelope every agent shares.
          </p>
        </div>
        {isOwner ? (
          <button className="btn btn-primary" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Register agent"}
          </button>
        ) : null}
      </div>

      {nameError ? (
        <Notice kind="warn" title="Agent registered, but the display name was not saved">
          {nameError} The agent is live with its policy — you can set a name for it again from the list below.
        </Notice>
      ) : null}

      {!isOwner && wallet ? (
        <Notice kind="info" title="You are not the owner of this portfolio">
          You can read everything here. Registering or revoking an agent requires the owner key.
        </Notice>
      ) : null}

      {open && isOwner ? (
        <Card lg>
          <div className="stack">
            <div className="stat-label">New agent</div>

            <label className="field">
              <span className="field-label">Agent address</span>
              <input
                className="input"
                type="text"
                spellCheck={false}
                placeholder="0x…"
                aria-invalid={form.address.length > 0 && !addressValid}
                value={form.address}
                onChange={(e) => set("address", e.target.value.trim())}
              />
              {form.address && !addressValid ? (
                <span className="field-error">That is not a valid address.</span>
              ) : duplicate ? (
                <span className="field-hint">Already registered. Saving will update its policy.</span>
              ) : (
                <span className="field-hint">The address the agent signs with. Never a key you paste here.</span>
              )}
            </label>

            <label className="field">
              <span className="field-label">Label</span>
              <input
                className="input"
                type="text"
                placeholder="momentum-1"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
              <span className="field-hint">Shown in this interface. Not written on chain.</span>
            </label>

            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label className="field">
                <span className="field-label">Max committed capital</span>
                <input
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={form.maxCommitted}
                  onChange={(e) => set("maxCommitted", e.target.value)}
                />
                <span className="field-hint">Most this agent may have tied up at once.</span>
              </label>
              <label className="field">
                <span className="field-label">Max order notional</span>
                <input
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={form.maxOrderNotional}
                  onChange={(e) => set("maxOrderNotional", e.target.value)}
                />
                <span className="field-hint">Largest single order it may place.</span>
              </label>
              <label className="field">
                <span className="field-label">Max buy price</span>
                <input
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={form.maxBuyPrice}
                  onChange={(e) => set("maxBuyPrice", e.target.value)}
                />
                <span className="field-hint">{probability(parseUnits(form.maxBuyPrice || "0", 6))} implied</span>
              </label>
              <label className="field">
                <span className="field-label">Min sell price</span>
                <input
                  className="input"
                  type="text"
                  inputMode="decimal"
                  value={form.minSellPrice}
                  onChange={(e) => set("minSellPrice", e.target.value)}
                />
                <span className="field-hint">{probability(parseUnits(form.minSellPrice || "0", 6))} implied</span>
              </label>
              <label className="field">
                <span className="field-label">Cooldown (seconds)</span>
                <input
                  className="input"
                  type="text"
                  inputMode="numeric"
                  value={form.cooldownSec}
                  onChange={(e) => set("cooldownSec", e.target.value)}
                />
                <span className="field-hint">Minimum gap between this agent's executions. 0 disables it.</span>
              </label>
              <label className="field">
                <span className="field-label">Strategy id</span>
                <input
                  className="input"
                  type="text"
                  placeholder="momentum-v1"
                  value={form.strategyId}
                  onChange={(e) => set("strategyId", e.target.value)}
                />
                <span className="field-hint">Hashed and stored on chain so a receipt names the strategy.</span>
              </label>
            </div>

            <TxStatus state={tx} onDismiss={tx.reset} />

            <div className="row">
              <button
                className="btn btn-primary"
                disabled={!addressValid || tx.busy || wrongNetwork}
                onClick={() => void submit()}
              >
                {tx.busy ? (
                  <>
                    <span className="spinner" /> Saving
                  </>
                ) : duplicate ? (
                  "Update policy"
                ) : (
                  "Register agent"
                )}
              </button>
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Card>
      ) : null}

      {agents.isLoading ? (
        <LoadingCard rows={4} />
      ) : agents.isError ? (
        <ErrorState error={agents.error} retry={() => void agents.refetch()} />
      ) : list.length === 0 ? (
        <Empty
          title="No agents registered"
          action={
            isOwner ? (
              <button className="btn btn-primary" onClick={() => setOpen(true)}>
                Register your first agent
              </button>
            ) : undefined
          }
        >
          {agents.data?.note === "portfolio not yet indexed"
            ? "This portfolio has not been indexed yet. Agents registered on chain will appear here shortly after their transaction confirms."
            : "An agent is an address you authorise to trade from this pool, under limits you set."}
        </Empty>
      ) : (
        <div className="agent-fleet">
          {list.map((a, i) => (
            <AgentCard
              key={a.address}
              agent={a}
              color={AGENT_COLORS[i % AGENT_COLORS.length]!}
              portfolio={address}
              isOwner={isOwner}
              activity={activityByAgent.get(a.address.toLowerCase())}
              onChanged={() => void agents.refetch()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A strategy label derived from the on-chain `strategyId` hash's PREIMAGE —
 * the plain string the owner typed at registration, which the receipt and
 * this UI both keep locally so a hash never has to stand in for a name.
 * Unrecognised or hand-set ids fall back to "Custom strategy" rather than a
 * guess: nothing here is invented from the hash itself, which is one-way.
 */
function strategyIdentity(strategyId: string | null): { kind: string; blurb: string } {
  const id = (strategyId ?? "").toLowerCase();
  if (id.includes("momentum")) return { kind: "Momentum", blurb: "Trades with the direction of recent price moves." };
  if (id.includes("revers") || id.includes("mean")) return { kind: "Mean reversion", blurb: "Trades against recent moves, toward a fair-value estimate." };
  if (id.includes("oracle") || id.includes("fair")) return { kind: "Fair-value / oracle", blurb: "Prices against an external reference rather than the book." };
  if (id.includes("spread") || id.includes("market")) return { kind: "Spread / market-making", blurb: "Quotes both sides, profiting from the spread rather than direction." };
  return { kind: "Custom strategy", blurb: "An independent strategy under its own local policy." };
}

function AgentCard({
  agent,
  color,
  portfolio,
  isOwner,
  activity,
  onChanged,
}: {
  agent: AgentSummary;
  color: string;
  portfolio: string;
  isOwner: boolean;
  activity: { markets: Set<string>; openOrders: number; reservedQty: bigint; admitted: number; refused: number } | undefined;
  onChanged: () => void;
}) {
  const tx = useWrite();
  const wrongNetwork = useIsWrongNetwork();
  const identity = strategyIdentity(agent.strategyId);
  const utilisation = agent.policy.maxCommitted !== "0" ? (Number(agent.committed) / Number(agent.policy.maxCommitted)) * 100 : 0;

  const { signMessageAsync } = useSignMessage();
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(agent.displayName ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameErr, setNameErr] = useState<string | null>(null);

  const saveName = async () => {
    setNameBusy(true);
    setNameErr(null);
    try {
      const name = nameInput.trim();
      const timestamp = Date.now();
      const message = [
        "AIRSPACE",
        "Set agent display name",
        `Portfolio: ${portfolio.toLowerCase()}`,
        `Agent: ${agent.address.toLowerCase()}`,
        `Name: ${name}`,
        `Timestamp: ${timestamp}`,
      ].join("\n");
      const signature = await signMessageAsync({ message });
      await api.setAgentName(portfolio, agent.address, { name, signature, timestamp });
      setRenaming(false);
      onChanged();
    } catch (e) {
      setNameErr(e instanceof Error ? e.message : "Could not save the display name.");
    } finally {
      setNameBusy(false);
    }
  };

  return (
    <Card className="agent-card">
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="agent-dot" style={{ background: color }} aria-hidden />
          <div className="stack" style={{ gap: 2 }}>
            {renaming ? (
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input"
                  style={{ height: 28, padding: "0 8px", fontSize: 13 }}
                  autoFocus
                  value={nameInput}
                  placeholder={identity.kind}
                  onChange={(e) => setNameInput(e.target.value.slice(0, 40))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <button className="btn btn-primary btn-sm" disabled={nameBusy} onClick={() => void saveName()}>
                  {nameBusy ? "…" : "Save"}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={nameBusy} onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <span className="row" style={{ gap: 6 }}>
                <span style={{ fontWeight: 500, color: "var(--carbon)" }}>{agent.displayName || identity.kind}</span>
                {isOwner ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0 6px", height: 20, fontSize: 11 }}
                    onClick={() => {
                      setNameInput(agent.displayName ?? "");
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </button>
                ) : null}
              </span>
            )}
            <span className="caption">{identity.kind}</span>
            {nameErr ? <span className="field-error">{nameErr}</span> : null}
          </div>
        </div>
        {agent.enabled ? <Tag tone="pass">Active</Tag> : <Tag tone="neutral">Revoked</Tag>}
      </div>

      <p className="caption" style={{ marginTop: 8, marginBottom: 0 }}>
        {identity.blurb}
      </p>

      <div className="agent-stats">
        <div>
          <span className="stat-label">Portfolio usage</span>
          <span className="stat-value">{collateral(agent.committed)}</span>
          <span className="caption dim">of {collateral(agent.policy.maxCommitted)} local limit ({utilisation.toFixed(0)}%)</span>
        </div>
        <div>
          <span className="stat-label">Markets touched</span>
          <span className="stat-value">{activity?.markets.size ?? 0}</span>
          <span className="caption dim">{activity ? [...activity.markets].slice(0, 2).map((m) => marketLabel(m)).join(", ") : "—"}</span>
        </div>
        <div>
          <span className="stat-label">Open reservations</span>
          <span className="stat-value">{activity?.openOrders ?? 0}</span>
          <span className="caption dim">{activity ? contracts(activity.reservedQty) : "0"} reserved</span>
        </div>
        <div>
          <span className="stat-label">Intents</span>
          <span className="stat-value">
            {activity?.admitted ?? 0} <span className="dim">admitted</span>
          </span>
          <span className="caption dim">{activity?.refused ?? 0} refused by envelope or policy</span>
        </div>
      </div>

      <div className="row-between" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
        <span className="caption">
          Order band {probability(agent.policy.minSellPrice)}–{probability(agent.policy.maxBuyPrice)} · max order{" "}
          {collateral(agent.policy.maxOrderNotional)} · cooldown {agent.policy.cooldownSec === "0" ? "none" : `${agent.policy.cooldownSec}s`}
        </span>
        <span className="row" style={{ gap: 10 }}>
          <AddressLink address={agent.address} />
          <TxLink hash={agent.registeredTx} label="registration" />
        </span>
      </div>

      {isOwner && agent.enabled ? (
        <button
          className="btn btn-danger btn-sm"
          style={{ marginTop: 12 }}
          disabled={tx.busy || wrongNetwork}
          onClick={async () => {
            const h = await tx.send({
              address: portfolio as `0x${string}`,
              abi: airspacePortfolioAbi,
              functionName: "revokeAgent",
              args: [agent.address as `0x${string}`],
            });
            if (h) onChanged();
          }}
        >
          {tx.busy ? "…" : "Revoke"}
        </button>
      ) : null}
      {tx.phase !== "idle" ? <TxStatus state={tx} onDismiss={tx.reset} /> : null}
    </Card>
  );
}
