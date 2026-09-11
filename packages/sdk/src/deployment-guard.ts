import type { Address } from "@airspace/types";
import type { PublicClient } from "viem";
import { airspacePortfolioFactoryAbi } from "./abi.js";

/**
 * Deployments this repository has proven UNSAFE and will not serve against.
 *
 * AIRSPACE 1.0.0 understated worst-case directional exposure — a resting
 * BUY_YES and a resting BUY_NO on one market netted against each other, though
 * either can fill without the other. See evidence/production/REMEDIATION.md and
 * engineering/03-superseded-unsafe-v1/. There is no proxy and no upgrade
 * authority on a live portfolio, so the fix is a NEW deployment at new
 * addresses, never a patch applied in place — which means a misconfigured
 * `AIRSPACE_FACTORY` pointing at the old one is silently plausible: same ABI,
 * same event shapes, same everything except the one property that matters.
 *
 * Keyed by chain id, implementation addresses lower-cased for comparison.
 */
export const SUPERSEDED_IMPLEMENTATIONS: Readonly<Record<number, readonly Address[]>> = {
  50312: ["0x6DE57BC332AA93D3d6323509B3FDA4BCa4808Eb0"],
};

export class SupersededDeploymentError extends Error {
  constructor(
    public readonly factory: Address,
    public readonly implementation: Address,
  ) {
    super(
      `AIRSPACE_FACTORY (${factory}) resolves to implementation ${implementation}, which is a ` +
        "SUPERSEDED, UNSAFE deployment. It understated worst-case directional exposure and must " +
        "never be served. Configure AIRSPACE_FACTORY to the CURRENT deployment recorded in " +
        "contracts/deployments/50312.json, or see evidence/production/REMEDIATION.md.",
    );
    this.name = "SupersededDeploymentError";
  }
}

/**
 * Resolve the factory's implementation and refuse to proceed if it is a known
 * superseded one.
 *
 * A factory's implementation is immutable once deployed (no proxy, no upgrade
 * authority — see DECISIONS.md), so this only ever needs to run once per
 * process; callers should memoize the result rather than re-checking per
 * request.
 *
 * @throws {SupersededDeploymentError} if the resolved implementation is unsafe.
 */
export async function assertCurrentImplementation(
  client: PublicClient,
  factory: Address,
  cid: number,
): Promise<Address> {
  const implementation = (await client.readContract({
    address: factory,
    abi: airspacePortfolioFactoryAbi,
    functionName: "implementation",
  })) as Address;

  const superseded = SUPERSEDED_IMPLEMENTATIONS[cid] ?? [];
  if (superseded.some((a) => a.toLowerCase() === implementation.toLowerCase())) {
    throw new SupersededDeploymentError(factory, implementation);
  }
  return implementation;
}
