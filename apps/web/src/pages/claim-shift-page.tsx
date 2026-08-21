import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { supabase } from "@/lib/supabase";

interface ClaimView {
  organization: { display_name: string };
  client_name: string;
  starts_at: string;
  ends_at: string;
  already_claimed: boolean;
  still_available: boolean;
}

function formatWindow(startsAt: string, endsAt: string) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const day = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const startTime = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const endTime = end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day}, ${startTime} - ${endTime}`;
}

// No-login shift-claim page, same trust model as candidate-portal-page.tsx:
// a one-time token in the URL is the only credential, resolved through
// get_shift_claim (view) / claim_shift (write) - both anon-accessible,
// token-gated RPCs. Reached from the "tap a link" text sent when a shift
// needs coverage (20260821170000_shift_claim_via_text.sql).
export function ClaimShiftPage() {
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  const claimQuery = useQuery({
    queryKey: ["shift-claim", token],
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc("get_shift_claim", { target_token: token! });
      if (rpcError) throw rpcError;
      return data as ClaimView;
    },
    enabled: !!token,
    retry: false
  });

  const claimMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc("claim_shift", { target_token: token! });
      if (rpcError) throw rpcError;
    },
    onSuccess: () => {
      setClaimed(true);
      void queryClient.invalidateQueries({ queryKey: ["shift-claim", token] });
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "Could not claim this shift.");
    }
  });

  if (claimQuery.isLoading) {
    return (
      <main className="mx-auto max-w-md p-6">
        <Card>
          <p className="text-sm text-slate-500">Loading shift details…</p>
        </Card>
      </main>
    );
  }

  if (claimQuery.isError || !claimQuery.data) {
    return (
      <main className="mx-auto max-w-md p-6">
        <Card>
          <h1 className="text-xl font-semibold text-slate-950">This offer is unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">
            It may have already been claimed, expired, or the shift is no longer open. Contact your agency if you
            still want this shift.
          </p>
        </Card>
      </main>
    );
  }

  const view = claimQuery.data;
  const isDone = claimed || view.already_claimed;
  const isTaken = !view.still_available && !isDone;

  return (
    <main className="mx-auto max-w-md p-6">
      <Card>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{view.organization.display_name}</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-950">Shift needs coverage</h1>
        <p className="mt-2 text-sm text-slate-700">{view.client_name}</p>
        <p className="mt-0.5 text-sm text-slate-600">{formatWindow(view.starts_at, view.ends_at)}</p>

        {isDone ? (
          <p className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
            You&apos;re confirmed for this shift. Check your schedule in the app for details.
          </p>
        ) : isTaken ? (
          <p className="mt-5 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            This shift has already been covered by another caregiver.
          </p>
        ) : (
          <>
            <Button
              type="button"
              className="mt-5 w-full"
              loading={claimMutation.isPending}
              onClick={() => {
                setError(null);
                claimMutation.mutate();
              }}
            >
              {claimMutation.isPending ? "Claiming…" : "Take this shift"}
            </Button>
            {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
          </>
        )}
      </Card>
    </main>
  );
}
