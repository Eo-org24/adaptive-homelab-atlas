import { describe, it, expect } from "vitest";
import { workloadPhysicalNode, nodeHostedWorkloads, findReferences, resolveRef, buildLookups } from "@/lib/relationships";

const N = (id) => ({ id, hostname: id });
const E = (id, host) => ({ id, name: id, current_host: host || null });
const W = (id, env, host) => ({ id, name: id, current_environment: env || null, current_host: host || null });

describe("workload → environment → node authority", () => {
  it("environment host move changes all contained workloads' physical realization", () => {
    const nodes = [N("nA"), N("nB")];
    const envs = [E("e1", "nA")];
    const wl = W("w1", "e1", "nA");
    expect(workloadPhysicalNode(wl, envs, nodes).id).toBe("nA");
    // move env to nB
    const envs2 = [E("e1", "nB")];
    expect(workloadPhysicalNode(wl, envs2, nodes).id).toBe("nB");
  });

  it("legacy current_host fallback works only when environment relationship is unavailable", () => {
    const nodes = [N("nA")];
    const wl = W("w1", null, "nA"); // no env
    expect(workloadPhysicalNode(wl, [], nodes).id).toBe("nA");
  });

  it("conflicting legacy current_host + environment host: environment wins", () => {
    const nodes = [N("nA"), N("nB")];
    const envs = [E("e1", "nB")];
    const wl = W("w1", "e1", "nA"); // stale current_host says nA, env says nB
    expect(workloadPhysicalNode(wl, envs, nodes).id).toBe("nB");
  });

  it("deleted environment makes the workload explicitly unresolved (not silently attached elsewhere)", () => {
    const nodes = [N("nA"), N("nB")];
    const wl = W("w1", "e1", "nA"); // env e1 no longer exists, stale host nA
    expect(workloadPhysicalNode(wl, [], nodes)).toBe(null);
  });

  it("environment with no host yields unresolved (no fallback to legacy host)", () => {
    const nodes = [N("nA")];
    const envs = [E("e1", null)];
    const wl = W("w1", "e1", "nA");
    expect(workloadPhysicalNode(wl, envs, nodes)).toBe(null);
  });
});

describe("nodeHostedWorkloads", () => {
  it("includes env-hosted and legacy direct-hosted, excludes env-hosted-elsewhere", () => {
    const envs = [E("e1", "nA"), E("e2", "nB")];
    const wls = [W("w1", "e1", "nA"), W("w2", "e2", "nA"), W("w3", null, "nA"), W("w4", "e1", "nB")];
    // w4 has a stale current_host=nB but its env e1 is on nA -> env-authoritative => hosted on nA
    const onA = nodeHostedWorkloads(N("nA"), wls, envs);
    expect(onA.map((w) => w.id).sort()).toEqual(["w1", "w3", "w4"]);
  });
});

describe("findReferences (delete safety)", () => {
  it("finds workloads referencing a node via env and directly", () => {
    const data = {
      Node: [N("n1")],
      ExecutionEnvironment: [E("e1", "n1")],
      Workload: [W("w1", "e1", "n1"), W("w2", null, "n1")],
    };
    const refs = findReferences("Node", "n1", data);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.some((r) => r.from_id === "e1" && r.field === "current_host")).toBe(true);
    expect(refs.some((r) => r.from_id === "w1" && r.field === "current_host")).toBe(true);
  });
  it("finds dependencies referencing a workload", () => {
    const data = { Workload: [{ id: "w1", name: "w1" }], Dependency: [{ id: "d1", source_type: "workload", source_id: "w1", target_type: "workload", target_id: "w2" }] };
    const refs = findReferences("Workload", "w1", data);
    expect(refs.some((r) => r.field === "source_id")).toBe(true);
  });
  it("returns empty when nothing references the target", () => {
    expect(findReferences("Node", "ghost", { Workload: [], ExecutionEnvironment: [] })).toEqual([]);
  });
});

describe("resolveRef", () => {
  it("resolves by canonical_id first, then internal id", () => {
    const lookups = buildLookups({ Node: [{ id: "n1", canonical_id: "node:rig9", hostname: "rig9" }] });
    expect(resolveRef("Node", "node:rig9", lookups).id).toBe("n1");
    expect(resolveRef("Node", "n1", lookups).id).toBe("n1");
    expect(resolveRef("Node", "ghost", lookups)).toBe(null);
  });
});