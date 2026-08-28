import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PortfolioSnapshot } from "../lib/api";

/**
 * Live portfolio state.
 *
 * A WebSocket to the portfolio's Durable Object supplies updates; react-query
 * holds the authoritative snapshot. On reconnect we always take a fresh full
 * snapshot before trusting anything incremental (PRD 32.3).
 *
 * Nothing here is authoritative for an execution decision. The contract decides
 * at execution time; this is a view.
 */
export function usePortfolio(address?: string, domains: string[] = []) {
  const qc = useQueryClient();
  const key = ["portfolio", address, domains.join(",")];
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");

  const query = useQuery({
    queryKey: key,
    enabled: Boolean(address),
    queryFn: () => api.portfolio(address!, domains),
    // The socket pushes updates; this is the safety net if it drops.
    refetchInterval: connection === "live" ? false : 15_000,
    staleTime: 5_000,
  });

  const domainsKey = domains.join(",");
  const retry = useRef(0);

  useEffect(() => {
    if (!address) return;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${location.host}/api/portfolios/${address}/stream?domains=${encodeURIComponent(domainsKey)}`;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        retry.current = 0;
        setConnection("live");
        // Authoritative baseline first, then incremental messages.
        void qc.invalidateQueries({ queryKey: key });
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as { type: string; data: PortfolioSnapshot };
          if (msg.type === "snapshot" || msg.type === "stale") qc.setQueryData(key, msg.data);
        } catch {
          /* ignore a malformed frame rather than tearing down the stream */
        }
      };
      ws.onclose = () => {
        if (!closed) scheduleReconnect();
      };
      ws.onerror = () => ws?.close();
    };

    const scheduleReconnect = () => {
      setConnection(retry.current > 3 ? "offline" : "reconnecting");
      const delay = Math.min(1000 * 2 ** retry.current, 20_000);
      retry.current += 1;
      timer = window.setTimeout(connect, delay);
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      ws?.close();
    };
  }, [address, domainsKey, qc]);

  return { ...query, connection };
}

/** Derived portfolio figures. Pure: no effect, no mirrored state. */
export function usePortfolioMath(snap?: PortfolioSnapshot) {
  return useMemo(() => {
    if (!snap) return null;
    const capitalBase = BigInt(snap.capitalBase);
    const free = BigInt(snap.freeCollateral);
    const committed = BigInt(snap.committedCapital);
    const reserved = BigInt(snap.reservedCollateral);
    return {
      capitalBase,
      free,
      committed,
      reserved,
      deployed: committed > reserved ? committed - reserved : 0n,
      utilisation: capitalBase === 0n ? 0 : Number((committed * 10000n) / capitalBase) / 100,
    };
  }, [snap]);
}

export function useAgents(address?: string) {
  return useQuery({
    queryKey: ["agents", address],
    enabled: Boolean(address),
    queryFn: () => api.agents(address!),
    staleTime: 15_000,
  });
}

export function useMarkets(minRemaining = 120) {
  return useQuery({
    queryKey: ["markets", minRemaining],
    queryFn: () => api.markets(minRemaining),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}

export function useList<T>(
  address: string | undefined,
  kind: "intents" | "receipts" | "reservations" | "positions",
  opts: { limit?: number; offset?: number; agent?: string; status?: string } = {},
) {
  const q: Record<string, string> = {
    limit: String(opts.limit ?? 25),
    offset: String(opts.offset ?? 0),
  };
  if (opts.agent) q.agent = opts.agent;
  if (opts.status) q.status = opts.status;

  return useQuery({
    queryKey: [kind, address, q],
    enabled: Boolean(address),
    queryFn: () => api.list<T>(address!, kind, q),
    staleTime: 10_000,
  });
}
