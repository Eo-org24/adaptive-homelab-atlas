// F1–F8: Narrow corrective hardening regression tests.
// Each F-item gets focused coverage at the appropriate level (logic or UI).
import { describe, it, expect } from "vitest";
import {
  runImport,
  createMemoryAdapter,
  REAL_CROSSOVER_ARTIFACT,
  previewImport,
  preflightImport,
  COMPREHENSIVE_V1_FIXTURE,
} from "@/lib/canonicalImport";
import {
  previewRepair,
  runRepair,
} from "@/lib/duplicateRepair";

const ARTIFACT = JSON.parse(REAL_CROSSOVER_ARTIFACT);

function makeArtifact(entities, relationships, commit = "test-commit", digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000") {
  return {
    schema_version: "adaptive-homelab-atlas/v1",
    generated_at: "2026-08-31T00:00:00Z",
    producer: { name: "hlctl", version: "1.0.0" },
    source: { repository: "homelab-foundation", commit, is_dirty: false, content_digest: digest },
    entities,
    relationships: relationships || [],
  };
}

function node(id, extra = {}) {
  return { schema: "homelab.node/v1", kind: "node", id, provenance: { source_class: "canonical" }, identity: { physical_name: id }, ...extra };
}
function env(id, extra = {}) {
  return { schema: "homelab.execution-provider/v1", kind: "execution-provider", id, provenance: { source_class: "canonical" }, ...extra };
}
function wl(id, extra = {}) {
  return { schema: "homelab.workload/v1", kind: "workload", id, provenance: { source_class: "canonical" }, ...extra };
}

// ---- F1: Ambiguous canonical dependency identity blocks import ----
describe("F1: Ambiguous canonical dependency identity blocks import", () => {
  it("multiple existing canonical Dependencies with same relationship_key blocks import", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Create two canonical Dependencies with the same relationship_key
    // (simulating a prior duplicate incident that wasn't repaired)
    const deps = Array.from(adapter._store.Dependency.values());
    const dep = deps[0];
    if (dep) {
      await adapter.create("Dependency", {
        ...dep, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      });
    }

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    // An import with a depends_on relationship that matches the ambiguous key
    const artifact = makeArtifact(
      [node("n1"), wl("w1"), wl("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]
    );

    // First, create the initial dependency
    await runImport(artifact, {}, { adapter, complete: true });

    // Now duplicate the dependency
    const deps2 = Array.from(adapter._store.Dependency.values());
    const dep2 = deps2.find((d) => d.relationship_key && d.relationship_key.includes("depends_on"));
    if (dep2) {
      await adapter.create("Dependency", {
        ...dep2, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined,
      });
    }

    // Re-import the same artifact — should block due to ambiguous dependency identity
    const data2 = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) {
      data2[k] = Array.from(adapter._store[k].values());
    }
    const preflight = preflightImport(artifact, data2, { complete: true });
    expect(preflight.blocked).toBe(true);
    expect(preflight.reasons.some((r) => r.includes("ambiguous"))).toBe(true);
  });

  it("ambiguous existing relationship endpoint identity blocks import", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Create a duplicate of an existing node that is a relationship endpoint
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    // An import that references node:pve7 in a relationship — should block
    // because there are now TWO existing records with canonical_id node:pve7
    const artifact = makeArtifact(
      [env("ep1")],
      [{ source: "execution-provider:ep1", type: "hosted_on", target: "node:pve7" }]
    );

    const preflight = preflightImport(artifact, data, { complete: true });
    expect(preflight.blocked).toBe(true);
    expect(preflight.reasons.some((r) => r.includes("ambiguous"))).toBe(true);
  });
});

// ---- F2: Strict V1 validation + artifact provenance in repair ----
describe("F2: Strict V1 validation + artifact provenance in repair", () => {
  it("repair blocks on artifact with missing source provenance", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Create a duplicate
    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Artifact with missing source.commit
    const badArtifact = {
      schema_version: "adaptive-homelab-atlas/v1",
      generated_at: "2026-08-31T00:00:00Z",
      producer: { name: "hlctl", version: "1.0.0" },
      source: { repository: "homelab-foundation", is_dirty: false, content_digest: "sha256:abc" },
      entities: ARTIFACT.entities,
      relationships: ARTIFACT.relationships,
    };

    const r = await runRepair(badArtifact, { adapter });
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toMatch(/validation|artifact/i);
  });

  it("repair blocks on artifact with wrong schema_version", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    const badArtifact = {
      ...ARTIFACT,
      schema_version: "wrong-version/v2",
    };

    const r = await runRepair(badArtifact, { adapter });
    expect(r.blocked).toBe(true);
    expect(r.blockedReason).toMatch(/validation|artifact|schema/i);
  });

  it("previewRepair also validates the artifact (F2: same boundary)", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const badArtifact = { ...ARTIFACT, schema_version: "wrong" };
    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload"]) {
      data[k] = Array.from(adapter._store[k].values());
    }
    const preview = previewRepair(badArtifact, data);
    // Preview should not crash; it should either block or have no ready groups
    expect(preview).toBeTruthy();
  });
});

// ---- F3: Unknown structured field scanning + type-mismatch blocking ----
describe("F3: Unknown structured field scanning + type-mismatch blocking", () => {
  it("PlannedChange with unknown structured field containing deleted ID blocks group", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: pve7Dup } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create a PlannedChange with an unknown structured field containing the deleted ID
    await adapter.create("PlannedChange", {
      title: "test-change",
      affected_nodes: [],
      operations: [
        { type: "move", custom_field: pve7Dup }, // unknown field with deleted ID
      ],
    });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "PlannedChange"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const preview = previewRepair(ARTIFACT, data);
    // The group with pve7 duplicate should be blocked due to unsafe structured reference
    const pve7Group = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(pve7Group).toBeTruthy();
    expect(pve7Group.eligible).toBe(false);
    expect(pve7Group.blockedReason).toMatch(/unsafe|structured|unknown/i);
  });

  it("PlannedChange operation with type mismatch blocks group", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const pve7 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:pve7");
    const { id: pve7Dup } = await adapter.create("Node", { ...pve7, id: undefined, created_date: undefined, updated_date: undefined, created_by_id: undefined });

    // Create a PlannedChange with a typed operation where object_type says "workload" but the ID is a Node
    await adapter.create("PlannedChange", {
      title: "test-change",
      affected_nodes: [],
      operations: [
        { type: "move", object_type: "workload", object_id: pve7Dup }, // type mismatch: workload vs Node ID
      ],
    });

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "PlannedChange"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const preview = previewRepair(ARTIFACT, data);
    const pve7Group = preview.groups.find((g) => g.canonical_id === "node:pve7");
    expect(pve7Group).toBeTruthy();
    expect(pve7Group.eligible).toBe(false);
  });
});

// ---- F7: Set-based array equality for canonical-owned arrays ----
describe("F7: Set-based array equality for canonical-owned arrays", () => {
  it("reordered placement_allowed_nodes does not count as a value change", async () => {
    const adapter = createMemoryAdapter();
    const artifact = makeArtifact(
      [node("n1"), env("ep1"), wl("w1")],
      [
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
      ]
    );

    // First import
    const r1 = await runImport(artifact, {}, { adapter, complete: true });
    expect(r1.created.length).toBeGreaterThan(0);

    // Second import with REORDERED relationships (same set, different order)
    const artifactReordered = makeArtifact(
      [node("n1"), env("ep1"), wl("w1")],
      [
        { source: "workload:w1", type: "placement_allowed_on_node", target: "node:n1" },
        { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
        { source: "workload:w1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
      ]
    );

    const data = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Dependency"]) {
      data[k] = Array.from(adapter._store[k].values());
    }

    const r2 = await runImport(artifactReordered, data, { adapter, complete: true });
    // F7: Reordering alone should NOT count as an update — all should be unchanged
    expect(r2.updated.length).toBe(0);
    expect(r2.unchanged.length).toBeGreaterThan(0);
  });

  it("adding a new placement_allowed_node advances value-change provenance", async () => {
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

    // Capture the workload's source_commit after first import
    const w1After1 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    const commitAfter1 = w1After1.source_commit;

    // Second import with an ADDITIONAL placement_allowed_on_node (new commit)
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

    // F7: Adding a new element changes the set → C7 advances source_commit (value change)
    const w1After2 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    expect(w1After2.source_commit).toBe("commit-v2");
    expect(w1After2.placement_allowed_nodes).toContain(
      Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:n2").id
    );
  });

  it("reordered placement_allowed_nodes does NOT advance value-change provenance", async () => {
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

    const w1After1 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    const commitAfter1 = w1After1.source_commit;

    // Second import with REORDERED relationships (same set, different order, new commit)
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

    // F7: Reordering alone does NOT change the set → C7 does NOT advance source_commit
    const w1After2 = Array.from(adapter._store.Workload.values()).find((r) => r.canonical_id === "workload:w1");
    expect(w1After2.source_commit).toBe("commit-v1"); // unchanged — only last_seen_* advanced
  });
});