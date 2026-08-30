import { describe, it, expect } from "vitest";
import { runHealthChecks } from "@/lib/healthEngine";
import { nodeAllocations, nodeOversubscription, nodeStorageUsable, environmentOversubscription, scorePlacement } from "@/lib/homelab";
import { physicalGraph, executionGraph, dependencyGraph } from "@/lib/graph";
import { previewImport } from "@/lib/canonicalImport";

const V = "adaptive-homelab-atlas/v1";

describe("empty-state behavior", () => {
  it("zero nodes/workloads -> no findings, no throw", () => {
    expect(runHealthChecks({})).toEqual([]);
    expect(runHealthChecks({ Node: [], Workload: [] })).toEqual([]);
  });
  it("nodes but no environments -> allocations zero, no oversubscription", () => {
    const n = { id: "n1", hostname: "n1", ram_capacity_gb: 16, logical_cpus: 4 };
    expect(nodeAllocations(n, [], [])).toEqual({ cpu: 0, ram: 0, vram: 0, storage: 0 });
    expect(nodeOversubscription(n, [], [], [])).toEqual({});
  });
  it("environments but no workloads -> no env oversubscription", () => {
    const e = { id: "e1", name: "e1", cpu_allocation: 4, ram_allocation_gb: 8 };
    expect(environmentOversubscription(e, [])).toEqual({});
  });
  it("no storage -> usable capacity UNKNOWN (not zero)", () => {
    const u = nodeStorageUsable({ id: "n1" }, []);
    expect(u.known).toBe(false);
    expect(u.usable).toBe(0);
  });
  it("no observations -> no stale/observation findings", () => {
    const codes = runHealthChecks({ Workload: [{ id: "w1", name: "w1", state_classification: "documented" }] }).map((f) => f.code);
    expect(codes).not.toContain("STALE_OBSERVATION");
    expect(codes).not.toContain("NO_OBSERVATION");
  });
  it("no decisions / no planned changes -> no change-risk or supersession findings", () => {
    const codes = runHealthChecks({ Decision: [], PlannedChange: [] }).map((f) => f.code);
    expect(codes).not.toContain("CHANGE_NO_ROLLBACK");
  });
  it("no canonical import ever performed -> preview on empty data works", () => {
    const r = previewImport({ schema_version: V, nodes: [{ canonical_id: "node:n1", hostname: "n1" }] }, {});
    expect(r.counts.created).toBe(1);
  });
  it("graphs on empty data produce no nodes/edges", () => {
    expect(physicalGraph({}).nodes).toEqual([]);
    expect(executionGraph({}).edges).toEqual([]);
    expect(dependencyGraph({}).nodes).toEqual([]);
  });
  it("placement on empty data does not recommend (unknown) and does not throw", () => {
    const res = scorePlacement({ id: "w1", name: "w1", ram_requirement_gb: 8 }, { id: "n1", hostname: "n1" }, { workloads: [{ id: "w1" }] });
    expect(res.eligibility).toBe("unknown");
  });
});