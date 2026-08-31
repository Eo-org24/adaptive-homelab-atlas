import { describe, it, expect } from "vitest";
import {
  runImport,
  createMemoryAdapter,
} from "@/lib/canonicalImport";

// Helper: create a minimal V1 artifact
function makeArtifact(entities, relationships, commit = "test-commit", repo = "homelab-foundation") {
  return {
    schema_version: "adaptive-homelab-atlas/v1",
    generated_at: "2026-08-31T00:00:00Z",
    producer: { name: "hlctl", version: "1.0.0" },
    source: { repository: repo, commit, is_dirty: false, content_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
    entities,
    relationships,
  };
}

function node(id) {
  return { schema: "homelab.node/v1", kind: "node", id, provenance: { source_class: "canonical" }, identity: { physical_name: id } };
}
function env(id, runtimeKind = "lxc") {
  return { schema: "homelab.execution-provider/v1", kind: "execution-provider", id, provenance: { source_class: "canonical" }, runtime: { kind: runtimeKind } };
}
function workload(id, displayName) {
  return { schema: "homelab.workload/v1", kind: "workload", id, provenance: { source_class: "canonical" }, display_name: displayName || id };
}

// ---- C6: STALE DEPENDENCY DELETE FAILURE IS PARTIAL IMPORT ----
describe("C6: Stale dependency delete failure is partial import", () => {
  it("stale Dependency delete failure sets partial_failure, not synchronized", async () => {
    const adapter = createMemoryAdapter();

    // First import: create a depends_on relationship between two workloads
    const artifact1 = makeArtifact(
      [node("n1"), workload("w1"), workload("w2")],
      [
        { source: "execution-provider:files1", type: "hosted_on", target: "node:n1" },
      ].filter(() => false) // no relationships yet
        .concat([{ source: "workload:w1", type: "depends_on", target: "workload:w2" }]),
    );
    // Actually, let me use a simpler approach — just create the depends_on directly
    const artifact1b = makeArtifact(
      [node("n1"), workload("w1"), workload("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }],
    );

    await runImport(artifact1b, {}, { adapter, complete: true });

    // Verify the Dependency was created
    const deps = Array.from(adapter._store.Dependency.values());
    expect(deps.length).toBe(1);
    expect(deps[0].relationship_key).toBe("workload:w1|depends_on|workload:w2");

    // Second import: remove the depends_on relationship (stale dependency)
    const artifact2 = makeArtifact(
      [node("n1"), workload("w1"), workload("w2")],
      [], // no relationships — the depends_on is stale
    );

    // Override delete to fail for the stale Dependency
    const origDelete = adapter.delete.bind(adapter);
    adapter.delete = async (entity, id) => {
      if (entity === "Dependency") throw new Error("Simulated delete failure");
      return origDelete(entity, id);
    };

    const r = await runImport(artifact2, {}, { adapter, complete: true });

    // C6: Must be partial_failure, not synchronized
    expect(r.partial).toBe(true);
    expect(r.sync_state).toBe("partial_failure");

    // The stale Dependency remains
    const depsAfter = Array.from(adapter._store.Dependency.values());
    expect(depsAfter.length).toBe(1);

    // The failure is visible in warnings
    expect(r.warnings.some((w) => w.note && w.note.includes("stale dependency deletion failed"))).toBe(true);
  });
});

// ---- C7: VALUE-CHANGE PROVENANCE FOR CANONICAL RELATIONSHIPS ----
describe("C7: Value-change provenance for canonical relationships", () => {
  it("hosted_on changes from one node to another → source_commit/imported_at advance", async () => {
    const adapter = createMemoryAdapter();

    // First import: files1 hosted_on n1
    const artifact1 = makeArtifact(
      [node("n1"), node("n2"), env("files1")],
      [{ source: "execution-provider:files1", type: "hosted_on", target: "node:n1" }],
    );
    await runImport(artifact1, {}, { adapter, complete: true });

    const ee = Array.from(adapter._store.ExecutionEnvironment.values()).find((r) => r.canonical_id === "execution-provider:files1");
    expect(ee.current_host).toBeTruthy();
    const n1 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:n1");
    expect(ee.current_host).toBe(n1.id);

    const importedAt1 = ee.imported_at;
    const sourceCommit1 = ee.source_commit;

    // Wait a bit to ensure imported_at changes
    await new Promise((r) => setTimeout(r, 10));

    // Second import: files1 hosted_on n2 (changed!)
    const artifact2 = makeArtifact(
      [node("n1"), node("n2"), env("files1")],
      [{ source: "execution-provider:files1", type: "hosted_on", target: "node:n2" }],
    );
    await runImport(artifact2, {}, { adapter, complete: true });

    const ee2 = Array.from(adapter._store.ExecutionEnvironment.values()).find((r) => r.canonical_id === "execution-provider:files1");
    const n2 = Array.from(adapter._store.Node.values()).find((r) => r.canonical_id === "node:n2");
    expect(ee2.current_host).toBe(n2.id);

    // C7: Value changed → source_commit/imported_at advance
    expect(ee2.imported_at).not.toBe(importedAt1);
    expect(ee2.source_commit).toBe("test-commit"); // same commit, but imported_at advances
  });

  it("identical hosted_on on next import → source_commit/imported_at remain unchanged, last_seen_* advance", async () => {
    const adapter = createMemoryAdapter();

    const artifact = makeArtifact(
      [node("n1"), env("files1")],
      [{ source: "execution-provider:files1", type: "hosted_on", target: "node:n1" }],
    );

    // First import
    await runImport(artifact, {}, { adapter, complete: true });
    const ee1 = Array.from(adapter._store.ExecutionEnvironment.values()).find((r) => r.canonical_id === "execution-provider:files1");
    const importedAt1 = ee1.imported_at;
    const lastSeenImportAt1 = ee1.last_seen_import_at;

    // Wait
    await new Promise((r) => setTimeout(r, 10));

    // Second import — identical relationship
    await runImport(artifact, {}, { adapter, complete: true });
    const ee2 = Array.from(adapter._store.ExecutionEnvironment.values()).find((r) => r.canonical_id === "execution-provider:files1");

    // C7: Relationship unchanged → source_commit/imported_at remain unchanged
    expect(ee2.imported_at).toBe(importedAt1);
    // last_seen_* advances
    expect(ee2.last_seen_import_at).not.toBe(lastSeenImportAt1);
  });

  it("unchanged canonical depends_on on later import → value-change provenance stable, last_seen_* advances", async () => {
    const adapter = createMemoryAdapter();

    const artifact = makeArtifact(
      [workload("w1"), workload("w2")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }],
    );

    // First import
    await runImport(artifact, {}, { adapter, complete: true });
    const dep1 = Array.from(adapter._store.Dependency.values())[0];
    const sourceCommit1 = dep1.source_commit;
    const importedAt1 = dep1.imported_at;
    const lastSeenImportAt1 = dep1.last_seen_import_at;

    // Wait
    await new Promise((r) => setTimeout(r, 10));

    // Second import — identical depends_on
    await runImport(artifact, {}, { adapter, complete: true });
    const dep2 = Array.from(adapter._store.Dependency.values())[0];

    // C7: Value unchanged → source_commit/imported_at remain stable
    expect(dep2.source_commit).toBe(sourceCommit1);
    expect(dep2.imported_at).toBe(importedAt1);
    // last_seen_* advances
    expect(dep2.last_seen_import_at).not.toBe(lastSeenImportAt1);
  });

  it("real canonical dependency change → new value-change provenance", async () => {
    const adapter = createMemoryAdapter();

    // First import: w1 depends_on w2
    const artifact1 = makeArtifact(
      [workload("w1"), workload("w2"), workload("w3")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w2" }],
    );
    await runImport(artifact1, {}, { adapter, complete: true });
    const dep1 = Array.from(adapter._store.Dependency.values())[0];
    const importedAt1 = dep1.imported_at;

    // Wait
    await new Promise((r) => setTimeout(r, 10));

    // Second import: w1 depends_on w3 (changed target!)
    const artifact2 = makeArtifact(
      [workload("w1"), workload("w2"), workload("w3")],
      [{ source: "workload:w1", type: "depends_on", target: "workload:w3" }],
    );
    await runImport(artifact2, {}, { adapter, complete: true });

    // The old dependency should be deleted (stale), new one created
    const deps = Array.from(adapter._store.Dependency.values());
    expect(deps.length).toBe(1);
    const dep2 = deps[0];
    expect(dep2.relationship_key).toBe("workload:w1|depends_on|workload:w3");

    // C7: New dependency → value-change provenance advances
    expect(dep2.imported_at).not.toBe(importedAt1);
  });
});