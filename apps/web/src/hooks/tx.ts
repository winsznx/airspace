import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { BaseError, ContractFunctionRevertedError, type Abi } from "viem";
import { Refusal, REFUSAL_COPY, REFUSAL_NAME } from "@airspace/types";
import { shannon } from "../lib/chain";

export type TxPhase = "idle" | "signing" | "pending" | "confirmed" | "rejected" | "reverted" | "failed";

export interface TxState {
  phase: TxPhase;
  hash?: `0x${string}`;
  /** Human-readable reason. For a refusal this is the trader-facing copy. */
  message?: string;
  /** Set when the revert decoded to `Refused(uint8)`. */
  refusal?: { code: number; name: string; title: string; detail: string; action: string };
}

const REJECTED = /user rejected|user denied|request rejected|4001/i;

/**
 * Decode a failed write into something a person can act on.
 *
 * A `Refused(code)` revert is not an error in the software sense: the contract
 * did exactly its job. It is surfaced with the same copy the preview would have
 * shown, so a refusal never reads as a crash.
 */
function describe(err: unknown): TxState {
  const msg = err instanceof Error ? err.message : String(err);
  if (REJECTED.test(msg)) return { phase: "rejected", message: "You cancelled the transaction in your wallet." };

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name === "Refused") {
        const code = Number(reverted.data?.args?.[0] ?? Refusal.NONE);
        const copy = REFUSAL_COPY[code];
        return {
          phase: "reverted",
          message: copy?.title ?? `Refused (${code})`,
          refusal: {
            code,
            name: REFUSAL_NAME[code] ?? String(code),
            title: copy?.title ?? "Refused",
            detail: copy?.detail ?? "The portfolio contract refused this intent.",
            action: copy?.action ?? "",
          },
        };
      }
      if (name) return { phase: "reverted", message: `Reverted: ${name}` };
    }
    return { phase: "failed", message: err.shortMessage || msg };
  }
  return { phase: "failed", message: msg };
}

/**
 * One on-chain write, with every state the user can actually reach.
 *
 * The transaction is simulated first so a revert is reported before the wallet
 * ever opens: a user should not pay gas to learn a policy refused them.
 */
export function useWrite() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [state, setState] = useState<TxState>({ phase: "idle" });

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  const send = useCallback(
    async (req: {
      address: `0x${string}`;
      abi: Abi;
      functionName: string;
      args: readonly unknown[];
    }): Promise<`0x${string}` | null> => {
      if (!walletClient || !address || !publicClient) {
        setState({ phase: "failed", message: "Connect a wallet first." });
        return null;
      }
      setState({ phase: "signing" });
      try {
        const { request } = await publicClient.simulateContract({
          ...req,
          account: address,
          chain: shannon,
        });
        const hash = await walletClient.writeContract(request);
        setState({ phase: "pending", hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          setState({ phase: "reverted", hash, message: "The transaction reverted on chain." });
          return null;
        }
        setState({ phase: "confirmed", hash });
        return hash;
      } catch (err) {
        setState(describe(err));
        return null;
      }
    },
    [address, publicClient, walletClient],
  );

  return { ...state, send, reset, busy: state.phase === "signing" || state.phase === "pending" };
}
