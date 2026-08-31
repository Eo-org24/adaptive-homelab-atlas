// Final V1 relationship correctness pass — regression tests for the actual bugs fixed:
//   1. Multi-target canonical placement relationships (array accumulation, not overwrite)
//   2. Empty-set reconciliation (clear removed relationships to [] / "")
//   3. Discriminated V1 validation (z.discriminatedUnion, literal kind/schema)
//   4. Memory unit semantics (GiB vs GB formatting and comparison)
import { describe, it, expect } from "vitest";
import { previewImport, runImport, createMemoryAdapter } from "@/lib/canonicalImport";
import { validateV1Strict } from "@/lib/v1Schema";
import { fmtMemory, fmtMemValue, memoryCapacityGB, nodeOversubscription } from "@/lib/homelab";

// ---- Helpers ----
const ENTITIES = ["Node", "ExecutionEnvironment", "Workload", "Dependency"];

async function snapshot(adapter) {
  const d = {};
  for (const k of ENTITIES) d[k] = await adapter.listAll(k);
  return d;
}

async function importOnce(artifact) {
  const adapter = createMemoryAdapter({});
  await runImport(artifact, await snapshot(adapter), { adapter });
  return { adapter, data: await snapshot(adapter) };
}

async function importTwice(artifact) {
  const adapter = createMemoryAdapter({});
  const r1 = await runImport(artifact, await snapshot(adapter), { adapter });
  const r2 = await runImport(artifact, await snapshot(adapter), { adapter });
  return { adapter, first: r1, second: r2, data: await snapshot(adapter) };
}

async function transition(first, second) {
  const adapter = createMemoryAdapter({});
  await runImport(first, await snapshot(adapter), { adapter });
  const r2 = await runImport(second, await snapshot(adapter), { adapter });
  // Third import (identical to second) for idempotence check
  const r3 = await runImport(second, await snapshot(adapter), { adapter });
  return { adapter, secondReport: r2, thirdReport: r3, data: await snapshot(adapter) };
}

function nodeCids(data, ids) {
  return (ids || []).map((id) => data.Node.find((n) => n.id === id)?.canonical_id).filter(Boolean);
}
function envCids(data, ids) {
  return (ids || []).map((id) => data.ExecutionEnvironment.find((e) => e.id === id)?.canonical_id).filter(Boolean);
}

// ---- Fixtures ----
const baseEnvelope = {
  schema_version: "adaptive-homelab-atlas/v1",
  generated_at: "2026-09-01T00:00:00Z",
  producer: { name: "hlctl", version: "1.0.0" },
  source: { repository: "homelab-foundation", commit: "fix1", is_dirty: false, content_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
};

const threeNodesFixture = {
  ...baseEnvelope,
  entities: [
    { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" } },
    { schema: "homelab.node/v1", kind: "node", id: "n2", provenance: { source_class: "canonical" } },
    { schema: "homelab.node/v1", kind: "node", id: "n3", provenance: { source_class: "canonical" } },
    { schema: "homelab.workload/v1", kind: "workload", id: "wl1", provenance: { source_class: "canonical" } },
  ],
  relationships: [
    { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n1" },
    { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
    { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n3" },
  ],
};

const threeProvidersFixture = {
  ...baseEnvelope,
  source: { ...baseEnvelope.source, content_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  entities: [
    { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" } },
    { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep2", provenance: { source_class: "canonical" } },
    { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep3", provenance: { source_class: "canonical" } },
    { schema: "homelab.workload/v1", kind: "workload", id: "wl1", provenance: { source_class: "canonical" } },
  ],
  relationships: [
    { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
    { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep2" },
    { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep3" },
  ],
};

// Reverse-ordered relationships for ordering independence test
const threeNodesReversed = {
  ...threeNodesFixture,
  relationships: [...threeNodesFixture.relationships].reverse(),
};
const threeProvidersReversed = {
  ...threeProvidersFixture,
  relationships: [...threeProvidersFixture.relationships].reverse(),
};

// ---- §1: MULTI-TARGET CANONICAL PLACEMENT RELATIONSHIPS ----
describe("multi-target canonical placement relationships", () => {
  it("retains all 3 allowed nodes for one workload", async () => {
    const { data } = await importOnce(threeNodesFixture);
    const wl = data.Workload[0];
    const cids = nodeCids(data, wl.placement_allowed_nodes).sort();
    expect(cids).toEqual(["node:n1", "node:n2", "node:n3"]);
  });
  it("retains all 3 allowed providers for one workload", async () => {
    const { data } = await importOnce(threeProvidersFixture);
    const wl = data.Workload[0];
    const cids = envCids(data, wl.eligible_execution_providers).sort();
    expect(cids).toEqual(["execution-provider:ep1", "execution-provider:ep2", "execution-provider:ep3"]);
  });
  it("relationship ordering does not change the resulting node set", async () => {
    const a = await importOnce(threeNodesFixture);
    const b = await importOnce(threeNodesReversed);
    const setA = nodeCids(a.data, a.data.Workload[0].placement_allowed_nodes).sort();
    const setB = nodeCids(b.data, b.data.Workload[0].placement_allowed_nodes).sort();
    expect(setA).toEqual(setB);
  });
  it("relationship ordering does not change the resulting provider set", async () => {
    const a = await importOnce(threeProvidersFixture);
    const b = await importOnce(threeProvidersReversed);
    const setA = envCids(a.data, a.data.Workload[0].eligible_execution_providers).sort();
    const setB = envCids(b.data, b.data.Workload[0].eligible_execution_providers).sort();
    expect(setA).toEqual(setB);
  });
  it("duplicate relationship tuple is rejected by V1 validation", () => {
    const dup = { ...threeNodesFixture, relationships: [...threeNodesFixture.relationships, threeNodesFixture.relationships[0]] };
    const r = previewImport(dup, {});
    expect(r.conflicts.some((c) => c.kind === "relationship")).toBe(true);
  });
  it("second identical import preserves exactly the same node set", async () => {
    const { data } = await importTwice(threeNodesFixture);
    const wl = data.Workload[0];
    const cids = nodeCids(data, wl.placement_allowed_nodes).sort();
    expect(cids).toEqual(["node:n1", "node:n2", "node:n3"]);
  });
  it("second identical import preserves exactly the same provider set", async () => {
    const { data } = await importTwice(threeProvidersFixture);
    const wl = data.Workload[0];
    const cids = envCids(data, wl.eligible_execution_providers).sort();
    expect(cids).toEqual(["execution-provider:ep1", "execution-provider:ep2", "execution-provider:ep3"]);
  });
});

// ---- §2: EMPTY-SET RECONCILIATION ----
describe("empty-set reconciliation: removed relationships cleared", () => {
  it("[n1,n2] → [n2] reduces placement_allowed_nodes to [n2]", async () => {
    const twoNodes = {
      ...threeNodesFixture,
      entities: threeNodesFixture.entities.filter((e) => e.id !== "n3"),
      relationships: [
        { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
      ],
    };
    const oneNode = {
      ...threeNodesFixture,
      entities: threeNodesFixture.entities.filter((e) => e.id !== "n3"),
      relationships: [{ source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" }],
    };
    const { data } = await transition(twoNodes, oneNode);
    const wl = data.Workload[0];
    expect(nodeCids(data, wl.placement_allowed_nodes)).toEqual(["node:n2"]);
  });
  it("[n2] → [] clears placement_allowed_nodes to empty", async () => {
    const oneNode = {
      ...threeNodesFixture,
      entities: threeNodesFixture.entities.filter((e) => e.id !== "n3"),
      relationships: [{ source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" }],
    };
    const noNodes = {
      ...threeNodesFixture,
      entities: threeNodesFixture.entities.filter((e) => e.id !== "n3"),
      relationships: [],
    };
    const { data } = await transition(oneNode, noNodes);
    const wl = data.Workload[0];
    expect(wl.placement_allowed_nodes).toEqual([]);
  });
  it("[ep1,ep2] → [ep2] reduces eligible_execution_providers to [ep2]", async () => {
    const twoProv = {
      ...threeProvidersFixture,
      entities: threeProvidersFixture.entities.filter((e) => e.id !== "ep3"),
      relationships: [
        { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep2" },
      ],
    };
    const oneProv = {
      ...threeProvidersFixture,
      entities: threeProvidersFixture.entities.filter((e) => e.id !== "ep3"),
      relationships: [{ source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep2" }],
    };
    const { data } = await transition(twoProv, oneProv);
    const wl = data.Workload[0];
    expect(envCids(data, wl.eligible_execution_providers)).toEqual(["execution-provider:ep2"]);
  });
  it("[ep2] → [] clears eligible_execution_providers to empty", async () => {
    const oneProv = {
      ...threeProvidersFixture,
      entities: threeProvidersFixture.entities.filter((e) => e.id !== "ep3"),
      relationships: [{ source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep2" }],
    };
    const noProv = {
      ...threeProvidersFixture,
      entities: threeProvidersFixture.entities.filter((e) => e.id !== "ep3"),
      relationships: [],
    };
    const { data } = await transition(oneProv, noProv);
    const wl = data.Workload[0];
    expect(wl.eligible_execution_providers).toEqual([]);
  });
  it("hosted_on node1 → hosted_on node2 updates current_host", async () => {
    const host1 = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" } },
        { schema: "homelab.node/v1", kind: "node", id: "n2", provenance: { source_class: "canonical" } },
        { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" } },
      ],
      relationships: [{ source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" }],
    };
    const host2 = {
      ...host1,
      source: { ...host1.source, content_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
      relationships: [{ source: "execution-provider:ep1", type: "hosted_on", target: "node:n2" }],
    };
    const { data } = await transition(host1, host2);
    const env = data.ExecutionEnvironment[0];
    const hostCid = data.Node.find((n) => n.id === env.current_host)?.canonical_id;
    expect(hostCid).toBe("node:n2");
  });
  it("hosted_on node2 → no hosted_on clears current_host", async () => {
    const host2 = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" } },
        { schema: "homelab.node/v1", kind: "node", id: "n2", provenance: { source_class: "canonical" } },
        { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" } },
      ],
      relationships: [{ source: "execution-provider:ep1", type: "hosted_on", target: "node:n2" }],
    };
    const noHost = {
      ...host2,
      source: { ...host2.source, content_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
      relationships: [],
    };
    const { data } = await transition(host2, noHost);
    const env = data.ExecutionEnvironment[0];
    expect(env.current_host).toBe("");
  });
  it("third identical import after transition is idempotent (0 created, 0 updated)", async () => {
    const twoNodes = {
      ...threeNodesFixture,
      entities: threeNodesFixture.entities.filter((e) => e.id !== "n3"),
      relationships: [
        { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
      ],
    };
    const oneNode = {
      ...threeNodesFixture,
      entities: threeNodesFixture.entities.filter((e) => e.id !== "n3"),
      relationships: [{ source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" }],
    };
    const { thirdReport } = await transition(twoNodes, oneNode);
    expect(thirdReport.counts.created).toBe(0);
    expect(thirdReport.counts.updated).toBe(0);
  });
});

// ---- §3: DISCRIMINATED V1 VALIDATION ----
describe("discriminated V1 validation: wrong-kind entity shape rejected", () => {
  it("rejects execution-provider carrying Node-only identity", () => {
    const bad = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" }, identity: { physical_name: "x" } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects node carrying provider-only runtime.autostart", () => {
    const bad = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" }, runtime: { kind: "lxc", autostart: true } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects workload carrying Node-only resources", () => {
    const bad = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.workload/v1", kind: "workload", id: "wl1", provenance: { source_class: "canonical" }, resources: { memory_gib: 128 } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects node carrying Workload-only requirements", () => {
    const bad = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" }, requirements: { capabilities: [] } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects valid provider schema string with Node object shape (kind/schema mismatch)", () => {
    const bad = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.execution-provider/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects valid node schema string with provider object shape (kind/schema mismatch)", () => {
    const bad = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.node/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("accepts a correct node entity (sanity check)", () => {
    const good = {
      ...baseEnvelope,
      entities: [
        { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" }, identity: { physical_name: "rig" } },
      ],
      relationships: [],
    };
    const r = validateV1Strict(good);
    expect(r.valid).toBe(true);
  });
});

// ---- §4: MEMORY UNIT SEMANTICS ----
describe("memory unit semantics: GiB vs GB", () => {
  it("fmtMemory renders memory_gib as GiB, not GB", () => {
    expect(fmtMemory({ memory_gib: 128 })).toBe("128 GiB");
  });
  it("fmtMemory renders ram_capacity_gb as GB", () => {
    expect(fmtMemory({ ram_capacity_gb: 128 })).toBe("128 GB");
  });
  it("fmtMemValue renders 128 GiB correctly", () => {
    expect(fmtMemValue(128, "GiB")).toBe("128 GiB");
  });
  it("fmtMemValue renders 2048 GiB as TiB", () => {
    expect(fmtMemValue(2048, "GiB")).toBe("2.0 TiB");
  });
  it("fmtMemValue renders 500 GB correctly", () => {
    expect(fmtMemValue(500, "GB")).toBe("500 GB");
  });
  it("fmtMemValue renders 2000 GB as TB", () => {
    expect(fmtMemValue(2000, "GB")).toBe("2.0 TB");
  });
  it("memoryCapacityGB converts GiB to GB for comparison", () => {
    const cap = memoryCapacityGB({ memory_gib: 128 });
    expect(cap).toBeCloseTo(128 * 1.073741824, 5);
  });
  it("memoryCapacityGB leaves GB as-is", () => {
    expect(memoryCapacityGB({ ram_capacity_gb: 128 })).toBe(128);
  });
  it("memoryCapacityGB returns null when no memory documented", () => {
    expect(memoryCapacityGB({})).toBeNull();
  });
  it("nodeOversubscription normalizes GiB capacity vs GB allocation", () => {
    // Node has 32 GiB = ~34.36 GB. Workload needs 33 GB.
    // Without normalization (comparing 33 > 32), this would falsely report oversubscription.
    // With normalization (33 > 34.36), there is NO oversubscription.
    const node = { id: "n1", hostname: "n1", memory_gib: 32 };
    const wls = [{ id: "w1", name: "w1", current_host: "n1", ram_requirement_gb: 33 }];
    const over = nodeOversubscription(node, wls, [], []);
    expect(over.ram).toBeUndefined(); // 33 GB < 34.36 GB → no oversubscription
  });
  it("nodeOversubscription detects oversubscription when GB exceeds GiB capacity", () => {
    // Node has 32 GiB = ~34.36 GB. Workload needs 36 GB.
    // 36 > 34.36 → oversubscription detected (correctly, after normalization)
    const node = { id: "n1", hostname: "n1", memory_gib: 32 };
    const wls = [{ id: "w1", name: "w1", current_host: "n1", ram_requirement_gb: 36 }];
    const over = nodeOversubscription(node, wls, [], []);
    expect(over.ram).toBeGreaterThan(0);
  });
});