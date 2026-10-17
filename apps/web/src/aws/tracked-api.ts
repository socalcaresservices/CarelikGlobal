import type { QueryClient } from "@tanstack/react-query";
import type { AwsApiClient } from "@/lib/aws-api";

/** The queries whose numbers other screens show. */
export const REFRESHED_AFTER_CHANGE = ["attention-overview", "aws-attention", "action-issues"] as const;

/**
 * After any POST that succeeds, the attention counts and the issue list are re-read, so a number never lags behind the action just taken (B1-R7).
 * A POST that fails changes nothing on the server, so nothing is re-read.
 */
export function withRefresh(api: AwsApiClient, queryClient: Pick<QueryClient, "invalidateQueries">): AwsApiClient {
  return {
    get: api.get,
    post: async <T,>(path: string, body: unknown, options?: { idempotencyKey?: string }): Promise<T> => {
      const result = await api.post<T>(path, body, options);
      for (const key of REFRESHED_AFTER_CHANGE) void queryClient.invalidateQueries({ queryKey: [key] });
      return result;
    },
  };
}
