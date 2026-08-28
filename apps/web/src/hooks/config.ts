import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** Backend-declared addresses. Never hardcoded in the bundle. */
export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api.config(),
    staleTime: Infinity,
  });
}
