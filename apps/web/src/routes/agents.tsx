import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { isAddress, keccak256, toHex, zeroHash } from "viem";
import { parseUnits } from "@airspace/risk";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { useAgents, usePortfolio } from "../hooks/portfolio";
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
  TableWrap,
  Tag,
  TxLink,
} from "../components/ui";
import { collateral, probability } from "../lib/format";
import type { AgentSummary } from "../lib/api";

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
  const wrongNetwork = useIsWrongNetwork();
  const tx = useWrite();
  const [form, setForm] = useState(BLANK);
  const [open, setOpen] = useState(false);

  const isOwner = Boolean(wallet) && portfolio.data?.owner?.toLowerCase() === wallet?.toLowerCase();
  const list = agents.data?.agents ?? [];

  const set = (k: keyof typeof BLANK, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const addressValid = isAddress(form.address);
  const duplicate = list.some((a) => a.address.toLowerCase() === form.address.toLowerCase());

  const submit = async () => {
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
    if (hash) {
      setForm(BLANK);
      setOpen(false);
      void agents.refetch();
    }
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
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th className="num-cell">Committed</th>
                <th className="num-cell">Max committed</th>
                <th className="num-cell">Max order</th>
                <th className="num-cell">Price band</th>
                <th className="num-cell">Cooldown</th>
                <th className="num-cell">Nonce</th>
                <th>Registered</th>
                {isOwner ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => (
                <AgentRow
                  key={a.address}
                  agent={a}
                  color={AGENT_COLORS[i % AGENT_COLORS.length]!}
                  portfolio={address}
                  isOwner={isOwner}
                  onChanged={() => void agents.refetch()}
                />
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  color,
  portfolio,
  isOwner,
  onChanged,
}: {
  agent: AgentSummary;
  color: string;
  portfolio: string;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const tx = useWrite();
  const wrongNetwork = useIsWrongNetwork();

  return (
    <>
      <tr>
        <td className="strong">
          <span className="row" style={{ gap: 8 }}>
            <span
              style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }}
              aria-hidden
            />
            <span className="stack" style={{ gap: 2 }}>
              <span>{agent.displayName || "Unnamed agent"}</span>
              <AddressLink address={agent.address} />
            </span>
          </span>
        </td>
        <td>{agent.enabled ? <Tag tone="pass">Active</Tag> : <Tag tone="neutral">Revoked</Tag>}</td>
        <td className="num-cell num">{collateral(agent.committed)}</td>
        <td className="num-cell num">{collateral(agent.policy.maxCommitted)}</td>
        <td className="num-cell num">{collateral(agent.policy.maxOrderNotional)}</td>
        <td className="num-cell num">
          {probability(agent.policy.minSellPrice)} – {probability(agent.policy.maxBuyPrice)}
        </td>
        <td className="num-cell num">{agent.policy.cooldownSec === "0" ? "—" : `${agent.policy.cooldownSec}s`}</td>
        <td className="num-cell num">{agent.nonce}</td>
        <td>
          <TxLink hash={agent.registeredTx} />
        </td>
        {isOwner ? (
          <td>
            {agent.enabled ? (
              <button
                className="btn btn-danger btn-sm"
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
            ) : (
              <span className="dim">—</span>
            )}
          </td>
        ) : null}
      </tr>
      {tx.phase !== "idle" ? (
        <tr>
          <td colSpan={isOwner ? 10 : 9} style={{ paddingTop: 0 }}>
            <TxStatus state={tx} onDismiss={tx.reset} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
