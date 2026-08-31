import { describe, it, expect } from "vitest";
import {
  runImport,
  createMemoryAdapter,
  REAL_CROSSOVER_ARTIFACT,
} from "@/lib/canonicalImport";
import {
  previewRepair,
  runRepair,
  selectKeeper,
} from "@/lib/duplicateRepair";

const ARTIFACT = JSON.parse(REAL_CROSSOVER_ARTIFACT);
const INCIDENT_COMMIT = "a1f33a877db26ed0d351113ca064791eb7f4792d";
const INCIDENT_REPO = "homelab-foundation";

// Helper: create a minimal artifact with custom entities/relationships
function makeArtifact(entities, relationships, commit = "test-commit", repo = "homelab-foundation") {
  return {
    schema_version: "adaptive-homelab-atlas/v1",
    generated_at: "2026-08-31T00:00:00Z",
    producer: { name: "hlctl", version: "1.0.0" },
    source: { repository: repo, commit, is_dirty: false, content_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    entities,
    relationships: relationships || [],
  };
}

// Helper: create a node entity
function node(id, extra = {}) {
  return { schema: "homelab.node/v1", kind: "node", id, provenance: { source_class: "canonical" }, identity: { physical_name: id }, ...extra };
}
function env(id, extra = {}) {
  return { schema: "homelab.execution-provider/v1", kind: "execution-provider", id, provenance: { source_class: "canonical" }, ...extra };
}
function workload(id, extra = {}) {
  return { schema: "homelab.workload/v1", kind: "workload", id, provenance: { source_class: "canonical" }, ...extra };
}

// Helper: count records per canonical_id
function countByCanonical(store, entities = ["Node", "ExecutionEnvironment", "Workload"]) {
  const counts = {};
  for (const entity of entities) {
    const map = store[entity];
    if (!map) continue;
    for (const rec of map.values()) {
      if (rec.canonical_id) counts[rec.canonical_id] = (counts[rec.canonical_id] || 0) + 1;
    }
  }
  return counts;
}

// ---- C1: GLOBAL REFERENCE REMAP ----
describe("C1: Global reference remap", () => {
  it("one array referencing deleted IDs from TWO eligible groups receives BOTH replacements", async () => {
    const adapter = createMemoryAdapter();
    // Import the real artifact to get proper V1 projection records
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate two different node groups
    const pve7Recs = Array.from(adapter._store.Node.values()).filter((r) => r.canonical_id === "node:pve7");
    const rig9Recs = Array.from(adapter._store.Node.values()).filter((r) => r.canonical_id === "node:rig9");
    expect(pve7Recs.length).toBe(1);
    expect(rig9Recs.length).toBe(1);

    // Create duplicates for both nodes
    const { id: pve7DupId } = await adapter.create("Node", { ...pve7Recs[0], id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });
    const { id: rig9DupId } = await adapter.create("Node", { ...rig9Recs[0], id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create a Decision with related_nodes containing BOTH duplicate IDs
    const decision = await adapter.create("Decision", {
      decision_id: "dec-1",
      title: "Test decision",
      related_nodes: [pve7DupId, rig9DupId],
      source_kind: "manual",
    });

    // Run repair
    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);
    expect(r.deleted.length).toBe(2);

    // The Decision's related_nodes should have BOTH duplicates remapped to their keepers
    const updatedDecision = adapter._store.Decision.get(decision.id);
    expect(updatedDecision.related_nodes).toContain(pve7Recs[0].id);
    expect(updatedDecision.related_nodes).toContain(rig9Recs[0].id);
    expect(updatedDecision.related_nodes).not.toContain(pve7DupId);
    expect(updatedDecision.related_nodes).not.toContain(rig9DupId);

    // No deleted ID remains in the array
    const allDeleted = new Set(r.deleted.map((d) => d.id));
    updatedDecision.related_nodes.forEach((nid) => {
      expect(allDeleted.has(nid)).toBe(false);
    });
  });

  it("array with deleted IDs from two groups deduplicates after remap", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const rig9 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:rig9");

    // Create duplicates
    const { id: pve7Dup } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });
    const { id: rig9Dup } = await adapter.create("Node", { ...rig9, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Decision referencing both the keeper AND the duplicate of the same node
    const decision = await adapter.create("Decision", {
      decision_id: "dec-2",
      title: "Test",
      related_nodes: [pve7.id, pve7Dup, rig9.id, rig9Dup],
      source_kind: "manual",
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.Decision.get(decision.id);
    // After remap + dedup: exactly 2 unique elements (one per node group), no deleted IDs remain
    expect(updated.related_nodes.length).toBe(2);
    const allDeleted = new Set(r.deleted.map((d) => d.id));
    updated.related_nodes.forEach((nid) => {
      expect(allDeleted.has(nid)).toBe(false);
    });
  });
});

// ---- C2: COMPLETE REFERENCE COVERAGE ----
describe("C2: Complete reference coverage", () => {
  it("Task.related_object_id is remapped when pointing at a deleted Node", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const task = await adapter.create("Task", {
      task: "Fix node",
      related_object_type: "node",
      related_object_id: dupId,
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.Task.get(task.id);
    expect(updated.related_object_id).toBe(pve7.id);
  });

  it("Maintenance.target_id is remapped when pointing at a deleted Workload", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const wl = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    const { id: dupId } = await adapter.create("Workload", { ...wl, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const maint = await adapter.create("Maintenance", {
      type: "configuration",
      target_type: "workload",
      target_id: dupId,
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.Maintenance.get(maint.id);
    expect(updated.target_id).toBe(wl.id);
  });

  it("PlannedChange.affected_nodes array is remapped", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const rig9 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:rig9");
    const { id: pve7Dup } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });
    const { id: rig9Dup } = await adapter.create("Node", { ...rig9, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const pc = await adapter.create("PlannedChange", {
      title: "Move workloads",
      affected_nodes: [pve7Dup, rig9Dup],
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.PlannedChange.get(pc.id);
    // Both duplicates remapped to keepers, no deleted ID remains
    expect(updated.affected_nodes.length).toBe(2);
    const allDeleted = new Set(r.deleted.map((d) => d.id));
    updated.affected_nodes.forEach((nid) => {
      expect(allDeleted.has(nid)).toBe(false);
    });
  });

  it("PlannedChange.affected_workloads array is remapped", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const wl = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    const { id: dupId } = await adapter.create("Workload", { ...wl, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const pc = await adapter.create("PlannedChange", {
      title: "Retire workload",
      affected_workloads: [dupId],
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.PlannedChange.get(pc.id);
    expect(updated.affected_workloads).toContain(wl.id);
    expect(updated.affected_workloads).not.toContain(dupId);
  });

  it("PlannedChange.operations workload_id is remapped", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const wl = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    const { id: dupId } = await adapter.create("Workload", { ...wl, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const pc = await adapter.create("PlannedChange", {
      title: "Move workload",
      operations: [{ type: "MOVE_WORKLOAD", workload_id: dupId, to_node_id: "some-node" }],
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.PlannedChange.get(pc.id);
    expect(updated.operations[0].workload_id).toBe(wl.id);
  });

  it("PlannedChange.operations object_id with known object_type is remapped", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const node = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...node, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const pc = await adapter.create("PlannedChange", {
      title: "Change lifecycle",
      operations: [{ type: "CHANGE_LIFECYCLE", object_type: "node", object_id: dupId, lifecycle: "maintenance" }],
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updated = adapter._store.PlannedChange.get(pc.id);
    expect(updated.operations[0].object_id).toBe(node.id);
  });

  it("unsafe/unknown structured reference (object_id without object_type) blocks the group", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const node = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: dupId } = await adapter.create("Node", { ...node, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // PlannedChange with object_id matching a deleted ID but NO object_type
    const pc = await adapter.create("PlannedChange", {
      title: "Unknown op",
      operations: [{ type: "GENERIC_PROPERTY_CHANGE", object_id: dupId, field: "notes", value: "test" }],
    });

    const r = await runRepair(ARTIFACT, { adapter });
    // The group should be blocked — not repaired
    expect(r.blocked).toBe(true);
    // The duplicate still exists
    const counts = countByCanonical(adapter._store);
    expect(counts["node:pve7"]).toBe(2);
  });
});

// ---- C3: TIGHTENED SEMANTIC ELIGIBILITY ----
describe("C3: Tightened semantic eligibility", () => {
  it("same canonical artifact + different preferred_node => blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const wl = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    // Create a duplicate with a different preferred_node
    await adapter.create("Workload", { ...wl, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined, preferred_node: "some-other-node" });

    const data = { Workload: Array.from(adapter._store.Workload.values()) };
    const preview = previewRepair(ARTIFACT, data);
    expect(preview.groups.length).toBe(1);
    expect(preview.groups[0].eligible).toBe(false);
    expect(preview.groups[0].blockedReason).toMatch(/projection semantics/);
  });

  it("same canonical artifact + different eligible_alternative_nodes => blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const wl = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    await adapter.create("Workload", { ...wl, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined, eligible_alternative_nodes: ["alt-node-1"] });

    const data = { Workload: Array.from(adapter._store.Workload.values()) };
    const preview = previewRepair(ARTIFACT, data);
    expect(preview.groups[0].eligible).toBe(false);
    expect(preview.groups[0].blockedReason).toMatch(/projection semantics/);
  });

  it("same canonical artifact + different current_environment => blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const wl = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:ssd-intake");
    await adapter.create("Workload", { ...wl, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined, current_environment: "some-env" });

    const data = { Workload: Array.from(adapter._store.Workload.values()) };
    const preview = previewRepair(ARTIFACT, data);
    expect(preview.groups[0].eligible).toBe(false);
  });

  it("different field_provenance overlays (observed) => blocked", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const node = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    // One record with observed overlay, one without
    await adapter.create("Node", {
      ...node, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      field_provenance: JSON.stringify({ lifecycle_state: { observed: "maintenance" } }),
    });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    expect(preview.groups[0].eligible).toBe(false);
    expect(preview.groups[0].blockedReason).toMatch(/field_provenance/);
  });

  it("identical safe overlays (same observed layer on both) => repairable", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const node = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const fp = JSON.stringify({ lifecycle_state: { observed: "active" } });
    // Both duplicates have the SAME non-local overlay
    await adapter.create("Node", {
      ...node, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      field_provenance: fp,
    });
    // Also update the original to have the same overlay
    await adapter.update("Node", node.id, { field_provenance: fp });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);
    expect(preview.groups[0].eligible).toBe(true);
  });

  it("genuine homogeneous incident duplicates remain repairable", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate all canonical records (exact copies)
    for (const entity of ["Node", "ExecutionEnvironment", "Workload"]) {
      const recs = Array.from(adapter._store[entity].values());
      for (const rec of recs) {
        if (!rec.canonical_id) continue;
        const { id, created_date, updated_date, created_by_id, ...rest } = rec;
        await adapter.create(entity, { ...rest });
      }
    }

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);
    expect(r.deleted.length).toBe(7);

    const counts = countByCanonical(adapter._store);
    for (const cid of ["node:futro", "node:pve7", "node:rack1", "node:rig9", "execution-provider:files1", "execution-provider:tools1", "workload:ssd-intake"]) {
      expect(counts[cid]).toBe(1);
    }
  });
});

// ---- C4: HONEST PARTIAL REPAIR FAILURE ----
describe("C4: Honest partial repair failure", () => {
  it("first remap batch succeeds, second fails → partial with successful remaps reported", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Create duplicates for a node and an execution provider (different entities → different bulkUpdate batches)
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const tools1 = Array.from(adapter._store.ExecutionEnvironment.values()).find((r) => r.canonical_id === "execution-provider:tools1");
    const { id: pve7Dup } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });
    const { id: tools1Dup } = await adapter.create("ExecutionEnvironment", { ...tools1, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create references in DIFFERENT entities so they produce separate bulkUpdate calls
    const dec = await adapter.create("Decision", { decision_id: "d1", title: "t1", related_nodes: [pve7Dup] });
    const wl = await adapter.create("Workload", { name: "test-wl", category: "unknown", eligible_execution_providers: [tools1Dup] });

    // Override bulkUpdate to fail on the second call
    const origBulkUpdate = adapter.bulkUpdate.bind(adapter);
    let bulkUpdateCount = 0;
    adapter.bulkUpdate = async (entity, updates) => {
      bulkUpdateCount++;
      if (bulkUpdateCount === 2) throw new Error("Simulated remap failure");
      return origBulkUpdate(entity, updates);
    };

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.failedOperation).toBeTruthy();
    expect(r.failedOperation.phase).toBe("remap");
    // Some remaps succeeded (the first batch)
    expect(r.remapped.length).toBeGreaterThan(0);
  });

  it("first delete succeeds, later delete fails → partial with successful deletes reported", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate all 7 canonical records
    for (const entity of ["Node", "ExecutionEnvironment", "Workload"]) {
      const recs = Array.from(adapter._store[entity].values());
      for (const rec of recs) {
        if (!rec.canonical_id) continue;
        const { id, created_date, updated_date, created_by_id, ...rest } = rec;
        await adapter.create(entity, { ...rest });
      }
    }

    // Override delete to fail after the first successful delete
    const origDelete = adapter.delete.bind(adapter);
    let deleteCount = 0;
    adapter.delete = async (entity, id) => {
      deleteCount++;
      if (deleteCount === 2) throw new Error("Simulated delete failure");
      return origDelete(entity, id);
    };

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.partial).toBe(true);
    expect(r.recoveryRequired).toBe(true);
    expect(r.failedOperation.phase).toBe("delete");
    // One delete succeeded
    expect(r.deleted.length).toBe(1);
  });

  it("mixture of eligible and blocked groups → only eligible groups repaired", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Create an exact duplicate for node:pve7 (eligible)
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create a heterogeneous duplicate for node:rig9 (blocked — different lifecycle_state)
    const rig9 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:rig9");
    await adapter.create("Node", { ...rig9, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined, lifecycle_state: "degraded" });

    const r = await runRepair(ARTIFACT, { adapter });
    // pve7 is repaired, rig9 is blocked
    expect(r.deleted.length).toBe(1);
    expect(r.deleted[0].canonical_id).toBe("node:pve7");

    const counts = countByCanonical(adapter._store);
    expect(counts["node:pve7"]).toBe(1);
    expect(counts["node:rig9"]).toBe(2); // still duplicated (blocked)
  });

  it("retry after partial repair fresh-reads the actual current state", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Duplicate one node
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // First repair attempt: fail the delete
    const origDelete = adapter.delete.bind(adapter);
    let deleteCount = 0;
    adapter.delete = async (entity, id) => {
      deleteCount++;
      if (deleteCount === 1) throw new Error("Simulated failure");
      return origDelete(entity, id);
    };

    const r1 = await runRepair(ARTIFACT, { adapter });
    expect(r1.partial).toBe(true);

    // Restore delete for retry
    adapter.delete = origDelete.bind(adapter);

    // Retry — should fresh-read and find the duplicate still exists
    const r2 = await runRepair(ARTIFACT, { adapter });
    expect(r2.blocked).toBe(false);
    expect(r2.deleted.length).toBe(1);

    const counts = countByCanonical(adapter._store);
    expect(counts["node:pve7"]).toBe(1);
  });
});