import { useReadContract } from "wagmi";
import { airspacePortfolioAbi, binaryMarketAbi, binaryModuleAbi, DREAMDEX, erc6909Abi } from "@airspace/sdk";
import { useWrite } from "../hooks/tx";
import { useIsWrongNetwork } from "../wallet";
import { TxStatus } from "./tx";
import { contracts } from "../lib/format";

/**
 * Cancel one resting order from the owner's wallet.
 *
 * The pool and order id are NOT taken from the indexer. They are read live from
 * the portfolio's own `orderRec(key)` mapping, which is the same record the
 * contract itself cancels against — so a stale or empty Supabase can at worst
 * fail to offer the button, never point it at the wrong order. An order the
 * contract no longer tracks reads back as the zero pool and the button stays
 * disabled.
 */
export function CancelOrderButton({
  portfolio,
  orderKey,
  isOwner,
  onDone,
}: {
  portfolio: string;
  orderKey: string;
  isOwner: boolean;
  onDone?: () => void;
}) {
  const tx = useWrite();
  const wrongNetwork = useIsWrongNetwork();

  const rec = useReadContract({
    address: portfolio as `0x${string}`,
    abi: airspacePortfolioAbi,
    functionName: "orderRec",
    args: [orderKey as `0x${string}`],
    query: { enabled: /^0x[0-9a-fA-F]{64}$/.test(orderKey) },
  });

  const pool = rec.data?.[2];
  const orderId = rec.data?.[4];
  const tracked = Boolean(pool) && pool !== "0x0000000000000000000000000000000000000000" && orderId !== undefined;

  return (
    <>
      <button
        className="btn btn-outline btn-sm"
        disabled={!isOwner || !tracked || tx.busy || wrongNetwork}
        title={
          isOwner
            ? "Owner only: cancels the resting order on the venue. The reserved capital is freed by the next release."
            : "Only the portfolio owner can cancel a resting order."
        }
        onClick={async () => {
          if (!tracked) return;
          const h = await tx.send({
            address: portfolio as `0x${string}`,
            abi: airspacePortfolioAbi,
            functionName: "cancelOrder",
            args: [pool as `0x${string}`, orderId as bigint],
          });
          if (h) onDone?.();
        }}
      >
        {tx.busy ? "…" : "Cancel"}
      </button>
      {tx.phase !== "idle" ? <TxStatus state={tx} onDismiss={tx.reset} /> : null}
    </>
  );
}

/**
 * Redeem a settled market's winning outcome tokens back into collateral.
 *
 * Every argument `redeem` takes is derived from chain state rather than typed
 * in: the operator and venue ids come from the DreamDEX module's own registry
 * entry for this market, the winning outcome index is the non-zero slot in the
 * market's `payoutNumerators`, and the amount is the portfolio's live ERC-6909
 * balance of that winning id. A user is never asked to hand-enter an id whose
 * correct value the chain already knows.
 */
export function RedeemButton({
  portfolio,
  marketId,
  isOwner,
  onDone,
}: {
  portfolio: string;
  marketId: string;
  isOwner: boolean;
  onDone?: () => void;
}) {
  const tx = useWrite();
  const wrongNetwork = useIsWrongNetwork();
  const validMarket = /^0x[0-9a-fA-F]{64}$/.test(marketId);

  const registry = useReadContract({
    address: DREAMDEX.binaryModule,
    abi: binaryModuleAbi,
    functionName: "markets",
    args: [marketId as `0x${string}`],
    query: { enabled: validMarket },
  });

  const marketAddress = registry.data?.[8];
  const payouts = useReadContract({
    address: marketAddress,
    abi: binaryMarketAbi,
    functionName: "payoutNumerators",
    query: { enabled: Boolean(marketAddress) },
  });

  const outcomeToken = useReadContract({
    address: portfolio as `0x${string}`,
    abi: airspacePortfolioAbi,
    functionName: "outcomeToken",
    query: { enabled: /^0x[0-9a-fA-F]{40}$/.test(portfolio) },
  });

  // The winning slot is the one the oracle gave a non-zero numerator. A market
  // with no non-zero slot has not paid out, so there is nothing to redeem.
  const numerators = payouts.data;
  const outcomeIdx = numerators ? numerators.findIndex((n) => n > 0n) : -1;
  const winningId = outcomeIdx === 0 ? registry.data?.[10] : outcomeIdx === 1 ? registry.data?.[11] : undefined;

  const balance = useReadContract({
    address: outcomeToken.data,
    abi: erc6909Abi,
    functionName: "balanceOf",
    args: [portfolio as `0x${string}`, winningId ?? 0n],
    query: { enabled: Boolean(outcomeToken.data) && winningId !== undefined },
  });

  const amount = balance.data ?? 0n;
  const operatorId = registry.data?.[4];
  const venueId = registry.data?.[5];
  const ready = outcomeIdx >= 0 && operatorId !== undefined && venueId !== undefined && amount > 0n;

  return (
    <>
      <button
        className="btn btn-outline btn-sm"
        disabled={!isOwner || !ready || tx.busy || wrongNetwork}
        title={
          !isOwner
            ? "Only the portfolio owner can redeem."
            : ready
              ? `Redeem ${contracts(amount)} winning ${outcomeIdx === 0 ? "YES" : "NO"} tokens for collateral.`
              : "Nothing to redeem: this market has not paid out, or the portfolio holds none of the winning outcome."
        }
        onClick={async () => {
          if (!ready) return;
          const h = await tx.send({
            address: portfolio as `0x${string}`,
            abi: airspacePortfolioAbi,
            functionName: "redeem",
            args: [operatorId, venueId, marketId as `0x${string}`, outcomeIdx, amount],
          });
          if (h) onDone?.();
        }}
      >
        {tx.busy ? "…" : "Redeem"}
      </button>
      {tx.phase !== "idle" ? <TxStatus state={tx} onDismiss={tx.reset} /> : null}
    </>
  );
}
