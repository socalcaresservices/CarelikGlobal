import { useRef } from "react";
import type { UseMutationResult } from "@tanstack/react-query";

/**
 * Runs a mutation at most once at a time. A second tap before the first finishes (React Query reports "pending" a
 * moment late) is ignored, so a double tap can never send two requests. The server's idempotency key is the second line of defence.
 */
export function useGuardedMutate<V = void>(mutation: UseMutationResult<unknown, unknown, V>) {
  const inFlight = useRef(false);
  return (variables: V) => {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.mutate(variables, { onSettled: () => { inFlight.current = false; } });
  };
}
