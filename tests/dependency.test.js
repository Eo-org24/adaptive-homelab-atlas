import { describe, it, expect } from "vitest";
import { detectCycles, criticalityMismatches } from "@/lib/homelab";
import { runHealthChecks } from "@/lib/healthEngine";

const dep = (id, s, t, o = {}) => ({ id, source_type: "workload", target_type: "workload", source_id: s, target_id: t, kind: "hard", ...o });
const wl = (id, o = {}) => ({ id, name: id, criticality: "medium", lifecycle: "active", ...o });

describe("detectCycles", () => {
  it("returns no cycles for a simple dependency", () => {
    expect(detectCycles([dep("d1", "A", "B")])).toEqual([]);
  });
  it("returns no cycles for a multi-level chain", () => {
    expect(detectCycles([dep("d1", "A", "B"), dep("d2", "B", "C"), dep("d3", "C", "D")])).toEqual([]);
  });
  it("detects a two-node cycle A→B→A", () => {
    const c = detectCycles([dep("d1", "A", "B"), dep("d2", "B", "A")]);
    expect(c.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(c.flat());
    expect(ids.has("A")).toBe(true);
    expect(ids.has("B")).toBe(true);
  });
  it("detects a three-node cycle A→B→C→A", () => {
    const c = detectCycles([dep("d1", "A", "B"), dep("d2", "B", "C"), dep("d3", "C", "A")]);
    const ids = new Set(c.flat());
    expect(ids.has("A")).toBe(true);
    expect(ids.has("B")).toBe(true);
    expect(ids.has("C")).toBe(true);
  });
  it("ignores non-workload dependencies", () => {
    expect(detectCycles([{ id: "x", source_type: "node", target_type: "node", source_id: "A", target_id: "B", kind: "hard" }])).toEqual([]);
  });
  it("terminates safely on a large chain", () => {
    const deps = [];
    for (let i = 0; i < 500; i++) deps.push(dep(`d${i}`, `n${i}`, `n${i + 1}`));
    expect(() => detectCycles(deps)).not.toThrow();
    expect(detectCycles(deps)).toEqual([]);
  });
});

describe("criticalityMismatches", () => {
  it("flags high-criticality depending on low-criticality", () => {
    const wls = [wl("A", { criticality: "high" }), wl("B", { criticality: "low" })];
    const m = criticalityMismatches([dep("d1", "A", "B")], wls);
    expect(m).toHaveLength(1);
  });
  it("does not flag equal or higher target criticality", () => {
    const wls = [wl("A", { criticality: "low" }), wl("B", { criticality: "high" })];
    expect(criticalityMismatches([dep("d1", "A", "B")], wls)).toHaveLength(0);
  });
});

describe("dependency findings", () => {
  const base = (extra = {}) => ({ Node: [], ExecutionEnvironment: [], Workload: [], Dependency: [], Maintenance: [], Task: [], StorageDevice: [], StoragePool: [], NetworkDevice: [], PlannedChange: [], Decision: [], ...extra });
  const codes = (data) => runHealthChecks(data).map((f) => f.code);

  it("flags a dependency cycle (DEP_CYCLE) with structured fields", () => {
    const wls = [wl("A"), wl("B")];
    const data = base({ Workload: wls, Dependency: [dep("d1", "A", "B"), dep("d2", "B", "A")] });
    const f = runHealthChecks(data).find((x) => x.code === "DEP_CYCLE");
    expect(f).toBeTruthy();
    expect(f.severity).toBe("error");
    expect(f.category).toBe("dependency");
    expect(f.affected_id).toBeTruthy();
    expect(f.data_sufficient).toBe(true);
  });
  it("flags a missing dependency target (DEP_TARGET_MISSING)", () => {
    const wls = [wl("A")];
    const data = base({ Workload: wls, Dependency: [dep("d1", "A", "ghost")] });
    expect(codes(data)).toContain("DEP_TARGET_MISSING");
  });
  it("flags criticality inversion", () => {
    const wls = [wl("A", { criticality: "high" }), wl("B", { criticality: "low" })];
    const data = base({ Workload: wls, Dependency: [dep("d1", "A", "B")] });
    expect(codes(data)).toContain("CRITICALITY_INVERSION");
  });
  it("does not flag inversion for optional dependencies", () => {
    const wls = [wl("A", { criticality: "high" }), wl("B", { criticality: "low" })];
    const data = base({ Workload: wls, Dependency: [dep("d1", "A", "B", { kind: "optional" })] });
    expect(codes(data)).not.toContain("CRITICALITY_INVERSION");
  });
  it("flags dependency on a retired workload", () => {
    const wls = [wl("A"), wl("B", { lifecycle: "retired" })];
    const data = base({ Workload: wls, Dependency: [dep("d1", "A", "B")] });
    expect(codes(data)).toContain("DEP_ON_RETIRED");
  });
  it("flags SPOF concentration (4+ critical workloads on one node)", () => {
    const node = { id: "n1", hostname: "n1", lifecycle_state: "active", availability_expectation: "best_effort" };
    const wls = [1, 2, 3, 4].map((i) => wl(`w${i}`, { criticality: "high", current_host: "n1" }));
    const data = base({ Node: [node], Workload: wls });
    expect(codes(data)).toContain("SPOF_CONCENTRATION");
  });
});