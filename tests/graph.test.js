import { describe, it, expect } from "vitest";
import { physicalGraph, executionGraph, storageGraph, dependencyGraph, changeGraph } from "@/lib/graph";

const N = (id, o = {}) => ({ id, hostname: id, ...o });
const E = (id, o = {}) => ({ id, name: id, ...o });
const W = (id, o = {}) => ({ id, name: id, ...o });
const base = (extra = {}) => ({
  Node: [], ExecutionEnvironment: [], Workload: [], Dependency: [], Maintenance: [],
  Task: [], StorageDevice: [], StoragePool: [], NetworkDevice: [], PlannedChange: [],
  Decision: [], ...extra,
});

describe("physical / execution graph", () => {
  it("edges come from real relationships (env host + workload env)", () => {
    const data = base({ Node: [N("n1")], ExecutionEnvironment: [E("e1", { current_host: "n1" })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const g = executionGraph(data);
    expect(g.edges.some((e) => e.type === "hosts" && e.source === "node:n1" && e.target === "env:e1")).toBe(true);
    expect(g.edges.some((e) => e.type === "executes" && e.source === "env:e1" && e.target === "workload:w1")).toBe(true);
  });
  it("no phantom edge from display-name similarity", () => {
    const data = base({ Node: [N("n1")], ExecutionEnvironment: [E("n1", { current_host: null })] }); // env named "n1" like the node, but no host relationship
    const g = executionGraph(data);
    expect(g.edges.some((e) => e.source === "node:n1")).toBe(false);
  });
  it("deleted relationship disappears (no edge when env has no host)", () => {
    const data = base({ Node: [N("n1")], ExecutionEnvironment: [E("e1", { current_host: null })] });
    expect(executionGraph(data).edges).toHaveLength(0);
  });
  it("canonical_id is preserved in graph node metadata", () => {
    const data = base({ Node: [N("n1", { canonical_id: "node:rig9" })] });
    const g = physicalGraph(data);
    expect(g.nodes.find((n) => n.kind === "node").canonical_id).toBe("node:rig9");
  });
  it("graph derivation does not mutate input records", () => {
    const data = base({ Node: [N("n1")], ExecutionEnvironment: [E("e1", { current_host: "n1" })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const snap = JSON.stringify(data);
    physicalGraph(data); executionGraph(data); dependencyGraph(data); storageGraph(data);
    expect(JSON.stringify(data)).toBe(snap);
  });
});

describe("storage graph", () => {
  it("builds node -> pool -> device edges", () => {
    const data = base({ Node: [N("n1")], StoragePool: [{ id: "p1", name: "p1", node: "n1", device_ids: ["d1"] }], StorageDevice: [{ id: "d1", model: "ssd", current_node: "n1" }] });
    const g = storageGraph(data);
    expect(g.edges.some((e) => e.type === "hosts-pool" && e.source === "node:n1" && e.target === "pool:p1")).toBe(true);
    expect(g.edges.some((e) => e.type === "includes" && e.source === "pool:p1" && e.target === "storage:d1")).toBe(true);
  });
});

describe("dependency graph", () => {
  it("flags nodes in a cycle", () => {
    const data = base({ Workload: [W("A"), W("B")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }, { id: "d2", source_type: "workload", target_type: "workload", source_id: "B", target_id: "A", kind: "hard" }] });
    const g = dependencyGraph(data);
    const cycled = g.nodes.filter((n) => (n.flags || []).includes("cycle"));
    expect(cycled.length).toBe(2);
  });
  it("remains finite on a cycle (no infinite recursion)", () => {
    const data = base({ Workload: [W("A"), W("B"), W("C")], Dependency: [{ id: "d1", source_type: "workload", target_type: "workload", source_id: "A", target_id: "B", kind: "hard" }, { id: "d2", source_type: "workload", target_type: "workload", source_id: "B", target_id: "C", kind: "hard" }, { id: "d3", source_type: "workload", target_type: "workload", source_id: "C", target_id: "A", kind: "hard" }] });
    expect(() => dependencyGraph(data)).not.toThrow();
    const g = dependencyGraph(data);
    expect(g.nodes.length).toBe(3);
  });
});

describe("change graph", () => {
  it("produces expected added/removed edge sets without mutating current data", () => {
    const data = base({ Node: [N("n1"), N("n2")], ExecutionEnvironment: [E("e1", { current_host: "n1" }), E("e2", { current_host: "n2" })], Workload: [W("w1", { current_environment: "e1", current_host: "n1" })] });
    const snap = JSON.stringify(data);
    const g = changeGraph(data, { operations: [{ type: "MOVE_WORKLOAD", workload_id: "w1", to_environment_id: "e2" }] });
    expect(g.edges.some((e) => e.status === "removed" && e.target === "workload:w1")).toBe(true);
    expect(g.edges.some((e) => e.status === "added" && e.source === "env:e2" && e.target === "workload:w1")).toBe(true);
    expect(JSON.stringify(data)).toBe(snap);
  });
});