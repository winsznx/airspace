import type { Page } from "@playwright/test";

/**
 * A minimal EIP-1193 provider injected before any script on the page runs, so
 * wagmi's injected connector discovers it exactly as it would a real wallet
 * extension — both through the legacy `window.ethereum` global and through an
 * EIP-6963 `eip6963:announceProvider` broadcast, since RainbowKit's connector
 * list is built from EIP-6963 discovery first.
 *
 * `eth_call` is answered from a per-test lookup table keyed by the 4-byte
 * selector, set with `mockEthCall`. Nothing here talks to a real network —
 * that is the point: these tests must not depend on live Shannon state.
 */
export async function installMockWallet(
  page: Page,
  opts: { address?: `0x${string}`; chainIdHex?: string } = {},
): Promise<void> {
  const address = opts.address ?? "0x000000000000000000000000000000000000A1";
  const chainIdHex = opts.chainIdHex ?? "0xc498"; // 50312

  await page.addInitScript(
    ({ address, chainIdHex }) => {
      type Listener = (...args: unknown[]) => void;
      const listeners = new Map<string, Set<Listener>>();
      const on = (event: string, cb: Listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
      };
      const removeListener = (event: string, cb: Listener) => {
        listeners.get(event)?.delete(cb);
      };

      const provider = {
        _isMockWallet: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [address];
            case "eth_chainId":
              return chainIdHex;
            case "net_version":
              return String(parseInt(chainIdHex, 16));
            case "eth_call": {
              const call = (params?.[0] as { data?: string }) ?? {};
              const selector = (call.data ?? "0x").slice(0, 10);
              const table = (window as unknown as { __mockEthCall?: Record<string, string> }).__mockEthCall ?? {};
              return table[selector] ?? "0x";
            }
            case "eth_getBlockByNumber":
              return { number: "0x1", timestamp: "0x1" };
            case "eth_blockNumber":
              return "0x1";
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            case "eth_estimateGas":
              return "0x5208";
            case "eth_gasPrice":
              return "0x3b9aca00";
            default:
              return null;
          }
        },
        on,
        removeListener,
        emit(event: string, ...args: unknown[]) {
          for (const cb of listeners.get(event) ?? []) cb(...args);
        },
      };

      (window as unknown as { ethereum: unknown }).ethereum = provider;
      // Some connector implementations wait for this per EIP-1193 before
      // treating the provider as usable.
      queueMicrotask(() => provider.emit("connect", { chainId: chainIdHex }));

      // EIP-6963: RainbowKit/wagmi discover injected wallets by listening for
      // this event and re-broadcasting a request for providers to announce
      // themselves.
      const detail = {
        info: {
          uuid: "mock-wallet-0000-0000-0000-000000000000",
          name: "Mock Wallet",
          icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
          rdns: "airspace.e2e.mock-wallet",
        },
        provider,
      };
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { address, chainIdHex },
  );
}

/** Register the ABI-encoded `eth_call` response for one 4-byte selector. */
export async function mockEthCall(page: Page, selector: `0x${string}`, encodedResult: `0x${string}`): Promise<void> {
  await page.addInitScript(
    ({ selector, encodedResult }) => {
      const w = window as unknown as { __mockEthCall?: Record<string, string> };
      w.__mockEthCall ??= {};
      w.__mockEthCall[selector] = encodedResult;
    },
    { selector, encodedResult },
  );
}
