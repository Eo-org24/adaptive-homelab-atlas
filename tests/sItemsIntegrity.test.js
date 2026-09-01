// S1–S3: Surgical integrity pass regression tests (logic level).
// S1: Complete canonical dependency identity validation (Cases A, B, C).
// S2: Field-aware R3 remap verification (deep serialization boundary).
// S3: Never report unverified attempts as successful remaps (uncertain state).
import { describe, it, expect } from "vitest";
import {
  runImport,
  createMemoryAdapter,
  REAL_CROSSOVER_ARTIFACT,
} from "@/lib/canonicalImport";
import { runRepair } from "@/lib/duplicateRepair";

const ARTIFACT = JSON.parse(REAL_CROSSOVER_ARTIFACT);

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
function wl(id) {
  return { schema: "homelab.workload/v1", kind: "workload", id, provenance: { source_class: "canonical" } };
}

// =========================================================================
// S1: COMPLETE CANONICAL DEPENDENCY IDENTITY VALIDATION
// =========================================================================
describe("S1: canonical dependency identity validation", () => {
  it("Case A: canonical Dependency with canonical_id K and NO relationship_key blocks import, zero writes, original remains", async () => {
    const adapter = createMemoryAdapter();

    // Import a valid depends_on to create a Dependency with canonical_id K
    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    // Verify the dependency was created
    const depsBefore = Array.from(adapter._store.Dependency.values());
    expect(depsBefore.length).toBe(1);
    const K = depsBefore[0].canonical_id;
    expect(depsBefore[0].relationship_key).toBe(K);

    // Corrupt: remove relationship_key (Case A)
    depsBefore[0].relationship_key = "";

    // Re-import the SAME artifact (unified V1 depends_on K)
    const r = await runImport(depArtifact, {}, { adapter, complete: true });

    // Expected: blocked, import_blocked, zero writes
    expect(r.blocked).toBe(true);
    expect(r.sync_state).toBe("import_blocked");
    expect(r.counts.created).toBe(0);
    expect(r.counts.updated).toBe(0);
    expect(r.counts.dependencies_created).toBe(0);
    expect(r.counts.dependencies_updated).toBe(0);
    expect(r.counts.dependencies_deleted).toBe(0);

    // Exactly the original Dependency remains — no second canonical_id K created
    const depsFinal = Array.from(adapter._store.Dependency.values());
    expect(depsFinal.length).toBe(1);
    expect(depsFinal[0].canonical_id).toBe(K);
    expect(depsFinal[0].relationship_key).toBe("");

    // S1: structured integrity finding surfaced
    const integrityFinding = r.ambiguous.find((a) => a.type === "dependency_integrity");
    expect(integrityFinding).toBeTruthy();
    expect(integrityFinding.entity).toBe("Dependency");
    expect(integrityFinding.reason).toMatch(/missing or empty relationship_key/i);
  });

  it("Case B: canonical_id K1 + relationship_key K2 blocks import before writes", async () => {
    const adapter = createMemoryAdapter();

    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    // Corrupt: set relationship_key to a different value than canonical_id (Case B)
    const dep = Array.from(adapter._store.Dependency.values())[0];
    const originalCid = dep.canonical_id;
    dep.relationship_key = "workload:w1|depends_on|workload:w3"; // != canonical_id

    const r = await runImport(depArtifact, {}, { adapter, complete: true });

    expect(r.blocked).toBe(true);
    expect(r.sync_state).toBe("import_blocked");
    expect(r.counts.dependencies_created).toBe(0);
    expect(r.counts.dependencies_updated).toBe(0);

    // The original record is unchanged
    const depsFinal = Array.from(adapter._store.Dependency.values());
    expect(depsFinal.length).toBe(1);
    expect(depsFinal[0].canonical_id).toBe(originalCid);

    // S1: structured integrity finding with canonical_id and relationship_key
    const integrityFinding = r.ambiguous.find((a) => a.type === "dependency_integrity" && a.reason.includes("does not match"));
    expect(integrityFinding).toBeTruthy();
    expect(integrityFinding.canonical_id).toBe(originalCid);
    expect(integrityFinding.relationship_key).toBe("workload:w1|depends_on|workload:w3");
  });

  it("Case C: two canonical Dependencies with different relationship_keys but same canonical_id blocks import", async () => {
    const adapter = createMemoryAdapter();

    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    // Create a second Dependency with the same canonical_id but different relationship_key
    const dep = Array.from(adapter._store.Dependency.values())[0];
    const sameCid = dep.canonical_id;
    await adapter.create("Dependency", {
      ...dep,
      id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      relationship_key: "workload:w1|depends_on|workload:w3", // different key, same canonical_id
      canonical_id: sameCid,
    });

    // Verify two deps with same canonical_id
    const depsBefore = Array.from(adapter._store.Dependency.values());
    expect(depsBefore.length).toBe(2);
    expect(depsBefore.filter((d) => d.canonical_id === sameCid).length).toBe(2);

    const r = await runImport(depArtifact, {}, { adapter, complete: true });

    expect(r.blocked).toBe(true);
    expect(r.sync_state).toBe("import_blocked");
    expect(r.counts.dependencies_created).toBe(0);

    // Both records still exist — no writes performed
    const depsFinal = Array.from(adapter._store.Dependency.values());
    expect(depsFinal.length).toBe(2);

    // S1: canonical_id identity finding surfaced
    const cidFinding = r.ambiguous.find((a) => a.type === "dependency_canonical_id_identity");
    expect(cidFinding).toBeTruthy();
    expect(cidFinding.canonical_id).toBe(sameCid);
    expect(cidFinding.matches.length).toBe(2);
  });

  it("R1 stale-duplicate test still passes: duplicate relationship_key blocks import", async () => {
    const adapter = createMemoryAdapter();

    const depArtifact = makeArtifact(
      [wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );
    await runImport(depArtifact, {}, { adapter, complete: true });

    // Duplicate the canonical Dependency row (same relationship_key)
    const dep = Array.from(adapter._store.Dependency.values())[0];
    const { id, created_date, updated_date, created_by_id, ...depRest } = dep;
    await adapter.create("Dependency", depRest);

    const noDepArtifact = makeArtifact([wl("w1"), wl("w2")], []);
    const r = await runImport(noDepArtifact, {}, { adapter, complete: true });

    expect(r.blocked).toBe(true);
    expect(r.sync_state).toBe("import_blocked");
    expect(r.counts.dependencies_deleted).toBe(0);

    // S1: dependency_identity finding still produced for duplicate relationship_key
    const depAmbiguity = r.ambiguous.find((a) => a.type === "dependency_identity");
    expect(depAmbiguity).toBeTruthy();
    expect(depAmbiguity.relationship_key).toBe("workload:w1|depends_on|workload:w2");
    expect(depAmbiguity.matches.length).toBe(2);
  });
});

// =========================================================================
// S2: FIELD-AWARE R3 REMAP VERIFICATION (deep serialization boundary)
// =========================================================================
describe("S2: PlannedChange.operations deep serialization boundary", () => {
  it("write-then-throw with deep-cloned reread: operations remap recognized as applied", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate a node
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create a PlannedChange with operations referencing the duplicate
    const pc = await adapter.create("PlannedChange", {
      title: "test-change",
      affected_nodes: [],
      operations: [
        { type: "move", node_id: dupId, to_node_id: "some-other-node", details: { reason: "capacity" } },
      ],
    });

    const store = adapter._store;

    // Override update: apply the write, THEN throw
    adapter.update = async (entity, id, payload) => {
      const ex = store[entity].get(id);
      if (!ex) throw new Error("not found");
      const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
      store[entity].set(id, rec);
      throw new Error("Simulated write-then-throw");
    };

    // Override listAll: return DEEP-CLONED copies (simulates real deserialization)
    adapter.listAll = async (entity) => {
      const records = Array.from((store[entity] || new Map()).values());
      return records.map((r) => JSON.parse(JSON.stringify(r)));
    };

    const r = await runRepair(ARTIFACT, { adapter });

    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.writesOccurred).toBe(true);
    // S2: persisted operations remap is recognized as applied despite deep-cloned reread
    expect(r.remapped.length).toBe(1);
    expect(r.remapped[0].entity).toBe("PlannedChange");
    expect(r.remapped[0].id).toBe(pc.id);
    expect(r.remapped[0].fields).toContain("operations");
    // No deletion began
    expect(r.deleted.length).toBe(0);
    // The duplicate still exists
    expect(store.Node.has(dupId)).toBe(true);
    // Not uncertain — reread succeeded
    expect(r.databaseStateUncertain).toBe(false);
  });

  it("throw-before-write with deep-cloned reread: remap not claimed as applied", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    await adapter.create("PlannedChange", {
      title: "test-change",
      affected_nodes: [],
      operations: [
        { type: "move", node_id: dupId, to_node_id: "some-other-node" },
      ],
    });

    const store = adapter._store;

    // Override update: throw WITHOUT applying
    adapter.update = async () => { throw new Error("Simulated throw-before-write"); };

    // Override listAll: return DEEP-CLONED copies
    adapter.listAll = async (entity) => {
      const records = Array.from((store[entity] || new Map()).values());
      return records.map((r) => JSON.parse(JSON.stringify(r)));
    };

    const r = await runRepair(ARTIFACT, { adapter });

    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.writesOccurred).toBe(false);
    expect(r.remapped.length).toBe(0);
    expect(r.deleted.length).toBe(0);
    expect(store.Node.has(dupId)).toBe(true);
  });
});

// =========================================================================
// S3: NEVER REPORT UNVERIFIED ATTEMPTS AS SUCCESSFUL REMAPS
// =========================================================================
describe("S3: uncertain state — unverified attempts not in remapped", () => {
  it("A: first update throws + reread throws → uncertain, not in remapped, in unverifiedRemaps, no deletion", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const dec = await adapter.create("Decision", {
      decision_id: "dec-s3a", title: "S3A", related_nodes: [dupId], source_kind: "manual",
    });

    const store = adapter._store;
    let verificationMode = false;

    // Override update: apply the write, THEN throw, THEN set verification mode
    adapter.update = async (entity, id, payload) => {
      const ex = store[entity].get(id);
      if (!ex) throw new Error("not found");
      const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
      store[entity].set(id, rec);
      verificationMode = true;
      throw new Error("Simulated write-then-throw");
    };

    // Override listAll: Phase 0 succeeds, verification reread throws
    adapter.listAll = async (entity) => {
      if (verificationMode) throw new Error("Simulated reread failure");
      const records = Array.from((store[entity] || new Map()).values());
      return records.map((r) => ({ ...r }));
    };

    const r = await runRepair(ARTIFACT, { adapter });

    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.databaseStateUncertain).toBe(true);
    // S3: failed operation is NOT in report.remapped
    expect(r.remapped.length).toBe(0);
    // S3: uncertain attempted operation is surfaced separately
    expect(r.unverifiedRemaps).toBeTruthy();
    expect(r.unverifiedRemaps.length).toBe(1);
    expect(r.unverifiedRemaps[0].entity).toBe("Decision");
    expect(r.unverifiedRemaps[0].id).toBe(dec.id);
    // S3: no deletion began
    expect(r.deleted.length).toBe(0);
    // The duplicate still exists
    expect(store.Node.has(dupId)).toBe(true);
    // writesOccurred is NOT true merely because an operation was attempted
    expect(r.writesOccurred).toBe(false);
  });

  it("B: earlier update succeeds, second fails, reread fails → earlier distinguishable, second not claimed, uncertain", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create TWO Decisions referencing the duplicate
    const dec1 = await adapter.create("Decision", {
      decision_id: "dec-s3b-1", title: "S3B-1", related_nodes: [dupId], source_kind: "manual",
    });
    const dec2 = await adapter.create("Decision", {
      decision_id: "dec-s3b-2", title: "S3B-2", related_nodes: [dupId], source_kind: "manual",
    });

    const store = adapter._store;
    let updateCallCount = 0;
    let verificationMode = false;

    // Override update: first call succeeds, second call applies-then-throws
    adapter.update = async (entity, id, payload) => {
      updateCallCount++;
      if (updateCallCount === 1) {
        // First update succeeds
        const ex = store[entity].get(id);
        if (!ex) throw new Error("not found");
        const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
        store[entity].set(id, rec);
        return;
      }
      // Second update: apply, then throw
      const ex = store[entity].get(id);
      if (!ex) throw new Error("not found");
      const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
      store[entity].set(id, rec);
      verificationMode = true;
      throw new Error("Simulated write-then-throw on second update");
    };

    // Override listAll: Phase 0 succeeds, verification reread throws
    adapter.listAll = async (entity) => {
      if (verificationMode) throw new Error("Simulated reread failure");
      const records = Array.from((store[entity] || new Map()).values());
      return records.map((r) => ({ ...r }));
    };

    const r = await runRepair(ARTIFACT, { adapter });

    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.databaseStateUncertain).toBe(true);
    // S3: earlier known successful mutation remains distinguishable
    expect(r.remapped.length).toBe(1);
    expect(r.remapped[0].entity).toBe("Decision");
    expect(r.remapped[0].id).toBe(dec1.id);
    // S3: failed second update is not claimed as successfully remapped
    expect(r.remapped.find((rm) => rm.id === dec2.id)).toBeFalsy();
    // S3: failed second update is in unverifiedRemaps
    expect(r.unverifiedRemaps).toBeTruthy();
    expect(r.unverifiedRemaps.find((rm) => rm.id === dec2.id)).toBeTruthy();
    // S3: database state uncertainty is explicit
    expect(r.databaseStateUncertain).toBe(true);
    // No deletion began
    expect(r.deleted.length).toBe(0);
    // writesOccurred is true because the first update independently succeeded
    expect(r.writesOccurred).toBe(true);
  });

  it("C: verification succeeds → existing write-then-throw behavior preserved exactly", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const dec = await adapter.create("Decision", {
      decision_id: "dec-s3c", title: "S3C", related_nodes: [dupId], source_kind: "manual",
    });

    const store = adapter._store;
    adapter.update = async (entity, id, payload) => {
      const ex = store[entity].get(id);
      if (!ex) throw new Error("not found");
      const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
      store[entity].set(id, rec);
      throw new Error("Simulated write-then-throw");
    };

    const r = await runRepair(ARTIFACT, { adapter });

    // Existing behavior: partial, writesOccurred, remapped includes persisted remap
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.writesOccurred).toBe(true);
    expect(r.remapped.length).toBe(1);
    expect(r.remapped[0].entity).toBe("Decision");
    expect(r.remapped[0].id).toBe(dec.id);
    expect(r.deleted.length).toBe(0);
    expect(r.databaseStateUncertain).toBe(false);
    // No unverified remaps when reread succeeds
    expect(r.unverifiedRemaps).toBeTruthy();
    expect(r.unverifiedRemaps.length).toBe(0);
  });
});