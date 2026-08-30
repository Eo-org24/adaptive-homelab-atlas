import { describe, it, expect } from "vitest";
import { runHealthChecks } from "@/lib/healthEngine";

// Table-driven finding matrix: one positive + one negative fixture per finding code.
// Asserts the structured code (not prose) appears in the positive and not in the negative.

const base = (extra = {}) => ({
  Node: [], ExecutionEnvironment: [], Workload: [], Dependency: [], Maintenance: [],
  Task: [], StorageDevice: [], StoragePool: [], NetworkDevice: [], PlannedChange: [],
  Decision: [], ...extra,
});
const codes = (data) => runHealthChecks(base(data)).map((f) => f.code);
const N = (id, o = {}) => ({ id, hostname: id, ...o });
const E = (id, o = {}) => ({ id, name: id, ...o });
const W = (id, o = {}) => ({ id, name: id, criticality: "medium", lifecycle: "active", ...o });

const FOUR_CRITICAL = [1, 2, 3, 4].map((i) => W("w" + i, { criticality: "high", current_host: "n1" }));

const CASES = [
  // ---- relationship ----
  ["DANGLING_HOST_REF", { Workload: [W("w1", { current_host: "ghost" })] }, { Node: [N("n1")], Workload: [W("w1", { current_host: "n1" })] }],
  ["DANGLING_ENV_REF", { Workload: [W("w1", { current_environment: "ghost" })] }, { ExecutionEnvironment: [E("e1", { current_host: "n1" })], Node: [N("n1")], Workload: [W("w1", { current_environment: "e1" })] }],
  ["DANGLING_PREFERRED_REF", { Workload: [W("w1", { preferred_node: "ghost" })] }, { Node: [N("n1")], Workload: [W("w1", { preferred_node: "n1" })] }],
  ["DANGLING_ELIGIBLE_REF", { Workload: [W("w1", { eligible_alternative_nodes: ["ghost"] })] }, { Node: [N("n1")], Workload: [W("w1", { eligible_alternative_nodes: ["n1"] })] }],
  ["DEP_SOURCE_MISSING", { Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "ghost", target_id: "w2", kind: "hard" }] }, { Workload: [W("w1"), W("w2")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "w1", target_id: "w2", kind: "hard" }] }],
  ["DEP_TARGET_MISSING", { Workload: [W("w1")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "w1", target_id: "ghost", kind: "hard" }] }, { Workload: [W("w1"), W("w2")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "w1", target_id: "w2", kind: "hard" }] }],
  ["MAINT_TARGET_MISSING", { Maintenance: [{ id: "m1", type: "repair", target_type: "node", target_id: "ghost" }] }, { Node: [N("n1")], Maintenance: [{ id: "m1", type: "repair", target_type: "node", target_id: "n1" }] }],
  ["TASK_REF_MISSING", { Task: [{ id: "t1", task: "x", related_object_type: "node", related_object_id: "ghost" }] }, { Node: [N("n1")], Task: [{ id: "t1", task: "x", related_object_type: "node", related_object_id: "n1" }] }],
  ["ORPHANED_ENV", { ExecutionEnvironment: [E("e1")] }, { Node: [N("n1")], ExecutionEnvironment: [E("e1", { current_host: "n1" })] }],
  ["POOL_MISSING_DEVICE", { StoragePool: [{ id: "p1", name: "p1", device_ids: ["ghostdev"] }] }, { StorageDevice: [{ id: "s1", model: "s" }], StoragePool: [{ id: "p1", name: "p1", device_ids: ["s1"] }] }],
  // ---- identity ----
  ["DUPLICATE_CANONICAL_ID", { Node: [N("n1", { canonical_id: "node:x" }), N("n2", { canonical_id: "node:x" })] }, { Node: [N("n1", { canonical_id: "node:x" }), N("n2", { canonical_id: "node:y" })] }],
  // ---- capacity ----
  ["NODE_CPU_OVERSUBSCRIBED", { Node: [N("n1", { logical_cpus: 8 })], ExecutionEnvironment: [E("e1", { current_host: "n1", cpu_allocation: 100 })] }, { Node: [N("n1", { logical_cpus: 8 })], ExecutionEnvironment: [E("e1", { current_host: "n1", cpu_allocation: 4 })] }],
  ["NODE_RAM_OVERSUBSCRIBED", { Node: [N("n1", { ram_capacity_gb: 16 })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 100 })] }, { Node: [N("n1", { ram_capacity_gb: 16 })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 8 })] }],
  ["NODE_STORAGE_OVERSUBSCRIBED", { Node: [N("n1")], Workload: [W("w1", { current_host: "n1", storage_requirement_gb: 1000 })], StoragePool: [{ id: "p1", name: "p1", node: "n1", usable_capacity_gb: 100, state: "active" }] }, { Node: [N("n1")], Workload: [W("w1", { current_host: "n1", storage_requirement_gb: 10 })], StoragePool: [{ id: "p1", name: "p1", node: "n1", usable_capacity_gb: 100, state: "active" }] }],
  ["ENV_CPU_OVERSUBSCRIBED", { ExecutionEnvironment: [E("e1", { cpu_allocation: 2 })], Workload: [W("w1", { current_environment: "e1", cpu_requirement: 4 })] }, { ExecutionEnvironment: [E("e1", { cpu_allocation: 8 })], Workload: [W("w1", { current_environment: "e1", cpu_requirement: 4 })] }],
  ["ENV_RAM_OVERSUBSCRIBED", { ExecutionEnvironment: [E("e1", { ram_allocation_gb: 2 })], Workload: [W("w1", { current_environment: "e1", ram_requirement_gb: 4 })] }, { ExecutionEnvironment: [E("e1", { ram_allocation_gb: 8 })], Workload: [W("w1", { current_environment: "e1", ram_requirement_gb: 4 })] }],
  ["ENV_STORAGE_OVERSUBSCRIBED", { ExecutionEnvironment: [E("e1", { storage_allocation_gb: 2 })], Workload: [W("w1", { current_environment: "e1", storage_requirement_gb: 4 })] }, { ExecutionEnvironment: [E("e1", { storage_allocation_gb: 8 })], Workload: [W("w1", { current_environment: "e1", storage_requirement_gb: 4 })] }],
  ["WORKLOAD_PLACEMENT_UNRESOLVED", { Workload: [W("w1")] }, { Node: [N("n1")], Workload: [W("w1", { current_host: "n1" })] }],
  ["MISSING_REQUIRED_GPU", { Node: [N("n1", { gpus: [], gpu_vram_gb: 0 })], Workload: [W("w1", { current_host: "n1", gpu_vram_requirement_gb: 8 })] }, { Node: [N("n1", { gpus: ["rtx"], gpu_vram_gb: 16 })], Workload: [W("w1", { current_host: "n1", gpu_vram_requirement_gb: 8 })] }],
  ["GPU_VRAM_INSUFFICIENT", { Node: [N("n1", { gpus: ["x"], gpu_vram_gb: 8 })], Workload: [W("w1", { current_host: "n1", gpu_vram_requirement_gb: 16 })] }, { Node: [N("n1", { gpus: ["x"], gpu_vram_gb: 32 })], Workload: [W("w1", { current_host: "n1", gpu_vram_requirement_gb: 16 })] }],
  ["UNKNOWN_REQUIRED_CAPACITY", { Node: [N("n1")], Workload: [W("w1", { current_host: "n1", ram_requirement_gb: 4 })] }, { Node: [N("n1", { ram_capacity_gb: 16 })], Workload: [W("w1", { current_host: "n1", ram_requirement_gb: 4 })] }],
  // ---- dependency ----
  ["DEP_CYCLE", { Workload: [W("A"), W("B")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }, { id: "d2", source_type: "workload", target_type: "workload", source_id: "B", target_id: "A", kind: "hard" }] }, { Workload: [W("A"), W("B")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }],
  ["CRITICALITY_INVERSION", { Workload: [W("A", { criticality: "high" }), W("B", { criticality: "low" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }, { Workload: [W("A", { criticality: "low" }), W("B", { criticality: "high" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }],
  // ---- lifecycle ----
  ["DEP_ON_RETIRED", { Workload: [W("A"), W("B", { lifecycle: "retired" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }, { Workload: [W("A"), W("B", { lifecycle: "active" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }],
  ["DEP_ON_DEGRADED", { Workload: [W("A"), W("B", { lifecycle: "degraded" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }, { Workload: [W("A"), W("B", { lifecycle: "active" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }],
  ["ACTIVE_IN_RETIRED_ENV", { ExecutionEnvironment: [E("e1", { lifecycle: "retired" })], Workload: [W("w1", { current_environment: "e1" })] }, { ExecutionEnvironment: [E("e1", { lifecycle: "active" })], Workload: [W("w1", { current_environment: "e1" })] }],
  // ---- availability / SPOF ----
  ["SPOF_CONCENTRATION", { Node: [N("n1", { lifecycle_state: "active", availability_expectation: "best_effort" })], Workload: FOUR_CRITICAL }, { Node: [N("n1", { lifecycle_state: "active", availability_expectation: "best_effort" })], Workload: [W("w1", { criticality: "high", current_host: "n1" })] }],
  ["SPOF_CRITICAL_DEP_WEAK", { Workload: [W("A", { criticality: "critical" }), W("B", { availability_requirement: "best_effort" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }] }, { Workload: [W("A", { criticality: "critical" }), W("B", { availability_requirement: "best_effort" })], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "optional" }] }],
  ["ALWAYS_ON_NON_ALWAYS_ON", { Node: [N("n1", { availability_expectation: "best_effort" })], Workload: [W("w1", { current_host: "n1", availability_requirement: "always_on" })] }, { Node: [N("n1", { availability_expectation: "always_on" })], Workload: [W("w1", { current_host: "n1", availability_requirement: "always_on" })] }],
  // ---- state ----
  ["RECONSTRUCTABLE_NO_BACKUP", { ExecutionEnvironment: [E("e1", { current_host: "n1", persistent_state: true })], Node: [N("n1")], Workload: [W("w1", { current_environment: "e1", reconstructable: true })] }, { ExecutionEnvironment: [E("e1", { current_host: "n1", persistent_state: true })], Node: [N("n1")], Workload: [W("w1", { current_environment: "e1", reconstructable: true, backup_requirement: "daily" })] }],
  ["RECONSTRUCTABLE_PERSISTENT", { ExecutionEnvironment: [E("e1", { current_host: "n1", persistent_state: true })], Node: [N("n1")], Workload: [W("w1", { current_environment: "e1", reconstructable: true, backup_requirement: "daily" })] }, { ExecutionEnvironment: [E("e1", { current_host: "n1", persistent_state: false })], Node: [N("n1")], Workload: [W("w1", { current_environment: "e1", reconstructable: true })] }],
  ["ACTIVE_NO_REALIZATION", { Workload: [W("w1")] }, { Node: [N("n1")], Workload: [W("w1", { current_host: "n1" })] }],
  ["RETIRED_STILL_REALIZED", { Workload: [W("w1", { lifecycle: "retired", current_host: "n1" })] }, { Workload: [W("w1", { lifecycle: "retired" })] }],
  // ---- provenance ----
  ["CRITICAL_UNKNOWN_PROVENANCE", { Workload: [W("w1", { criticality: "critical", state_classification: "sample" })] }, { Workload: [W("w1", { criticality: "critical", state_classification: "documented" })] }],
  ["PLANNED_AS_CURRENT", { Workload: [W("w1", { state_classification: "planned" })] }, { Workload: [W("w1", { state_classification: "documented" })] }],
  ["NO_OBSERVATION", { Workload: [W("w1", { state_classification: "observed" })] }, { Workload: [W("w1", { state_classification: "observed", observed_at: new Date().toISOString() })] }],
  ["STALE_OBSERVATION", { Workload: [W("w1", { state_classification: "observed", observed_at: new Date(Date.now() - 200 * 86400000).toISOString() })] }, { Workload: [W("w1", { state_classification: "observed", observed_at: new Date().toISOString() })] }],
  ["SAMPLE_DATA", { Workload: [W("w1", { state_classification: "sample" })] }, { Workload: [W("w1", { state_classification: "documented" })] }],
  // ---- data quality ----
  ["CANONICAL_MISSING_ID", { Node: [N("n1", { source_kind: "canonical" })] }, { Node: [N("n1", { source_kind: "canonical", canonical_id: "node:n1" })] }],
  ["CANONICAL_UNRESOLVED_REF", { Workload: [W("w1", { source_kind: "canonical", canonical_id: "workload:w1", current_environment: "ghost" })] }, { ExecutionEnvironment: [E("e1", { current_host: "n1" })], Node: [N("n1")], Workload: [W("w1", { source_kind: "canonical", canonical_id: "workload:w1", current_environment: "e1" })] }],
  // ---- change risk ----
  ["CHANGE_NO_ROLLBACK", { PlannedChange: [{ id: "c1", title: "c1", status: "accepted" }] }, { PlannedChange: [{ id: "c1", title: "c1", status: "accepted", rollback_strategy: "revert" }] }],
  ["HIGH_RISK_NO_PREREQ", { PlannedChange: [{ id: "c1", title: "c1", status: "ready", risk: "high" }] }, { PlannedChange: [{ id: "c1", title: "c1", status: "ready", risk: "high", prerequisites: "snap" }] }],
  // ---- source-aware ----
  ["LOCAL_OVERRIDE_ON_CANONICAL", { Node: [N("n1", { canonical_id: "node:n1", source_kind: "canonical", field_provenance: JSON.stringify({ ram_capacity_gb: { local: 128 } }) })] }, { Node: [N("n1", { canonical_id: "node:n1", source_kind: "canonical" })] }],
  ["CANONICAL_SOURCE_STALE", { Node: [N("n1", { canonical_id: "node:n1", source_kind: "canonical", imported_at: new Date(Date.now() - 200 * 86400000).toISOString() })] }, { Node: [N("n1", { canonical_id: "node:n1", source_kind: "canonical", imported_at: new Date().toISOString() })] }],
  ["SAMPLE_DATA_IN_ACTIVE_ARCHITECTURE", { Workload: [W("w1", { state_classification: "sample", lifecycle: "active" })] }, { Workload: [W("w1", { state_classification: "sample", lifecycle: "retired" })] }],
  ["INFERRED_LOW_CONFIDENCE", { Workload: [W("w1", { criticality: "critical", state_classification: "inferred", confidence: 0.3 })] }, { Workload: [W("w1", { criticality: "critical", state_classification: "inferred", confidence: 0.8 })] }],
];

describe("finding engine: positive + negative fixtures per code", () => {
  CASES.forEach(([code, pos, neg]) => {
    it(code + ": triggers on positive fixture", () => {
      expect(codes(pos)).toContain(code);
    });
    it(code + ": does NOT trigger on negative fixture", () => {
      expect(codes(neg)).not.toContain(code);
    });
  });
});

describe("finding engine: structural invariants", () => {
  it("every finding has the required structured fields", () => {
    const data = base({ Workload: [W("w1", { current_host: "ghost" })] });
    runHealthChecks(data).forEach((f) => {
      expect(f).toHaveProperty("code");
      expect(f).toHaveProperty("severity");
      expect(f).toHaveProperty("category");
      expect(f).toHaveProperty("affected_type");
      expect(f).toHaveProperty("affected_id");
      expect(f).toHaveProperty("data_sufficient");
      expect(f).toHaveProperty("confidence");
      expect(["critical", "error", "warning", "info"]).toContain(f.severity);
    });
  });
  it("findings are deterministic (same input -> same codes, same order)", () => {
    const data = base({ Node: [N("n1", { logical_cpus: 8 })], ExecutionEnvironment: [E("e1", { current_host: "n1", cpu_allocation: 100 })], Workload: [W("w1", { current_host: "ghost" })] });
    const a = runHealthChecks(data).map((f) => f.code + "|" + f.severity + "|" + f.affected_id);
    const b = runHealthChecks(data).map((f) => f.code + "|" + f.severity + "|" + f.affected_id);
    expect(a).toEqual(b);
  });
  it("clean data produces no findings", () => {
    const data = base({ Node: [N("n1", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort" })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 16, cpu_allocation: 4 })], Workload: [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 4, cpu_requirement: 1, criticality: "medium", state_classification: "documented" })] });
    expect(runHealthChecks(data)).toEqual([]);
  });
});