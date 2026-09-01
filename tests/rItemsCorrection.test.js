// R1–R8: Final defect-correction regression tests (logic level).
// Covers R1 (stale ambiguous deps), R2 (array type safety), R3 (write-then-throw),
// R4 (exact artifact provenance), R5 (owning-group attribution), R6 (structured
// ambiguity findings), F7 (set-based provenance preservation).
import { describe, it, expect } from "vitest";
import {
  runImport,
  createMemoryAdapter,
  REAL_CROSSOVER_ARTIFACT,
  preflightImport,
  previewImport,
} from "@/lib/canonicalImport";
import {
  previewRepair,
  runRepair,
} from "@/lib/duplicateRepair";

const ARTIFACT = JSON.parse(REAL_CROSSOVER_ARTIFACT);
const ARTIFACT_GENERATED_AT = ARTIFACT.generated_at;
const ARTIFACT_DIGEST = ARTIFACT.source.content_digest;
const PROV = {
  source_generated_at: ARTIFACT_GENERATED_AT,
  source_note: `content_digest=${ARTIFACT_DIGEST}`,
};

function makeArtifact(entities, relationships, commit, digest) {
  return {
    schema_version: "adaptive-homelab-atlas/v1",
    generated_at: "2026-08-31T00:00:00Z",
    producer: { name: "hlctl", version: "1.0.0" },
    source: { repository: "homelab-foundation", commit: commit || "test-commit", is_dirty: false, content_digest: digest || "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    entities,
    relationships: relationships || [],
  };
}
function node(id) {
  return { schema: "homelab.node/v1", kind: "node", id, provenance: { source_class: "canonical" }, identity: { physical_name: id } };
}
function env(id) {
  return { schema: "homelab.execution-provider/v1", kind: "execution-provider", id, provenance: { source_class: "canonical" } };
}
function wl(id) {
  return { schema: "homelab.workload/v1", kind: "workload", id, provenance: { source_class: "canonical" } };
}

// =========================================================================
// R1: BLOCK AMBIGUOUS CANONICAL DEPENDENCIES EVEN WHEN STALE
// =========================================================================
describe("R1: stale ambiguous dependency blocks import", () => {
  it("import a snapshot without a stale ambiguous dependency is blocked, zero writes, both rows unchanged", async () => {
    const adapter = createMemoryAdapter();

    // Step 1: Import w1 depends_on w2
    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    // Verify the dependency was created
    const depsBefore = Array.from(adapter._store.Dependency.values());
    expect(depsBefore.length).toBe(1);
    expect(depsBefore[0].relationship_key).toBe("workload:w1|depends_on|workload:w2");

    // Step 2: Duplicate the canonical Dependency row
    const dep = depsBefore[0];
    const { id: _depId, created_date: _cd, updated_date: _ud, created_by_id: _cb, ...depRest } = dep;
    await adapter.create("Dependency", depRest);

    // Verify there are now two rows with the same relationship_key
    const depsAfterDup = Array.from(adapter._store.Dependency.values());
    expect(depsAfterDup.length).toBe(2);
    expect(depsAfterDup.filter((d) => d.relationship_key === "workload:w1|depends_on|workload:w2").length).toBe(2);

    // Step 3: Import a new valid snapshot where w1 no longer depends_on w2
    const noDepArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [] // no relationships — w1 no longer depends_on w2
    );
    const r = await runImport(noDepArtifact, {}, { adapter, complete: true });

    // Step 4: Expected — blocked, import_blocked, zero writes
    expect(r.blocked).toBe(true);
    expect(r.sync_state).toBe("import_blocked");
    expect(r.counts.created).toBe(0);
    expect(r.counts.updated).toBe(0);
    expect(r.counts.dependencies_created).toBe(0);
    expect(r.counts.dependencies_updated).toBe(0);
    expect(r.counts.dependencies_deleted).toBe(0);

    // BOTH duplicate Dependency rows still exist unchanged
    const depsFinal = Array.from(adapter._store.Dependency.values());
    expect(depsFinal.length).toBe(2);
    expect(depsFinal.filter((d) => d.relationship_key === "workload:w1|depends_on|workload:w2").length).toBe(2);
  });

  it("incoming ambiguous dependency also blocks at runImport level", async () => {
    const adapter = createMemoryAdapter();

    // Import w1 depends_on w2
    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    // Duplicate the dependency
    const dep = Array.from(adapter._store.Dependency.values())[0];
    const { id, created_date, updated_date, created_by_id, ...depRest } = dep;
    await adapter.create("Dependency", depRest);

    // Re-import the SAME artifact (with the depends_on relationship still present)
    const r = await runImport(depArtifact, {}, { adapter, complete: true });
    expect(r.blocked).toBe(true);
    expect(r.sync_state).toBe("import_blocked");
  });
});

// =========================================================================
// R6: STRUCTURED AMBIGUITY FINDINGS
// =========================================================================
describe("R6: structured report.ambiguous assertions", () => {
  it("stale ambiguous dependency produces structured ambiguity finding with relationship_key and matching IDs", async () => {
    const adapter = createMemoryAdapter();

    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    const dep = Array.from(adapter._store.Dependency.values())[0];
    const { id, created_date, updated_date, created_by_id, ...depRest } = dep;
    await adapter.create("Dependency", depRest);

    const noDepArtifact = makeArtifact([wl("w1"), wl("w2")], []);
    const r = await runImport(noDepArtifact, {}, { adapter, complete: true });

    // R6: counts.ambiguous must be non-zero
    expect(r.counts.ambiguous).toBeGreaterThan(0);

    // R6: structured finding with kind/entity, relationship_key, matching IDs, reason
    const depAmbiguity = r.ambiguous.find((a) => a.type === "dependency_identity");
    expect(depAmbiguity).toBeTruthy();
    expect(depAmbiguity.entity).toBe("Dependency");
    expect(depAmbiguity.relationship_key).toBe("workload:w1|depends_on|workload:w2");
    expect(depAmbiguity.canonical_id).toBe("workload:w1|depends_on|workload:w2");
    expect(depAmbiguity.matches.length).toBe(2);
    expect(depAmbiguity.matches.every((m) => m.id)).toBe(true);
    expect(depAmbiguity.reason).toBeTruthy();
  });

  it("ambiguous endpoint identity produces structured ambiguity finding", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate node:pve7 (a relationship endpoint)
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const artifact = makeArtifact(
      [env("ep1")],
      [{ source: "execution-provider:ep1", type: "hosted_on", target: "node:pve7" }]
    );

    const r = await runImport(artifact, data, { adapter, complete: true });
    expect(r.blocked).toBe(true);
    expect(r.counts.ambiguous).toBeGreaterThan(0);

    const endpointAmbiguity = r.ambiguous.find((a) => a.type === "endpoint_identity");
    expect(endpointAmbiguity).toBeTruthy();
    expect(endpointAmbiguity.entity).toBe("Node");
    expect(endpointAmbiguity.canonical_id).toBe("node:pve7");
    expect(endpointAmbiguity.matches.length).toBe(2);
    expect(endpointAmbiguity.reason).toBeTruthy();
  });

  it("previewImport also surfaces structured ambiguity findings", async () => {
    const adapter = createMemoryAdapter();

    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    const dep = Array.from(adapter._store.Dependency.values())[0];
    const { id, created_date, updated_date, created_by_id, ...depRest } = dep;
    await adapter.create("Dependency", depRest);

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const noDepArtifact = makeArtifact([wl("w1"), wl("w2")], []);
    const preview = previewImport(noDepArtifact, data, { complete: true });
    expect(preview.blocked).toBe(true);
    expect(preview.counts.ambiguous).toBeGreaterThan(0);
    const depAmbiguity = preview.ambiguous.find((a) => a.type === "dependency_identity");
    expect(depAmbiguity).toBeTruthy();
    expect(depAmbiguity.relationship_key).toBe("workload:w1|depends_on|workload:w2");
  });
});

// =========================================================================
// R2: ARRAY TYPE SAFETY
// =========================================================================
describe("R2: array target-type mismatch blocks group", () => {
  it("Decision.related_nodes containing a deleted Workload ID blocks the Workload group", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate workload:ssd-intake
    const wlRec = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    const { id: wlDupId } = await adapter.create("Workload", { ...wlRec, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Decision.related_nodes contains the Workload duplicate ID (type mismatch: expects Node)
    await adapter.create("Decision", {
      decision_id: "dec-type-mismatch",
      title: "Type mismatch test",
      related_nodes: [wlDupId],
      source_kind: "manual",
    });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Decision", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const preview = previewRepair(ARTIFACT, data);
    const wlGroup = preview.groups.find((g) => g.canonical_id === "workload:ssd-intake");
    expect(wlGroup).toBeTruthy();
    expect(wlGroup.eligible).toBe(false);
    expect(wlGroup.blockedReason).toMatch(/type mismatch/i);
  });

  it("Workload.eligible_execution_providers containing a deleted Node ID blocks the Node group", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate node:pve7
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: nodeDupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Workload.eligible_execution_providers contains the Node duplicate ID (type mismatch: expects ExecutionEnvironment)
    await adapter.create("Workload", {
      name: "test-wl",
      category: "unknown",
      eligible_execution_providers: [nodeDupId],
      source_kind: "manual",
    });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Decision", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const preview = previewRepair(ARTIFACT, data);
    const nodeGroup = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(nodeGroup).toBeTruthy();
    expect(nodeGroup.eligible).toBe(false);
    expect(nodeGroup.blockedReason).toMatch(/type mismatch/i);
  });

  it("correctly typed array reference continues to remap normally", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: nodeDupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Decision.related_nodes contains the Node duplicate ID (type matches: expects Node)
    const dec = await adapter.create("Decision", {
      decision_id: "dec-correct-type",
      title: "Correct type test",
      related_nodes: [nodeDupId],
      source_kind: "manual",
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);
    expect(r.deleted.length).toBe(1);

    // The reference was remapped to the keeper
    const updatedDec = adapter._store.Decision.get(dec.id);
    expect(updatedDec.related_nodes).toContain(pve7.id);
    expect(updatedDec.related_nodes).not.toContain(nodeDupId);
  });
});

// =========================================================================
// R3: WRITE-THEN-THROW RECONCILIATION
// =========================================================================
describe("R3: write-then-throw reconciliation", () => {
  it("A: first update applies then throws → partial, writesOccurred, remapped includes persisted remap, no deletion", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const dec = await adapter.create("Decision", {
      decision_id: "dec-a", title: "A", related_nodes: [dupId], source_kind: "manual",
    });

    // Override update: apply the write to the store, THEN throw
    const store = adapter._store;
    adapter.update = async (entity, id, payload) => {
      const ex = store[entity].get(id);
      if (!ex) throw new Error("not found");
      const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
      store[entity].set(id, rec);
      throw new Error("Simulated write-then-throw");
    };

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.writesOccurred).toBe(true);
    // The remapped entry reflects the actually persisted write
    expect(r.remapped.length).toBe(1);
    expect(r.remapped[0].entity).toBe("Decision");
    expect(r.remapped[0].id).toBe(dec.id);
    // No deletion began
    expect(r.deleted.length).toBe(0);
    // The duplicate still exists
    expect(adapter._store.Node.has(dupId)).toBe(true);
  });

  it("B: update throws before applying → writesOccurred=false, remapped does not claim failed operation", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    await adapter.create("Decision", {
      decision_id: "dec-b", title: "B", related_nodes: [dupId], source_kind: "manual",
    });

    // Override update: throw without applying
    adapter.update = async () => { throw new Error("Simulated throw-before-write"); };

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.writesOccurred).toBe(false);
    expect(r.remapped.length).toBe(0);
    expect(r.deleted.length).toBe(0);
    // The duplicate still exists
    expect(adapter._store.Node.has(dupId)).toBe(true);
  });

  it("C: delete removes the record then throws → deleted includes actual deletion, writesOccurred=true", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Override delete: delete the record, THEN throw
    const store = adapter._store;
    adapter.delete = async (entity, id) => {
      if (!store[entity] || !store[entity].has(id)) throw new Error("not found");
      store[entity].delete(id);
      throw new Error("Simulated delete-then-throw");
    };

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    // The delete actually succeeded — report it
    expect(r.deleted.length).toBe(1);
    expect(r.deleted[0].id).toBe(dupId);
    expect(r.writesOccurred).toBe(true);
    // The record is actually gone
    expect(adapter._store.Node.has(dupId)).toBe(false);
  });

  it("D: delete throws without deleting → deleted does not claim deletion", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Override delete: throw without deleting
    adapter.delete = async () => { throw new Error("Simulated throw-before-delete"); };

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.deleted.length).toBe(0);
    // The record still exists
    expect(adapter._store.Node.has(dupId)).toBe(true);
  });

  it("writesOccurred=true for successful deletion even with zero reference remaps", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate a node with NO references pointing at it
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.deleted.length).toBe(1);
    // R3: writesOccurred must be true even with zero remaps
    expect(r.writesOccurred).toBe(true);
  });
});

// =========================================================================
// R4: EXACT V1 ARTIFACT PROVENANCE FOR DESTRUCTIVE REPAIR
// =========================================================================
describe("R4: exact V1 artifact provenance", () => {
  it("same repo+commit, missing source_generated_at → blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    // Create a duplicate WITHOUT source_generated_at
    const { source_generated_at: _sgat, ...rest } = pve7;
    await adapter.create("Node", { ...rest, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    const g = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(g).toBeTruthy();
    expect(g.eligible).toBe(false);
    expect(g.blockedReason).toMatch(/missing source_generated_at/i);
  });

  it("same repo+commit, mismatched generated_at → blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", {
      ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      source_generated_at: "2020-01-01T00:00:00Z", // mismatched
    });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    const g = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(g).toBeTruthy();
    expect(g.eligible).toBe(false);
    expect(g.blockedReason).toMatch(/source_generated_at/i);
  });

  it("same repo+commit, missing digest evidence → blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    // Create a duplicate WITHOUT source_note (no parseable content_digest)
    const { source_note: _sn, ...rest } = pve7;
    await adapter.create("Node", { ...rest, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    const g = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(g).toBeTruthy();
    expect(g.eligible).toBe(false);
    expect(g.blockedReason).toMatch(/content_digest|digest/i);
  });

  it("same repo+commit, mismatched digest → blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", {
      ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      source_note: "content_digest=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // mismatched
    });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    const g = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(g).toBeTruthy();
    expect(g.eligible).toBe(false);
    expect(g.blockedReason).toMatch(/content_digest|digest/i);
  });

  it("exact genuine crossover provenance → repairable", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Create an exact duplicate (spreading preserves all provenance fields)
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    const g = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(g).toBeTruthy();
    expect(g.eligible).toBe(true);
  });

  it("genuine incident-era records contain the required provenance shape", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Verify that every imported canonical record has the required provenance
    for (const entity of ["Node", "ExecutionEnvironment", "Workload"]) {
      for (const rec of adapter._store[entity].values()) {
        if (!rec.canonical_id) continue;
        expect(rec.source_kind).toBe("canonical");
        expect(rec.source_repository).toBe("homelab-foundation");
        expect(rec.source_commit).toBe(ARTIFACT.source.commit);
        expect(rec.source_generated_at).toBe(ARTIFACT.generated_at);
        expect(rec.source_note).toContain(`content_digest=${ARTIFACT.source.content_digest}`);
      }
    }
  });
});

// =========================================================================
// R5: ATTRIBUTE UNKNOWN STRUCTURED REFERENCES TO OWNING GROUPS
// =========================================================================
describe("R5: only owning group blocked for unknown structured ref", () => {
  it("unknown PlannedChange field references only pve7 duplicate → pve7 blocked, rig9 ready, rig9 repairable", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate both pve7 and rig9
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const rig9 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:rig9");
    const { id: pve7Dup } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });
    await adapter.create("Node", { ...rig9, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // PlannedChange with unknown field referencing ONLY pve7 duplicate
    await adapter.create("PlannedChange", {
      title: "test-change",
      affected_nodes: [],
      operations: [
        { type: "move", custom_field: pve7Dup },
      ],
    });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "PlannedChange", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const preview = previewRepair(ARTIFACT, data);
    const pve7Group = preview.groups.find((g) => g.canonical_id === "node:pve7");
    const rig9Group = preview.groups.find((g) => g.canonical_id === "node:rig9");

    // pve7 is blocked (unknown ref to its duplicate)
    expect(pve7Group).toBeTruthy();
    expect(pve7Group.eligible).toBe(false);
    expect(pve7Group.blockedReason).toMatch(/unsafe|structured|unknown/i);

    // rig9 remains ready
    expect(rig9Group).toBeTruthy();
    expect(rig9Group.eligible).toBe(true);

    // Run repair — rig9 is repaired, pve7 is not
    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.deleted.length).toBe(1);
    expect(r.deleted[0].canonical_id).toBe("node:rig9");

    // pve7 still has 2 records (blocked)
    const pve7Count = Array.from(adapter._store.Node.values()).filter((n) => n.canonical_id === "node:pve7").length;
    expect(pve7Count).toBe(2);
    // rig9 has 1 record (repaired)
    const rig9Count = Array.from(adapter._store.Node.values()).filter((n) => n.canonical_id === "node:rig9").length;
    expect(rig9Count).toBe(1);
  });
});

// =========================================================================
// F7: SET-BASED ARRAY EQUALITY (PRESERVATION)
// =========================================================================
describe("F7: set-based provenance preservation", () => {
  it("[A,B] → [B,A] does not advance source_commit/imported_at", async () => {
    const adapter = createMemoryAdapter();
    const artifact = makeArtifact(
      [node("n1"), node("n2"), env("ep1"), wl("w1")],
      [
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n2" },
      ],
      "commit-v1"
    );
    await runImport(artifact, {}, { adapter, complete: true });

    const w1 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    const commitAfter1 = w1.source_commit;

    // Reordered relationships (same set, different order)
    const artifactReordered = makeArtifact(
      [node("n1"), node("n2"), env("ep1"), wl("w1")],
      [
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n2" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
      ],
      "commit-v2"
    );
    await runImport(artifactReordered, {}, { adapter, complete: true });

    const w1After2 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    expect(w1After2.source_commit).toBe("commit-v1"); // NOT advanced — only last_seen_* advanced
  });

  it("[A,B] → [B] advances value-change provenance", async () => {
    const adapter = createMemoryAdapter();
    const artifact = makeArtifact(
      [node("n1"), node("n2"), env("ep1"), wl("w1")],
      [
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n2" },
      ],
      "commit-v1"
    );
    await runImport(artifact, {}, { adapter, complete: true });

    // Remove n2 from placement_allowed_on_node
    const artifactRemoved = makeArtifact(
      [node("n1"), node("n2"), env("ep1"), wl("w1")],
      [
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
      ],
      "commit-v2"
    );
    await runImport(artifactRemoved, {}, { adapter, complete: true });

    const w1 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    expect(w1.source_commit).toBe("commit-v2"); // Advanced — set changed
  });

  it("[A] → [A,B] advances value-change provenance", async () => {
    const adapter = createMemoryAdapter();
    const artifact = makeArtifact(
      [node("n1"), node("n2"), env("ep1"), wl("w1")],
      [
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
      ],
      "commit-v1"
    );
    await runImport(artifact, {}, { adapter, complete: true });

    // Add n2 to placement_allowed_on_node
    const artifactAdded = makeArtifact(
      [node("n1"), node("n2"), env("ep1"), wl("w1")],
      [
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n2" },
      ],
      "commit-v2"
    );
    await runImport(artifactAdded, {}, { adapter, complete: true });

    const w1 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    expect(w1.source_commit).toBe("commit-v2"); // Advanced — set changed
  });
});