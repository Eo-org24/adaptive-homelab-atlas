import { describe, it, expect } from "vitest";
import { runHealthChecks } from "@/lib/healthEngine";
import { scorePlacement } from "@/lib/homelab";
import { previewImport } from "@/lib/canonicalImport";
import { detectCycles } from "@/lib/homelab";

const base = (extra = {}) => ({
  Node: [], ExecutionEnvironment: [], Workload: [], Dependency: [], Maintenance: [],
  Task: [], StorageDevice: [], StoragePool: [], NetworkDevice: [], PlannedChange: [],
  Decision: [], ...extra,
});
const V = "adaptive-homelab-atlas/v1";

// Every domain entry point must fail safely (no throw) on hostile input.
function safe(fn) {
  try { fn(); return true; } catch { return false; }
}

describe("malformed input hardening", () => {
  it("health engine does not throw on nulls / empty strings / unexpected shapes", () => {
    expect(safe(() => runHealthChecks(base({ Workload: [null, { id: "", name: "" }, { id: "w1", name: "w1", current_host: "", eligible_alternative_nodes: [null, ""] }] })))).toBe(true);
    expect(safe(() => runHealthChecks(base({ Node: [null, { id: "n1", hostname: "n1", ram_capacity_gb: NaN, idle_power_w: -5, logical_cpus: "lots" }] })))).toBe(true);
  });
  it("handles very long names and unicode without throwing", () => {
    const long = "x".repeat(100000);
    const uni = "ノード — 🖥️ — ñ";
    expect(safe(() => runHealthChecks(base({ Node: [{ id: "n1", hostname: long }], Workload: [{ id: "w1", name: uni, current_host: "n1" }] })))).toBe(true);
  });
  it("handles duplicate relationship entries and missing ids", () => {
    expect(safe(() => runHealthChecks(base({ Dependency: [
      { id: "d1", source_type: "workload", source_id: "w1", target_type: "workload", target_id: "w2", kind: "hard" },
      { id: "d1", source_type: "workload", source_id: "w1", target_type: "workload", target_id: "w2", kind: "hard" },
      { id: "", source_type: "workload", source_id: "", target_type: "workload", target_id: "", kind: "hard" },
    ] })))).toBe(true);
  });
  it("handles bad canonical ids and unknown source kinds", () => {
    expect(safe(() => runHealthChecks(base({ Node: [{ id: "n1", hostname: "n1", canonical_id: "", source_kind: "galaxy-brain" }] })))).toBe(true);
  });
  it("handles negative / NaN / huge resource quantities", () => {
    expect(safe(() => runHealthChecks(base({ Node: [{ id: "n1", hostname: "n1", ram_capacity_gb: -100, logical_cpus: NaN }], Workload: [{ id: "w1", name: "w1", current_host: "n1", ram_requirement_gb: 1e308 }] })))).toBe(true);
  });
  it("handles invalid dates", () => {
    expect(safe(() => runHealthChecks(base({ Workload: [{ id: "w1", name: "w1", state_classification: "observed", observed_at: "not-a-date" }] })))).toBe(true);
  });
  it("previewImport handles malformed envelopes safely", () => {
    expect(safe(() => previewImport(null, {}))).toBe(true);
    expect(safe(() => previewImport({ schema_version: V, nodes: "not-an-array" }, {}))).toBe(true);
    expect(safe(() => previewImport({ schema_version: V, nodes: [{ hostname: "no-cid" }, null, { canonical_id: "node:x", hostname: "x" }] }, {}))).toBe(true);
  });
  it("scorePlacement handles a node with no documented fields", () => {
    expect(safe(() => scorePlacement({ id: "w1", name: "w1", ram_requirement_gb: 8 }, { id: "n1", hostname: "n1" }, { workloads: [{ id: "w1" }] }))).toBe(true);
    const res = scorePlacement({ id: "w1", name: "w1", ram_requirement_gb: 8 }, { id: "n1", hostname: "n1" }, { workloads: [{ id: "w1" }] });
    expect(res.eligibility).toBe("unknown");
  });
  it("detectCycles handles malformed dependency entries", () => {
    expect(safe(() => detectCycles([null, { id: "d", source_type: "workload", source_id: null, target_type: "workload", target_id: "A" }, { id: "d2", source_type: "workload", source_id: "A", target_id: "A" }]))).toBe(true);
  });
});

describe("order independence (property-style)", () => {
  it("health findings are order-independent across shuffled entity arrays", () => {
    const mk = (order) => base({ Workload: order.map((i) => ({ id: `w${i}`, name: `w${i}`, current_host: i % 2 ? "ghost" : null })) });
    const a = runHealthChecks(mk([1, 2, 3, 4, 5])).map((f) => f.code).sort();
    const b = runHealthChecks(mk([5, 4, 3, 2, 1])).map((f) => f.code).sort();
    expect(a).toEqual(b);
  });
  it("random candidate order yields the same placement recommendation", () => {
    const wl = { id: "w1", name: "w1", ram_requirement_gb: 8, availability_requirement: "best_effort" };
    const mk = (ram, idle) => ({ id: "n_" + ram, hostname: "n_" + ram, ram_capacity_gb: ram, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: idle });
    const nodes = [mk(64, 10), mk(32, 50), mk(16, 200), mk(128, 40), mk(8, 300)];
    const tops = [];
    for (let seed = 0; seed < 8; seed++) {
      const shuffled = [...nodes].sort(() => (seed * 7) % 3 - 1);
      const ranked = shuffled.map((n) => ({ n, r: scorePlacement(wl, n, { workloads: [wl] }) })).sort((a, b) => String(a.r.rankKey).localeCompare(String(b.r.rankKey)));
      tops.push(ranked[0].n.id);
    }
    expect(new Set(tops).size).toBe(1); // same winner regardless of input order
  });
});