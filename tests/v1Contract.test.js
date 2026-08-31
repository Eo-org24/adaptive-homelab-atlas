// V1 contract tests: strict validation, semantic mapping, dataset safety.
// Exercises the REAL validation path (validateV1Strict) and import path (runImport).
import { describe, it, expect } from "vitest";
import { previewImport, runImport, createMemoryAdapter, COMPREHENSIVE_V1_FIXTURE, GOLDEN_CROSSOVER } from "@/lib/canonicalImport";
import { validateV1Strict } from "@/lib/v1Schema";
import { overrideConflicts, isFixture, isOperational, realDataset } from "@/lib/provenance";
import { nodeOversubscription } from "@/lib/homelab";

const COMP = JSON.parse(COMPREHENSIVE_V1_FIXTURE);
const GOLDEN = JSON.parse(GOLDEN_CROSSOVER);

async function importFixture(artifact, initial = {}) {
  const adapter = createMemoryAdapter(initial);
  const data = {};
  for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data[k] = await adapter.listAll(k);
  await runImport(artifact, data, { adapter });
  const out = {};
  for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) out[k] = await adapter.listAll(k);
  return { adapter, data: out };
}

// ---- §17: NEGATIVE CONTRACT TESTS ----
describe("V1 strict validation: negative contract tests", () => {
  it("rejects schema_version v1.1", () => {
    const bad = { ...COMP, schema_version: "adaptive-homelab-atlas/v1.1" };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects unknown nested Node field", () => {
    const bad = { ...COMP, entities: COMP.entities.map((e) => e.kind === "node" ? { ...e, surprise_field: 1 } : e) };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /surprise_field/i.test(e))).toBe(true);
  });
  it("rejects unknown capability property", () => {
    const bad = { ...COMP, entities: COMP.entities.map((e) => e.kind === "node" ? { ...e, capabilities: [{ type: "hw-accel", id: "accel1", extra: 1 }] } : e) };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects unknown Workload requirement property", () => {
    const bad = { ...COMP, entities: COMP.entities.map((e) => e.kind === "workload" && e.requirements ? { ...e, requirements: { capabilities: [{ type: "hw-accel", instance: "accel1", extra: 1 }] } } : e) };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects extra relationship property", () => {
    const bad = { ...COMP, relationships: COMP.relationships.map((r) => ({ ...r, extra: 1 })) };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects schema/kind mismatch", () => {
    const bad = { ...COMP, entities: COMP.entities.map((e) => e.kind === "node" ? { ...e, schema: "homelab.workload/v1" } : e) };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /schema/i.test(e))).toBe(true);
  });
  it("rejects provenance.source_class = observed", () => {
    const bad = { ...COMP, entities: COMP.entities.map((e) => ({ ...e, provenance: { source_class: "observed" } })) };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects missing producer metadata", () => {
    const bad = { ...COMP, producer: undefined };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects malformed source metadata (missing is_dirty)", () => {
    const bad = { ...COMP, source: { repository: "x", commit: "y" } };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects invalid typed endpoint (no colon)", () => {
    const bad = { ...COMP, relationships: [{ source: "invalid", type: "hosted_on", target: "node:comp-node-1" }] };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
  });
  it("rejects hosted_on with wrong source kind (node instead of execution-provider)", () => {
    const bad = { ...COMP, relationships: [{ source: "node:comp-node-1", type: "hosted_on", target: "node:comp-node-1" }] };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /source kind/i.test(e))).toBe(true);
  });
  it("rejects hosted_on with wrong target kind (workload instead of node)", () => {
    const bad = { ...COMP, relationships: [{ source: "execution-provider:comp-ep-1", type: "hosted_on", target: "workload:comp-wl-1" }] };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /target kind/i.test(e))).toBe(true);
  });
  it("rejects placement_allowed_on_node with wrong target kind (execution-provider)", () => {
    const bad = { ...COMP, relationships: [{ source: "workload:comp-wl-1", type: "placement_allowed_on_node", target: "execution-provider:comp-ep-1" }] };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /target kind/i.test(e))).toBe(true);
  });
  it("rejects depends_on with non-workload endpoint (node)", () => {
    const bad = { ...COMP, relationships: [{ source: "workload:comp-wl-1", type: "depends_on", target: "node:comp-node-1" }] };
    const r = validateV1Strict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /target kind/i.test(e))).toBe(true);
  });
});

// ---- §18: SEMANTIC MAPPING TESTS ----
describe("V1 semantic mapping: comprehensive fixture", () => {
  it("Node physical_name preserved and used as hostname", async () => {
    const { data } = await importFixture(COMP);
    const node = data.Node[0];
    expect(node.physical_name).toBe("storage-rig");
    expect(node.hostname).toBe("storage-rig");
  });
  it("FQDN preserved", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].fqdn).toBe("storage-rig.lan");
  });
  it("purpose preserved", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].purpose).toEqual(["storage", "backup"]);
    expect(data.ExecutionEnvironment[0].purpose).toEqual(["container-runtime"]);
  });
  it("lifecycle.state correctly mapped to lifecycle_state", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].lifecycle_state).toBe("active");
  });
  it("availability.expected correctly mapped to availability_expectation", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].availability_expectation).toBe("always_on");
  });
  it("memory_gib preserves GiB unit (not converted to GB)", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].memory_gib).toBe(128);
    expect(data.Node[0].ram_capacity_gb).toBeUndefined();
  });
  it("resources.cpu.model correctly mapped to cpu_model", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].cpu_model).toBe("AMD Ryzen 9 5950X");
  });
  it("provider runtime.kind preserved in runtime_kind", async () => {
    const { data } = await importFixture(COMP);
    expect(data.ExecutionEnvironment[0].runtime_kind).toBe("lxc");
  });
  it("provider runtime.kind mapped to type (not defaulted to vm)", async () => {
    const { data } = await importFixture(COMP);
    expect(data.ExecutionEnvironment[0].type).toBe("lxc");
  });
  it("provider autostart preserved", async () => {
    const { data } = await importFixture(COMP);
    expect(data.ExecutionEnvironment[0].autostart).toBe(true);
  });
  it("provider capabilities preserved", async () => {
    const { data } = await importFixture(COMP);
    expect(data.ExecutionEnvironment[0].capabilities).toEqual([{ type: "hw-accel", id: "accel1" }]);
  });
  it("workload display_name preserved and used as name", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Workload[0].display_name).toBe("Media Server");
    expect(data.Workload[0].name).toBe("Media Server");
  });
  it("workload maturity preserved", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Workload[0].maturity).toBe("production");
  });
  it("workload runtime.kind preserved in runtime_kind", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Workload[0].runtime_kind).toBe("container");
  });
  it("no invented category (unknown, not user_application)", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Workload[0].category).toBe("unknown");
  });
  it("no invented VM type when runtime.kind absent (golden fixture provider)", async () => {
    const { data } = await importFixture(GOLDEN);
    expect(data.ExecutionEnvironment[0].type).toBe("unknown");
  });
  it("capability ambiguity remains unresolved", async () => {
    const r = previewImport(COMP, {});
    expect(r.capability_findings.length).toBeGreaterThanOrEqual(1);
    expect(r.capability_findings[0].resolution).toBe("unresolved");
  });
});

// ---- §4: ALL FOUR RELATIONSHIP TYPES ----
describe("V1 relationships: all four types", () => {
  it("hosted_on maps to ExecutionEnvironment.current_host", async () => {
    const { data } = await importFixture(COMP);
    const env = data.ExecutionEnvironment[0];
    const node = data.Node[0];
    expect(env.current_host).toBe(node.id);
  });
  it("placement_allowed_on_provider maps to eligible_execution_providers", async () => {
    const { data } = await importFixture(COMP);
    const wl = data.Workload[0];
    const env = data.ExecutionEnvironment[0];
    expect(wl.eligible_execution_providers || []).toContain(env.id);
  });
  it("placement_allowed_on_node maps to placement_allowed_nodes (NOT preferred_node)", async () => {
    const { data } = await importFixture(COMP);
    const wl = data.Workload[0];
    const node = data.Node[0];
    expect(wl.placement_allowed_nodes || []).toContain(node.id);
    expect(wl.preferred_node).toBeFalsy();
  });
  it("depends_on materializes a Dependency record with kind=unknown", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Dependency.length).toBe(1);
    const dep = data.Dependency[0];
    expect(dep.kind).toBe("unknown");
    expect(dep.source_type).toBe("workload");
    expect(dep.target_type).toBe("workload");
    expect(dep.relationship_key).toContain("depends_on");
    expect(dep.source_kind).toBe("canonical");
  });
  it("depends_on is idempotent (second import creates 0 duplicates)", async () => {
    const adapter = createMemoryAdapter({});
    const data0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data0[k] = await adapter.listAll(k);
    await runImport(COMP, data0, { adapter });
    const data1 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data1[k] = await adapter.listAll(k);
    const r2 = await runImport(COMP, data1, { adapter });
    const data2 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data2[k] = await adapter.listAll(k);
    expect(data2.Dependency.length).toBe(1);
    expect(r2.counts.dependencies_created).toBe(0);
  });
  it("stale canonical depends_on is removed on re-import without it", async () => {
    const adapter = createMemoryAdapter({});
    const data0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data0[k] = await adapter.listAll(k);
    await runImport(COMP, data0, { adapter });
    // Re-import without the depends_on relationship
    const noDep = { ...COMP, relationships: COMP.relationships.filter((r) => r.type !== "depends_on") };
    const data1 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data1[k] = await adapter.listAll(k);
    const r2 = await runImport(noDep, data1, { adapter });
    const data2 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) data2[k] = await adapter.listAll(k);
    expect(data2.Dependency.length).toBe(0);
    expect(r2.counts.dependencies_deleted).toBe(1);
  });
});

// ---- §12: PROVENANCE CORRECTIONS ----
describe("V1 provenance: timestamps and version fields", () => {
  it("source_version is the schema version, not producer version", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].source_version).toBe("adaptive-homelab-atlas/v1");
  });
  it("source_generated_at is preserved separately from imported_at", async () => {
    const { data } = await importFixture(COMP);
    expect(data.Node[0].source_generated_at).toBe("2026-09-01T00:00:00Z");
    expect(data.Node[0].imported_at).toBeTruthy();
    expect(data.Node[0].imported_at).not.toBe("2026-09-01T00:00:00Z");
  });
  it("repeated import advances last_seen_import_at even if generated_at unchanged", async () => {
    const adapter = createMemoryAdapter({});
    const d0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d0[k] = await adapter.listAll(k);
    await runImport(COMP, d0, { adapter });
    const d1 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d1[k] = await adapter.listAll(k);
    const firstImport = d1.Node[0].imported_at;
    // Wait a tiny bit
    await new Promise((r) => setTimeout(r, 10));
    await runImport(COMP, d1, { adapter });
    const d2 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d2[k] = await adapter.listAll(k);
    expect(d2.Node[0].last_seen_import_at).not.toBe(firstImport);
    expect(d2.Node[0].source_generated_at).toBe("2026-09-01T00:00:00Z");
  });
});

// ---- §13: FIXTURE DETECTION ----
describe("V1 fixture detection: not based on commit=unknown alone", () => {
  it("golden fixture (known digest) is tagged as fixture", async () => {
    const { data } = await importFixture(GOLDEN);
    expect(isFixture(data.Node[0])).toBe(true);
  });
  it("comprehensive fixture (unknown digest) is NOT tagged as fixture", async () => {
    const { data } = await importFixture(COMP);
    expect(isFixture(data.Node[0])).toBe(false);
  });
  it("a normal V1 import with commit=unknown is NOT auto-tagged as fixture", async () => {
    const unknownCommit = { ...COMP, source: { ...COMP.source, commit: "unknown", content_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" } };
    const { data } = await importFixture(unknownCommit);
    expect(isFixture(data.Node[0])).toBe(false);
    expect(data.Node[0].source_commit).toBe("unknown");
  });
});

// ---- §19: DATASET-SAFETY TESTS ----
describe("V1 dataset safety", () => {
  it("501+ existing records are all visible to canonical import", async () => {
    const adapter = createMemoryAdapter({});
    // Create 501 existing Node records, with the 501st having a canonical_id
    const existing = [];
    for (let i = 0; i < 500; i++) existing.push({ id: `n${i}`, hostname: `node-${i}` });
    existing.push({ id: "n500", hostname: "match-node", canonical_id: "node:comp-node-1" });
    for (const r of existing) adapter._store.Node.set(r.id, { ...r });
    const data = { Node: await adapter.listAll("Node") };
    const r = previewImport(COMP, data);
    // The node:comp-node-1 entity should match the existing record (unchanged), not create
    expect(r.counts.created).toBeLessThan(COMP.entities.length);
    expect(r.unchanged.some((u) => u.canonical_id === "node:comp-node-1")).toBe(true);
  });
  it("second-page canonical match prevents duplicate creation", async () => {
    const adapter = createMemoryAdapter({});
    // 500 records on "page 1", then the matching record on "page 2"
    for (let i = 0; i < 500; i++) adapter._store.Node.set(`n${i}`, { id: `n${i}`, hostname: `node-${i}` });
    adapter._store.Node.set("n500", { id: "n500", hostname: "match", canonical_id: "node:comp-node-1" });
    const data = { Node: await adapter.listAll("Node") };
    expect(data.Node.length).toBe(501);
    const r = previewImport(COMP, data);
    expect(r.unchanged.some((u) => u.canonical_id === "node:comp-node-1")).toBe(true);
    expect(r.created.some((c) => c.canonical_id === "node:comp-node-1")).toBe(false);
  });
  it("adapter listAll failure causes partial failure (not silent 0 records)", async () => {
    const adapter = createMemoryAdapter({});
    const d0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d0[k] = await adapter.listAll(k);
    // First import succeeds
    await runImport(COMP, d0, { adapter });
    // Now make listAll throw for the post-write refresh
    const origListAll = adapter.listAll.bind(adapter);
    let callCount = 0;
    adapter.listAll = async (entity) => {
      callCount++;
      if (callCount > 4) throw new Error("Simulated fetch failure");
      return origListAll(entity);
    };
    const d1 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d1[k] = await adapter.listAll(k);
    const r = await runImport(COMP, d1, { adapter });
    expect(r.partial).toBe(true);
    expect(r.sync_state).toBe("partial_failure");
  });
  it("fixture node is not operational and excluded from realDataset", async () => {
    const { data } = await importFixture(GOLDEN);
    expect(isOperational(data.Node[0])).toBe(false);
    const filtered = realDataset({ Node: data.Node });
    expect(filtered.Node.length).toBe(0);
  });
  it("fixture node capacity is excluded from capacity calculations", async () => {
    const { data } = await importFixture(GOLDEN);
    const node = data.Node[0];
    // nodeOversubscription with realDataset should not produce findings for the fixture node
    const real = realDataset(data);
    const over = nodeOversubscription(node, real.Workload || [], real.ExecutionEnvironment || [], real.StoragePool || []);
    // Fixture node has no workloads/envs after filtering, so no oversubscription
    expect(Object.keys(over).length).toBe(0);
  });
  it("fixture node cannot be a normal placement candidate (excluded by realDataset)", async () => {
    const { data } = await importFixture(GOLDEN);
    const real = realDataset(data);
    // The fixture node should not appear in the real (operational) node list
    expect(real.Node.length).toBe(0);
  });
  it("unified V1 local override conflict is detected", async () => {
    const adapter = createMemoryAdapter({});
    const d0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d0[k] = await adapter.listAll(k);
    await runImport(COMP, d0, { adapter });
    const d1 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d1[k] = await adapter.listAll(k);
    // Add a local override on the node's lifecycle_state
    const node = d1.Node[0];
    const fp = JSON.parse(node.field_provenance || "{}");
    fp.lifecycle_state = { local: "maintenance" };
    await adapter.update("Node", node.id, { field_provenance: JSON.stringify(fp), lifecycle_state: "maintenance" });
    // Re-import with a changed lifecycle.state
    const changed = { ...COMP, entities: COMP.entities.map((e) => e.kind === "node" ? { ...e, lifecycle: { state: "degraded" } } : e) };
    const d2 = { Node: await adapter.listAll("Node") };
    const conflicts = overrideConflicts(changed, d2);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some((c) => c.field === "lifecycle_state")).toBe(true);
  });
});

// ---- §14: SYNC STATE MODEL ----
describe("V1 sync state model", () => {
  it("comprehensive fixture import produces synchronized or local_additions state", async () => {
    const adapter = createMemoryAdapter({});
    const d0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d0[k] = await adapter.listAll(k);
    const r = await runImport(COMP, d0, { adapter });
    expect(["synchronized", "local_additions"]).toContain(r.sync_state);
  });
  it("partial failure produces partial_failure sync state", async () => {
    const adapter = createMemoryAdapter({});
    const d0 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) d0[k] = await adapter.listAll(k);
    // Make create throw for one entity
    const origCreate = adapter.create.bind(adapter);
    adapter.create = async (entity, payload) => {
      if (entity === "Workload") throw new Error("Simulated create failure");
      return origCreate(entity, payload);
    };
    const r = await runImport(COMP, d0, { adapter });
    expect(r.partial).toBe(true);
    expect(r.sync_state).toBe("partial_failure");
  });
});