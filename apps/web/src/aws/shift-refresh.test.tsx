import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { DASHBOARD_QUERY_KEYS, SHIFT_CHANGE_QUERY_KEYS, SHIFT_QUERY_KEYS, refreshAfterShiftChange } from "./shift-refresh";

describe("refreshAfterShiftChange", () => {
  it("invalidates every shift list and every dashboard figure a shift change can alter", async () => {
    const invalidated: string[] = [];
    await refreshAfterShiftChange({ invalidateQueries: ((f: { queryKey: string[] }) => { invalidated.push(f.queryKey[0]!); return Promise.resolve(); }) as never });
    for (const key of [...SHIFT_QUERY_KEYS, ...DASHBOARD_QUERY_KEYS]) expect(invalidated).toContain(key);
    expect(new Set(invalidated).size).toBe(SHIFT_CHANGE_QUERY_KEYS.length);
    for (const key of ["aws-shifts", "action-issues", "attention-overview", "aws-utilisation"]) expect(invalidated).toContain(key);
  });

  it("marks cached dashboard and shift data stale, so mounted screens refetch", async () => {
    const qc = new QueryClient();
    for (const key of SHIFT_CHANGE_QUERY_KEYS) qc.setQueryData([key, "org"], { value: 1 });
    await refreshAfterShiftChange(qc);
    for (const key of SHIFT_CHANGE_QUERY_KEYS) expect(qc.getQueryState([key, "org"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["unrelated"])).toBeUndefined();
  });

  it("does not throw when a refetch fails: a saved change must not turn into an error", async () => {
    const failing = { invalidateQueries: vi.fn(() => Promise.reject(new Error("network"))) };
    await expect(refreshAfterShiftChange(failing as never)).resolves.toBeUndefined();
    expect(failing.invalidateQueries).toHaveBeenCalledTimes(SHIFT_CHANGE_QUERY_KEYS.length);
  });
});
