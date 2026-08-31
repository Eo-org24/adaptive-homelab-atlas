// First Adaptive Homelab Crossover — regression tests for the frozen V1 producer contract.
// Exercises the REAL Atlas canonical importer (src/lib/canonicalImport.js) against the
// golden `homelab-foundation` / `hlctl` artifact, using an isolated in-memory dataset
// (the preferred "isolated test environment" so the crossover never pollutes live data).
import { describe, it, expect } from "vitest";
import { previewImport, runImport, createMemoryAdapter, GOLDEN_CROSSOVER } from "@/lib/canonicalImport";
import { placementGraph, executionGraph } from "@/lib/graph";
import { runHealthChecks } from "@/lib/healthEngine";
import { isFixture, isOperational } from "@/lib/provenance";

const ARTIFACT = JSON.parse(GOLDEN_CROSSOVER);

// Reverse-ordered copy to prove entity/relationship order does not matter.
const REVERSED = {
  ...ARTIFACT,
  entities: [...ARTIFACT.entities].reverse(),
  relationships: [...ARTIFACT.relationships].reverse(),
};

async function freshImport(artifact, initial = {}) {
  const adapter = createMemoryAdapter(initial);
  const data = {};
  for (const k of ["Node", "ExecutionEnvironment", "Workload"]) data[k] = await adapter.listAll(k);
  const first = await runImport(artifact, data, { adapter });
  const data2 = {};
  for (const k of ["Node", "ExecutionEnvironment", "Workload"]) data2[k] = await adapter.listAll(k);
  const second = await runImport(artifact, data2, { adapter });
  const data3 = {};
  for (const k of ["Node", "ExecutionEnvironment", "Workload"]) data3[k] = await adapter.listAll(k);
  return { adapter, first, second, data: data3 };
}

describe("crossover: artifact validation (§1, §10)", () => {
  it("parses the unified entities[] + relationships[] envelope", () => {
    const r = previewImport(ARTIFACT, {});
    expect(r.counts.created).toBe(3);
    expect(r.counts.failed).toBe(0);
  });
  it("rejects an unknown top-level field", () => {
    const bad = { ...ARTIFACT, surprise: 1 };
    const r = previewImport(bad, {});
    expect(r.failed.some((f) => /unknown top-level field "surprise"/.test(f.reason))).toBe(true);
  });
  it("rejects an unknown entity kind", () => {
    const bad = { ...ARTIFACT, entities: [...ARTIFACT.entities, { kind: "widget", id: "x" }] };
    const r = previewImport(bad, {});
    expect(r.failed.some((f) => /unknown entity kind "widget"/.test(f.reason))).toBe(true);
  });
  it("rejects an unknown relationship type", () => {
    const bad = { ...ARTIFACT, relationships: [...ARTIFACT.relationships, { source: "node:test-node-1", type: "likes", target: "node:test-node-1" }] };
    const r = previewImport(bad, {});
    expect(r.failed.some((f) => /unknown relationship type "likes"/.test(f.reason))).toBe(true);
  });
  it("rejects a duplicate typed entity identity", () => {
    const bad = { ...ARTIFACT, entities: [...ARTIFACT.entities, { kind: "node", id: "test-node-1" }] };
    const r = previewImport(bad, {});
    expect(r.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(r.conflicts.some((c) => c.canonical_id === "node:test-node-1")).toBe(true);
  });
  it("rejects a duplicate relationship tuple", () => {
    const dup = { ...ARTIFACT, relationships: [...ARTIFACT.relationships, ARTIFACT.relationships[0]] };
    const r = previewImport(dup, {});
    expect(r.conflicts.some((c) => c.kind === "relationship")).toBe(true);
  });
});

describe("crossover: external identity & kind mapping (§2, §3)", () => {
  it("derives canonical_id verbatim as <kind>:<id>", async () => {
    const { data } = await freshImport(ARTIFACT);
    const node = data.Node[0];
    const env = data.ExecutionEnvironment[0];
    const wl = data.Workload[0];
    expect(node.canonical_id).toBe("node:test-node-1");
    expect(env.canonical_id).toBe("execution-provider:test-ep-1");
    expect(wl.canonical_id).toBe("workload:test-wl-1");
  });
  it("maps execution-provider -> ExecutionEnvironment without rewriting the id", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.ExecutionEnvironment).toHaveLength(1);
    expect(data.ExecutionEnvironment[0].canonical_id).toBe("execution-provider:test-ep-1");
  });
});

describe("crossover: relationship mapping (§5, §6)", () => {
  it("hosted_on maps to ExecutionEnvironment.current_host", async () => {
    const { data } = await freshImport(ARTIFACT);
    const env = data.ExecutionEnvironment[0];
    const node = data.Node[0];
    expect(env.current_host).toBe(node.id);
  });
  it("placement_allowed_on_provider maps to eligible_execution_providers", async () => {
    const { data } = await freshImport(ARTIFACT);
    const wl = data.Workload[0];
    const env = data.ExecutionEnvironment[0];
    expect(wl.eligible_execution_providers || []).toContain(env.id);
  });
  it("allowed provider does NOT become current_environment", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Workload[0].current_environment).toBeFalsy();
  });
  it("allowed provider does NOT become current_host / current physical realization", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Workload[0].current_host).toBeFalsy();
  });
  it("resolves relationships independent of entity/relationship order", async () => {
    const a = await freshImport(ARTIFACT);
    const b = await freshImport(REVERSED);
    const envA = a.data.ExecutionEnvironment[0], envB = b.data.ExecutionEnvironment[0];
    const wlA = a.data.Workload[0], wlB = b.data.Workload[0];
    expect(envA.current_host).toBeTruthy();
    expect(envB.current_host).toBeTruthy();
    // Both hosts resolve to the node with canonical_id node:test-node-1.
    const hostCidA = a.data.Node.find((n) => n.id === envA.current_host).canonical_id;
    const hostCidB = b.data.Node.find((n) => n.id === envB.current_host).canonical_id;
    expect(hostCidA).toBe("node:test-node-1");
    expect(hostCidB).toBe("node:test-node-1");
    // Both workloads are placement-eligible on the execution-provider:test-ep-1 env.
    const eligibleCids = (wl, envs) => (wl.eligible_execution_providers || [])
      .map((id) => envs.find((e) => e.id === id)).filter(Boolean).map((e) => e.canonical_id);
    expect(eligibleCids(wlA, a.data.ExecutionEnvironment)).toEqual(["execution-provider:test-ep-1"]);
    expect(eligibleCids(wlB, b.data.ExecutionEnvironment)).toEqual(["execution-provider:test-ep-1"]);
  });
});

describe("crossover: capability declaration & requirement (§7, §8)", () => {
  it("preserves the node capability declaration as structured data", async () => {
    const { data } = await freshImport(ARTIFACT);
    const node = data.Node[0];
    expect(Array.isArray(node.capabilities)).toBe(true);
    expect(node.capabilities[0]).toEqual({ type: "hw-accel", id: "accel0" });
  });
  it("preserves the workload capability requirement as structured data", async () => {
    const { data } = await freshImport(ARTIFACT);
    const wl = data.Workload[0];
    expect(Array.isArray(wl.capability_requirements)).toBe(true);
    expect(wl.capability_requirements[0]).toEqual({ type: "hw-accel", instance: "accel0" });
  });
  it("reports the named-instance requirement as intentionally unresolved", async () => {
    const r = previewImport(ARTIFACT, {});
    expect(r.capability_findings.length).toBe(1);
    expect(r.capability_findings[0].instance).toBe("accel0");
    expect(r.capability_findings[0].resolution).toBe("unresolved");
  });
  it("does not bind the requirement instance to the node capability", async () => {
    const { data } = await freshImport(ARTIFACT);
    // No field on the workload records a resolved capability binding.
    const wl = data.Workload[0];
    expect(wl.resolved_capability).toBeFalsy();
    expect(wl.capability_binding).toBeFalsy();
  });
  it("generates no capability edge in any graph view", async () => {
    const { data } = await freshImport(ARTIFACT);
    for (const g of [placementGraph(data), executionGraph(data)]) {
      expect(g.edges.some((e) => /capability/.test(e.type))).toBe(false);
    }
  });
});

describe("crossover: idempotence — first & second identical import (§11, §12, §13)", () => {
  it("first import creates exactly 3 entities", async () => {
    const { first } = await freshImport(ARTIFACT);
    expect(first.counts.created).toBe(3);
    expect(first.counts.failed).toBe(0);
    expect(first.counts.conflicts).toBe(0);
    expect(first.counts.unresolved).toBe(0);
  });
  it("first import resolves exactly 2 relationships", async () => {
    const { first } = await freshImport(ARTIFACT);
    expect(first.counts.relationships).toBe(2);
  });
  it("second identical import creates 0 and updates 0", async () => {
    const { second } = await freshImport(ARTIFACT);
    expect(second.counts.created).toBe(0);
    expect(second.counts.updated).toBe(0);
    expect(second.counts.unchanged).toBe(3);
  });
  it("second import has 0 duplicates and 0 conflicts", async () => {
    const { second } = await freshImport(ARTIFACT);
    expect(second.counts.conflicts).toBe(0);
    expect(second.counts.relationships).toBe(2); // re-applied, same values — no semantic change
  });
  it("each canonical identity exists exactly once after two imports", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Node.filter((n) => n.canonical_id === "node:test-node-1")).toHaveLength(1);
    expect(data.ExecutionEnvironment.filter((e) => e.canonical_id === "execution-provider:test-ep-1")).toHaveLength(1);
    expect(data.Workload.filter((w) => w.canonical_id === "workload:test-wl-1")).toHaveLength(1);
  });
});

describe("crossover: provenance (§9)", () => {
  it("preserves source_class canonical as source_kind=canonical", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Node[0].source_kind).toBe("canonical");
    expect(data.ExecutionEnvironment[0].source_kind).toBe("canonical");
    expect(data.Workload[0].source_kind).toBe("canonical");
  });
  it("handles source.commit 'unknown' honestly (no fabricated hash)", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Node[0].source_commit).toBe("unknown");
    expect(data.Node[0].last_seen_source_commit).toBe("unknown");
  });
  it("records the content digest in the source note", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Node[0].source_note || "").toContain("sha256:8551fdac");
  });
});

describe("crossover: graph verification (§14)", () => {
  it("placement view shows placement-allowed, never executes", async () => {
    const { data } = await freshImport(ARTIFACT);
    const g = placementGraph(data);
    expect(g.edges.some((e) => e.type === "placement-allowed")).toBe(true);
    expect(g.edges.some((e) => e.type === "executes")).toBe(false);
  });
  it("execution view shows no executes edge for the placement-eligible workload", async () => {
    const { data } = await freshImport(ARTIFACT);
    const g = executionGraph(data);
    const wlId = data.Workload[0].id;
    expect(g.edges.some((e) => e.type === "executes" && e.target === `workload:${wlId}`)).toBe(false);
  });
});

describe("crossover: do not pollute real operational calculations (§18)", () => {
  it("tags fixture records as atlas-crossover-fixture", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(isFixture(data.Node[0])).toBe(true);
    expect(isFixture(data.ExecutionEnvironment[0])).toBe(true);
    expect(isFixture(data.Workload[0])).toBe(true);
  });
  it("fixture records are not operational", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(isOperational(data.Node[0])).toBe(false);
    expect(isOperational(data.ExecutionEnvironment[0])).toBe(false);
    expect(isOperational(data.Workload[0])).toBe(false);
  });
  it("health engine excludes fixture node from capacity findings", async () => {
    const { data } = await freshImport(ARTIFACT);
    const findings = runHealthChecks(data);
    const fixtureNodeFindings = findings.filter((f) => f.affected_id === data.Node[0].id && f.category === "capacity");
    expect(fixtureNodeFindings).toHaveLength(0);
  });
  it("does not weaken canonical provenance for fixtures", async () => {
    const { data } = await freshImport(ARTIFACT);
    expect(data.Node[0].source_kind).toBe("canonical");
  });
});