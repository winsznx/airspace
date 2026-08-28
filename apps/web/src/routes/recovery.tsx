import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi, isAddress } from "viem";
import { parseUnits } from "@airspace/risk";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { usePortfolio } from "../hooks/portfolio";
import { useWrite } from "../hooks/tx";
import { TxStatus } from "../components/tx";
import { useIsWrongNetwork } from "../wallet";
import { AddressLink, Card, ErrorState, LoadingCard, Notice, Stat } from "../components/ui";
import { collateral } from "../lib/format";

/**
 * Owner recovery.
 *
 * The claim this page has to honour: withdrawal reads no policy, no agent state,
 * no market state and no keeper. It works with every agent revoked, the policy
 * expired and this entire application offline. The page exists to make that
 * convenient, never to make it possible.
 */
export function RecoveryPage() {
  const { address = "" } = useParams();
  const { address: wallet } = useAccount();
  const portfolio = usePortfolio(address);
  const wrongNetwork = useIsWrongNetwork();

  const withdrawTx = useWrite();
  const outcomeTx = useWrite();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [outcomeId, setOutcomeId] = useState("");
  const [outcomeAmount, setOutcomeAmount] = useState("");

  const token = portfolio.data?.collateralToken as `0x${string}` | undefined;
  const balance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
    query: { enabled: Boolean(token && isAddress(address)) },
  });

  if (portfolio.isLoading && !portfolio.data) return <LoadingCard rows={6} />;
  if (portfolio.isError && !portfolio.data) {
    return <ErrorState error={portfolio.error} retry={() => void portfolio.refetch()} />;
  }

  const snap = portfolio.data!;
  const isOwner = Boolean(wallet) && snap.owner.toLowerCase() === wallet?.toLowerCase();
  const held = (balance.data as bigint | undefined) ?? 0n;
  const recipient = to || wallet || "";
  const recipientValid = isAddress(recipient);
  const amountWei = amount ? parseUnits(amount, 6) : 0n;
  const overBalance = amountWei > held;

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 24 }}>Recovery</h1>
        <p className="muted" style={{ marginTop: 4, maxWidth: 640 }}>
          Getting your capital out depends on nothing but your key. No policy is read, no agent has to
          cooperate, no keeper has to be running, and this interface can be gone entirely.
        </p>
      </div>

      <div className="grid grid-3">
        <Stat label="Collateral held by portfolio" value={collateral(held)} sub="ERC-20 balance, read live" />
        <Stat label="Reserved for resting orders" value={collateral(snap.reservedCollateral)} sub="Cancel orders to free it" />
        <Stat label="Capital base" value={collateral(snap.capitalBase)} sub="Accounting figure, not a lock" />
      </div>

      {!isOwner ? (
        <Notice kind="info" title="Connect the owner wallet to withdraw">
          This portfolio is owned by <AddressLink address={snap.owner} />. Everything on this page is readable
          by anyone; only the owner can move funds.
        </Notice>
      ) : null}

      <Card lg>
        <div className="stack">
          <div>
            <div className="stat-label">Withdraw collateral</div>
            <p className="muted" style={{ marginTop: 4 }}>
              Transfers the portfolio's ERC-20 balance out. Capital sitting behind resting orders is not part of
              that balance until those orders are cancelled or released.
            </p>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label className="field">
              <span className="field-label">Recipient</span>
              <input
                className="input"
                type="text"
                spellCheck={false}
                placeholder={wallet ?? "0x…"}
                value={to}
                aria-invalid={Boolean(to) && !isAddress(to)}
                onChange={(e) => setTo(e.target.value.trim())}
              />
              <span className="field-hint">Defaults to the connected wallet.</span>
            </label>
            <label className="field">
              <span className="field-label">Amount</span>
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
                <span className="field-error">More than the portfolio holds ({collateral(held)}).</span>
              ) : (
                <button
                  className="field-hint"
                  style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer" }}
                  onClick={() => setAmount(collateral(held).replace(/,/g, ""))}
                >
                  Withdraw everything ({collateral(held)})
                </button>
              )}
            </label>
          </div>

          <TxStatus state={withdrawTx} onDismiss={withdrawTx.reset} />

          <div className="row">
            <button
              className="btn btn-primary"
              disabled={!isOwner || !token || !recipientValid || amountWei === 0n || overBalance || withdrawTx.busy || wrongNetwork}
              onClick={async () => {
                const h = await withdrawTx.send({
                  address: address as `0x${string}`,
                  abi: airspacePortfolioAbi,
                  functionName: "withdraw",
                  args: [token as `0x${string}`, recipient as `0x${string}`, amountWei],
                });
                if (h) {
                  setAmount("");
                  void balance.refetch();
                  void portfolio.refetch();
                }
              }}
            >
              {withdrawTx.busy ? (
                <>
                  <span className="spinner" /> Withdrawing
                </>
              ) : (
                "Withdraw"
              )}
            </button>
          </div>
        </div>
      </Card>

      <Card lg>
        <div className="stack">
          <div>
            <div className="stat-label">Withdraw outcome tokens</div>
            <p className="muted" style={{ marginTop: 4 }}>
              Moves ERC-6909 outcome tokens out directly, for when you would rather hold or redeem a position
              yourself than wait for settlement here. Outcome ids appear on the positions page.
            </p>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label className="field">
              <span className="field-label">Outcome id</span>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                spellCheck={false}
                placeholder="decimal id"
                value={outcomeId}
                onChange={(e) => setOutcomeId(e.target.value.trim())}
              />
            </label>
            <label className="field">
              <span className="field-label">Amount</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                value={outcomeAmount}
                onChange={(e) => setOutcomeAmount(e.target.value)}
              />
            </label>
          </div>

          <TxStatus state={outcomeTx} onDismiss={outcomeTx.reset} />

          <div className="row">
            <button
              className="btn btn-outline"
              disabled={!isOwner || !/^\d+$/.test(outcomeId) || !outcomeAmount || outcomeTx.busy || wrongNetwork}
              onClick={() =>
                void outcomeTx.send({
                  address: address as `0x${string}`,
                  abi: airspacePortfolioAbi,
                  functionName: "withdrawOutcome",
                  args: [BigInt(outcomeId), (recipientValid ? recipient : wallet) as `0x${string}`, parseUnits(outcomeAmount || "0", 6)],
                })
              }
            >
              {outcomeTx.busy ? (
                <>
                  <span className="spinner" /> Withdrawing
                </>
              ) : (
                "Withdraw outcome tokens"
              )}
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="stat-label" style={{ marginBottom: 10 }}>
          If this interface is unavailable
        </div>
        <p className="muted">
          Call <code className="mono">withdraw(token, to, amount)</code> on{" "}
          <AddressLink address={address} /> from the owner address using any wallet, block explorer or script.
          The function checks ownership and nothing else.
        </p>
      </Card>
    </div>
  );
}
