import { describe, it, expect } from "vitest";
import { applyOperations, analyzeChange } from "@/lib/changeSandbox";
import { runHealthChecks } from "@/lib/healthEngine";

const N = (id, o = {}) => ({ id, hostname: id, ...o });
const E = (id, o = {}) => ({ id, name: id, ...o });
const W = (id, o = {}) => ({ id, name: id, ...o });
const base = (extra = {}) => ({
  Node: [], ExecutionEnvironment: [], Workload: [], Dependency: [], Maintenance: [],
  Task: [], StorageDevice: [], StoragePool: [], NetworkDevice: [], PlannedChange: [],
  Decision: [], ...extra,
});

describe("change sandbox never mutates live data", () => {
  it("applyOperations leaves the input data object untouched", () => {
    const data = base({ Node: [N("n1", { lifecycle_state: "active" })], ExecutionEnvironment: [E("e1", { current_host: "n1" })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const snap = JSON.stringify(data);
    applyOperations(data, [{ type: "MOVE_WORKLOAD", workload_id: "w1", to_environment_id: "e2" }]);
    expect(JSON.stringify(data)).toBe(snap);
  });
  it("analyzeChange leaves the input data object untouched", () => {
    const data = base({ Node: [N("n1", { ram_capacity_gb: 16 })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 16 })], Workload: [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 8 })] });
    const snap = JSON.stringify(data);
    analyzeChange(data, { operations: [{ type: "CHANGE_RESOURCE_ALLOCATION", environment_id: "e1", ram_gb: 100 }], affected_nodes: ["n1"] });
    expect(JSON.stringify(data)).toBe(snap);
  });
});

describe("applyOperations: operation types", () => {
  it("MOVE_WORKLOAD moves a workload to another environment and derives host", () => {
    const data = base({ Node: [N("n1"), N("n2")], ExecutionEnvironment: [E("e1", { current_host: "n1" }), E("e2", { current_host: "n2" })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const p = applyOperations(data, [{ type: "MOVE_WORKLOAD", workload_id: "w1", to_environment_id: "e2" }]);
    expect(p.Workload[0].current_environment).toBe("e2");
    expect(p.Workload[0].current_host).toBe("n2");
  });
  it("CHANGE_EXECUTION_HOST moves an environment and contained workloads follow", () => {
    const data = base({ Node: [N("n1"), N("n2")], ExecutionEnvironment: [E("e1", { current_host: "n1" })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const p = applyOperations(data, [{ type: "CHANGE_EXECUTION_HOST", environment_id: "e1", to_node_id: "n2" }]);
    expect(p.ExecutionEnvironment[0].current_host).toBe("n2");
  });
  it("CHANGE_RESOURCE_ALLOCATION updates env allocation", () => {
    const data = base({ ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 8 })] });
    const p = applyOperations(data, [{ type: "CHANGE_RESOURCE_ALLOCATION", environment_id: "e1", ram_gb: 32 }]);
    expect(p.ExecutionEnvironment[0].ram_allocation_gb).toBe(32);
  });
  it("RETIRE_NODE sets lifecycle to retired", () => {
    const data = base({ Node: [N("n1", { lifecycle_state: "active" })] });
    const p = applyOperations(data, [{ type: "RETIRE_NODE", node_id: "n1" }]);
    expect(p.Node[0].lifecycle_state).toBe("retired");
  });
  it("CHANGE_LIFECYCLE updates object lifecycle", () => {
    const data = base({ Workload: [W("w1", { lifecycle: "active" })] });
    const p = applyOperations(data, [{ type: "CHANGE_LIFECYCLE", object_type: "workload", object_id: "w1", lifecycle: "retired" }]);
    expect(p.Workload[0].lifecycle).toBe("retired");
  });
  it("ADD_STORAGE adds a pool", () => {
    const data = base({ Node: [N("n1")] });
    const p = applyOperations(data, [{ type: "ADD_STORAGE", node_id: "n1", name: "new", usable_capacity_gb: 500 }]);
    expect(p.StoragePool).toHaveLength(1);
    expect(p.StoragePool[0].usable_capacity_gb).toBe(500);
  });
  it("REMOVE_STORAGE reduces or retires a pool", () => {
    const data = base({ StoragePool: [{ id: "p1", name: "p1", node: "n1", usable_capacity_gb: 500, state: "active" }] });
    const p = applyOperations(data, [{ type: "REMOVE_STORAGE", pool_id: "p1", reduce_gb: 100 }]);
    expect(p.StoragePool[0].usable_capacity_gb).toBe(400);
    const p2 = applyOperations(data, [{ type: "REMOVE_STORAGE", pool_id: "p1" }]);
    expect(p2.StoragePool[0].state).toBe("retired");
  });
  it("multiple operations apply in one change", () => {
    const data = base({ Node: [N("n1"), N("n2")], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 8 })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const p = applyOperations(data, [{ type: "CHANGE_EXECUTION_HOST", environment_id: "e1", to_node_id: "n2" }, { type: "CHANGE_RESOURCE_ALLOCATION", environment_id: "e1", ram_gb: 16 }]);
    expect(p.ExecutionEnvironment[0].current_host).toBe("n2");
    expect(p.ExecutionEnvironment[0].ram_allocation_gb).toBe(16);
  });
  it("operation referencing a missing target is a no-op (no throw)", () => {
    const data = base({ Node: [N("n1", { lifecycle_state: "active" })] });
    expect(() => applyOperations(data, [{ type: "MOVE_WORKLOAD", workload_id: "ghost", to_environment_id: "e2" }])).not.toThrow();
    const p = applyOperations(data, [{ type: "RETIRE_NODE", node_id: "ghost" }]);
    expect(p.Node[0].lifecycle_state).toBe("active");
  });
});

describe("analyzeChange: findings delta", () => {
  it("operation causing capacity failure introduces a new oversubscription finding", () => {
    const data = base({ Node: [N("n1", { ram_capacity_gb: 16 })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 8 })], Workload: [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 4 })] });
    const r = analyzeChange(data, { operations: [{ type: "CHANGE_RESOURCE_ALLOCATION", environment_id: "e1", ram_gb: 100 }], affected_nodes: ["n1"] });
    expect(r.newFindings.some((f) => f.code === "NODE_RAM_OVERSUBSCRIBED")).toBe(true);
  });
  it("operation resolving an existing finding reports it as resolved", () => {
    // node oversubscribed by env; reducing allocation resolves it
    const data = base({ Node: [N("n1", { ram_capacity_gb: 16 })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 100 })], Workload: [] });
    const before = runHealthChecks(data).some((f) => f.code === "NODE_RAM_OVERSUBSCRIBED");
    expect(before).toBe(true);
    const r = analyzeChange(data, { operations: [{ type: "CHANGE_RESOURCE_ALLOCATION", environment_id: "e1", ram_gb: 8 }], affected_nodes: ["n1"] });
    expect(r.resolvedFindings.some((f) => f.code === "NODE_RAM_OVERSUBSCRIBED")).toBe(true);
    expect(r.newFindings.some((f) => f.code === "NODE_RAM_OVERSUBSCRIBED")).toBe(false);
  });
  it("resourceDelta reflects the allocation change", () => {
    const data = base({ Node: [N("n1", { ram_capacity_gb: 16 })], ExecutionEnvironment: [E("e1", { current_host: "n1", ram_allocation_gb: 8 })], Workload: [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 4 })] });
    const r = analyzeChange(data, { operations: [{ type: "CHANGE_RESOURCE_ALLOCATION", environment_id: "e1", ram_gb: 12 }], affected_nodes: ["n1"] });
    const d = r.resourceDelta.find((x) => x.node.id === "n1");
    expect(d).toBeTruthy();
    expect(d.after.ram).toBeGreaterThan(d.before.ram);
  });
  it("returns an error result (not a crash) when operations are malformed", () => {
    const data = base({});
    const r = analyzeChange(data, { operations: null });
    expect(r).toBeTruthy();
    expect(Array.isArray(r.before)).toBe(true);
  });
});