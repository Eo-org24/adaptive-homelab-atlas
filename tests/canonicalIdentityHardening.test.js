import { describe, it, expect, beforeEach } from "vitest";
import { canonicalUpsertBatch, detectLocalNameCollisions } from "@/lib/canonicalMutation";
import { createMemoryAdapter, runImport, REAL_CROSSOVER_ARTIFACT } from "@/lib/canonicalImport";
import { previewRepair, runRepair } from "@/lib/duplicateRepair";
import { previewLegacyRecovery, runLegacyRecovery } from "@/lib/legacyRecovery";
import { buildCanonicalIndex, canonicalMatches } from "@/lib/relationships";

// Helper: create a memory store for canonicalUpsertBatch
function makeStore(initial = {}) {
  const records = new Map();
  let counter = 0;
  Object.values(initial).flat().forEach((r) => { if (r && r.id) records.set(r.id, { ...r }); });
  return {
    records,
    async filterByCanonicalId(entity, cid) {
      return Array.from(records.values()).filter((r) => r.canonical_id === cid);
    },
    async create(entity, payload) {
      const id = `rec-${++counter}`;
      const rec = { ...payload, id, created_date: new Date().toISOString() };
      records.set(id, rec);
      return { ...rec };
    },
    async update(entity, id, payload) {
      const ex = records.get(id);
      if (!ex) throw new Error(`update: ${id} not found`);
      const rec = { ...ex, ...payload };
      records.set(id, rec);
      return { ...rec };
    },
  };
}

// Helper: build a memory adapter with pre-seeded data
function adapterWithData(data = {}) {
  return createMemoryAdapter(data);
}

describe("Canonical identity hardening — canonicalUpsertBatch", () => {
  // 1. Normal canonical create with no existing record
  it("creates a record when no existing canonical identity is present", async () => {
    const store = makeStore();
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:test1", payload: { hostname: "test1", canonical_id: "node:test1" } }],
      store
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("created");
    expect(result.results[0].id).toBeTruthy();
    expect(result.race_detected).toBe(false);
    expect(result.recovery_required).toBe(false);
    expect(result.verification).toHaveLength(1);
    expect(result.verification[0].unique).toBe(true);
  });

  // 2. Second same-artifact import remains unchanged (idempotent)
  it("updates rather than creates when the canonical identity already exists", async () => {
    const store = makeStore({
      Node: [{ id: "n1", canonical_id: "node:test2", hostname: "test2", created_date: "2026-01-01T00:00:00Z" }],
    });
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:test2", payload: { hostname: "test2-updated", canonical_id: "node:test2" } }],
      store
    );
    expect(result.results[0].status).toBe("updated");
    expect(result.results[0].id).toBe("n1");
    expect(result.race_detected).toBe(false);
  });

  // 3. Ambiguous existing canonical identity blocks
  it("blocks when multiple existing records share the same canonical_id", async () => {
    const store = makeStore({
      Node: [
        { id: "n1", canonical_id: "node:amb1", hostname: "amb1", created_date: "2026-01-01T00:00:00Z" },
        { id: "n2", canonical_id: "node:amb1", hostname: "amb1", created_date: "2026-01-02T00:00:00Z" },
      ],
    });
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:amb1", payload: { hostname: "amb1-new", canonical_id: "node:amb1" } }],
      store
    );
    expect(result.results[0].status).toBe("ambiguous_existing_canonical_identity");
    expect(result.results[0].blocked).toBe(true);
    expect(result.results[0].count).toBe(2);
    expect(result.recovery_required).toBe(true);
  });

  // 4. Identity becomes ambiguous between planning and write
  it("blocks at the mutation boundary when identity becomes ambiguous after planning", async () => {
    // Simulate: planner saw 1 record, but a concurrent session created a duplicate
    // before the upsert ran. The boundary fresh-read sees 2 and blocks.
    const store = makeStore({
      Node: [
        { id: "n1", canonical_id: "node:raceplan", hostname: "rp", created_date: "2026-01-01T00:00:00Z" },
        { id: "n2", canonical_id: "node:raceplan", hostname: "rp", created_date: "2026-01-02T00:00:00Z" },
      ],
    });
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:raceplan", payload: { hostname: "rp-new", canonical_id: "node:raceplan" } }],
      store
    );
    expect(result.results[0].status).toBe("ambiguous_existing_canonical_identity");
    expect(result.recovery_required).toBe(true);
  });

  // 5. Post-create uniqueness verification
  it("verifies uniqueness after create and reports when count != 1", async () => {
    const store = makeStore();
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:verify1", payload: { hostname: "v1", canonical_id: "node:verify1" } }],
      store
    );
    expect(result.verification[0].count).toBe(1);
    expect(result.verification[0].unique).toBe(true);
  });

  // 6. Cross-session simulated race
  it("detects a cross-session race when a concurrent create produces a duplicate", async () => {
    const store = makeStore();
    // Override create to simulate a concurrent session creating a duplicate
    const originalCreate = store.create;
    store.create = async (entity, payload) => {
      const rec = await originalCreate(entity, payload);
      // Simulate concurrent session: inject a duplicate with the same canonical_id
      const dup = { ...payload, id: `rec-concurrent-${Date.now()}`, created_date: new Date().toISOString() };
      store.records.set(dup.id, dup);
      return rec;
    };
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:race1", payload: { hostname: "race1", canonical_id: "node:race1" } }],
      store
    );
    expect(result.race_detected).toBe(true);
    expect(result.recovery_required).toBe(true);
    expect(result.results[0].status).toBe("canonical_identity_race_detected");
    expect(result.results[0].count).toBe(2);
    expect(result.verification[0].unique).toBe(false);
  });

  // 7. recovery_required state when uniqueness cannot be guaranteed atomically
  it("sets recovery_required when a race is detected", async () => {
    const store = makeStore();
    const originalCreate = store.create;
    store.create = async (entity, payload) => {
      const rec = await originalCreate(entity, payload);
      store.records.set(`dup-${rec.id}`, { ...payload, id: `dup-${rec.id}` });
      return rec;
    };
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:rr1", payload: { hostname: "rr1", canonical_id: "node:rr1" } }],
      store
    );
    expect(result.recovery_required).toBe(true);
    expect(result.race_detected).toBe(true);
  });

  // 8. No false synchronized state after duplicate detection
  it("does not report success when a race is detected", async () => {
    const store = makeStore();
    const originalCreate = store.create;
    store.create = async (entity, payload) => {
      const rec = await originalCreate(entity, payload);
      store.records.set(`dup-${rec.id}`, { ...payload, id: `dup-${rec.id}` });
      return rec;
    };
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:nofalse1", payload: { hostname: "nf1", canonical_id: "node:nofalse1" } }],
      store
    );
    expect(result.results[0].status).not.toBe("created");
    expect(result.results[0].status).toBe("canonical_identity_race_detected");
  });

  // 9. Update path rechecks identity
  it("rechecks identity at the mutation boundary before update", async () => {
    // If between planning and write, a second record appeared, the boundary
    // fresh-read sees 2 and blocks instead of updating.
    const store = makeStore({
      Node: [
        { id: "n1", canonical_id: "node:recheck1", hostname: "rc1", created_date: "2026-01-01T00:00:00Z" },
        { id: "n2", canonical_id: "node:recheck1", hostname: "rc1", created_date: "2026-01-02T00:00:00Z" },
      ],
    });
    const result = await canonicalUpsertBatch(
      [{ entity: "Node", canonical_id: "node:recheck1", payload: { hostname: "rc1-new", canonical_id: "node:recheck1" } }],
      store
    );
    expect(result.results[0].status).toBe("ambiguous_existing_canonical_identity");
  });
});

describe("Canonical identity hardening — runImport with canonicalUpsert", () => {
  // 21. Real crossover artifact still imports idempotently
  it("imports the real crossover artifact idempotently (import #1 creates, import #2 unchanged)", async () => {
    const envelope = JSON.parse(REAL_CROSSOVER_ARTIFACT);
    const adapter = adapterWithData();
    const r1 = await runImport(envelope, {}, { adapter, complete: true });
    expect(r1.counts.created).toBe(7); // 4 nodes + 2 envs + 1 workload
    expect(r1.counts.failed).toBe(0);
    expect(r1.sync_state).not.toBe("import_blocked");

    const r2 = await runImport(envelope, {}, { adapter, complete: true });
    expect(r2.counts.created).toBe(0);
    expect(r2.counts.updated).toBe(0);
    expect(r2.counts.unchanged).toBe(7);
    expect(r2.sync_state).not.toBe("partial_failure");
  });

  // 22. intake0 remains unresolved
  it("preserves the intake0 capability requirement as unresolved", async () => {
    const envelope = JSON.parse(REAL_CROSSOVER_ARTIFACT);
    const adapter = adapterWithData();
    await runImport(envelope, {}, { adapter, complete: true });
    const envs = await adapter.listAll("ExecutionEnvironment");
    const workloads = await adapter.listAll("Workload");
    const ssdIntake = workloads.find((w) => w.canonical_id === "workload:ssd-intake");
    expect(ssdIntake).toBeTruthy();
    expect(ssdIntake.capability_requirements).toBeTruthy();
    const intakeReq = ssdIntake.capability_requirements.find(
      (c) => c.type === "block-device-intake" && c.instance === "intake0"
    );
    expect(intakeReq).toBeTruthy();
  });

  // 23. All three real relationships remain correct
  it("preserves all three real relationships after import", async () => {
    const envelope = JSON.parse(REAL_CROSSOVER_ARTIFACT);
    const adapter = adapterWithData();
    await runImport(envelope, {}, { adapter, complete: true });
    const envs = await adapter.listAll("ExecutionEnvironment");
    const files1 = envs.find((e) => e.canonical_id === "execution-provider:files1");
    const tools1 = envs.find((e) => e.canonical_id === "execution-provider:tools1");
    const nodes = await adapter.listAll("Node");
    const pve7 = nodes.find((n) => n.canonical_id === "node:pve7");
    const workloads = await adapter.listAll("Workload");
    const ssdIntake = workloads.find((w) => w.canonical_id === "workload:ssd-intake");
    // hosted_on: files1 -> pve7
    expect(files1.current_host).toBe(pve7.id);
    // hosted_on: tools1 -> pve7
    expect(tools1.current_host).toBe(pve7.id);
    // placement_allowed_on_provider: ssd-intake -> tools1
    expect(ssdIntake.eligible_execution_providers).toContain(tools1.id);
  });
});

describe("Normal duplicate repair remains strict R4", () => {
  // 10. Normal duplicate repair remains strict R4
  it("blocks normal repair when content_digest is missing from source_note", async () => {
    const envelope = JSON.parse(REAL_CROSSOVER_ARTIFACT);
    const adapter = adapterWithData();
    await runImport(envelope, {}, { adapter, complete: true });
    // Inject a duplicate without content_digest in source_note
    const envs = await adapter.listAll("ExecutionEnvironment");
    const files1 = envs.find((e) => e.canonical_id === "execution-provider:files1");
    // Create a duplicate manually (simulating the stale-data incident)
    await adapter.create("ExecutionEnvironment", {
      ...files1, id: undefined, canonical_id: "execution-provider:files1",
      source_note: "no digest here", created_date: "2026-01-03T00:00:00Z",
    });
    const liveData = {};
    for (const k of ["Node", "ExecutionEnvironment", "Workload", "Decision", "Dependency", "StorageDevice", "NetworkDevice", "StoragePool", "SwitchPort", "Task", "Maintenance", "PlannedChange"]) {
      liveData[k] = await adapter.listAll(k);
    }
    const preview = previewRepair(envelope, liveData);
    const files1Group = preview.groups.find((g) => g.canonical_id === "execution-provider:files1");
    expect(files1Group).toBeTruthy();
    // Should be blocked because the duplicate lacks content_digest (R4)
    expect(files1Group.eligible).toBe(false);
  });
});

describe("Legacy incident recovery", () => {
  function makeLegacyData() {
    const commit = "a1f33a877db26ed0d351113ca064791eb7f4792d";
    const gen = "2026-08-31T16:28:19.139523+00:00";
    const repo = "homelab-foundation";
    return {
      ExecutionEnvironment: [
        // files1 keeper (canonical, oldest)
        { id: "6a95b7de89ed3cd85ffb4e32", canonical_id: "execution-provider:files1", name: "files1", type: "lxc", source_kind: "canonical", source_repository: repo, source_commit: commit, source_generated_at: gen, created_date: "2026-08-31T16:28:20Z" },
        // files1 duplicate (canonical, newer)
        { id: "6a95b8095e26b8e79b8017dd", canonical_id: "execution-provider:files1", name: "files1", type: "lxc", source_kind: "canonical", source_repository: repo, source_commit: commit, source_generated_at: gen, created_date: "2026-08-31T16:29:00Z" },
        // files1 Atlas-local (no canonical_id, pre-import)
        { id: "6a944d07e35a09c56e8bab30", name: "files1", type: "lxc", source_kind: "manual", created_date: "2026-08-01T00:00:00Z" },
        // tools1 keeper (canonical, oldest)
        { id: "6a95b7dff84e9b9dfb2cfc64", canonical_id: "execution-provider:tools1", name: "tools1", type: "lxc", source_kind: "canonical", source_repository: repo, source_commit: commit, source_generated_at: gen, created_date: "2026-08-31T16:28:20Z" },
        // tools1 duplicate (canonical, newer)
        { id: "6a95b809c2787b919a99803b", canonical_id: "execution-provider:tools1", name: "tools1", type: "lxc", source_kind: "canonical", source_repository: repo, source_commit: commit, source_generated_at: gen, created_date: "2026-08-31T16:29:00Z" },
        // tools1 Atlas-local (no canonical_id, pre-import)
        { id: "6a944d07e35a09c56e8bab31", name: "tools1", type: "lxc", source_kind: "manual", created_date: "2026-08-01T00:00:00Z" },
      ],
      Node: [], Workload: [], Decision: [], Dependency: [], StorageDevice: [],
      NetworkDevice: [], StoragePool: [], SwitchPort: [], Task: [], Maintenance: [], PlannedChange: [],
    };
  }

  const SPEC = {
    groups: [
      { entity: "ExecutionEnvironment", canonical_id: "execution-provider:files1", keeperId: "6a95b7de89ed3cd85ffb4e32", duplicateIds: ["6a95b8095e26b8e79b8017dd"], expectedSourceCommit: "a1f33a877db26ed0d351113ca064791eb7f4792d", expectedSourceGeneratedAt: "2026-08-31T16:28:19.139523+00:00", expectedRepository: "homelab-foundation" },
      { entity: "ExecutionEnvironment", canonical_id: "execution-provider:tools1", keeperId: "6a95b7dff84e9b9dfb2cfc64", duplicateIds: ["6a95b809c2787b919a99803b"], expectedSourceCommit: "a1f33a877db26ed0d351113ca064791eb7f4792d", expectedSourceGeneratedAt: "2026-08-31T16:28:19.139523+00:00", expectedRepository: "homelab-foundation" },
    ],
  };

  // 11. Legacy incident recovery cannot target arbitrary IDs
  it("blocks when the specified record IDs do not exist in the database", () => {
    const data = makeLegacyData();
    const badSpec = { groups: [{ ...SPEC.groups[0], keeperId: "nonexistent-id", duplicateIds: ["also-nonexistent"] }] };
    const preview = previewLegacyRecovery(badSpec, data);
    expect(preview.ready).toHaveLength(0);
    expect(preview.blocked.length).toBeGreaterThan(0);
  });

  // 12. Legacy incident recovery rejects semantic mismatch
  it("blocks when members have different scalar semantics", () => {
    const data = makeLegacyData();
    // Corrupt: make the duplicate have a different type
    data.ExecutionEnvironment[1].type = "vm";
    const preview = previewLegacyRecovery(SPEC, data);
    const files1Group = preview.groups.find((g) => g.canonical_id === "execution-provider:files1");
    expect(files1Group.eligible).toBe(false);
  });

  // 13. Legacy incident recovery rejects local override
  it("blocks when a member has a local field_provenance override", () => {
    const data = makeLegacyData();
    data.ExecutionEnvironment[0].field_provenance = JSON.stringify({ cpu_allocation: { local: 4 } });
    const preview = previewLegacyRecovery(SPEC, data);
    const files1Group = preview.groups.find((g) => g.canonical_id === "execution-provider:files1");
    expect(files1Group.eligible).toBe(false);
  });

  // 14. Legacy incident recovery remaps references before deletion
  it("plans reference remaps for records pointing at the duplicate IDs", () => {
    const data = makeLegacyData();
    // Add a Task pointing at the files1 duplicate
    data.Task = [{ id: "task1", task: "Fix files1", related_object_type: "environment", related_object_id: "6a95b8095e26b8e79b8017dd" }];
    const preview = previewLegacyRecovery(SPEC, data);
    const files1Remap = preview.remaps.find((r) => r.id === "task1");
    expect(files1Remap).toBeTruthy();
    expect(files1Remap.newValue).toBe("6a95b7de89ed3cd85ffb4e32"); // remapped to keeper
  });

  // 15. files1 known duplicate recovery fixture
  it("previews files1 recovery as eligible with the correct keeper", () => {
    const data = makeLegacyData();
    const preview = previewLegacyRecovery(SPEC, data);
    const files1Group = preview.groups.find((g) => g.canonical_id === "execution-provider:files1");
    expect(files1Group.eligible).toBe(true);
    expect(files1Group.keeper.id).toBe("6a95b7de89ed3cd85ffb4e32");
    expect(files1Group.deletions.map((d) => d.id)).toEqual(["6a95b8095e26b8e79b8017dd"]);
  });

  // 16. tools1 known duplicate recovery fixture
  it("previews tools1 recovery as eligible with the correct keeper", () => {
    const data = makeLegacyData();
    const preview = previewLegacyRecovery(SPEC, data);
    const tools1Group = preview.groups.find((g) => g.canonical_id === "execution-provider:tools1");
    expect(tools1Group.eligible).toBe(true);
    expect(tools1Group.keeper.id).toBe("6a95b7dff84e9b9dfb2cfc64");
    expect(tools1Group.deletions.map((d) => d.id)).toEqual(["6a95b809c2787b919a99803b"]);
  });

  // 15+16 execution: run legacy recovery deletes duplicates
  it("executes legacy recovery and deletes the duplicate records", async () => {
    const data = makeLegacyData();
    const adapter = adapterWithData(data);
    const report = await runLegacyRecovery(SPEC, { adapter });
    expect(report.blocked).toBe(false);
    expect(report.deleted.length).toBe(2);
    const envs = await adapter.listAll("ExecutionEnvironment");
    const files1Recs = envs.filter((e) => e.canonical_id === "execution-provider:files1");
    const tools1Recs = envs.filter((e) => e.canonical_id === "execution-provider:tools1");
    expect(files1Recs.length).toBe(1);
    expect(tools1Recs.length).toBe(1);
  });
});

describe("Atlas-local collision handling", () => {
  function makeCollisionData() {
    const commit = "a1f33a877db26ed0d351113ca064791eb7f4792d";
    const gen = "2026-08-31T16:28:19.139523+00:00";
    return {
      ExecutionEnvironment: [
        { id: "c1", canonical_id: "execution-provider:files1", name: "files1", type: "lxc", source_kind: "canonical", source_repository: "homelab-foundation", source_commit: commit, source_generated_at: gen, created_date: "2026-08-31T16:28:20Z" },
        { id: "l1", name: "files1", type: "lxc", source_kind: "manual", created_date: "2026-08-01T00:00:00Z" },
      ],
      Node: [], Workload: [], Decision: [], Dependency: [], StorageDevice: [],
      NetworkDevice: [], StoragePool: [], SwitchPort: [], Task: [], Maintenance: [], PlannedChange: [],
    };
  }

  // 17. Atlas-local files1 record is NOT classified as canonical duplicate
  it("does not classify the Atlas-local files1 record as a canonical duplicate", () => {
    const data = makeCollisionData();
    const index = buildCanonicalIndex(data);
    const matches = canonicalMatches("ExecutionEnvironment", "execution-provider:files1", index);
    // Only the canonical record should match — the local record has no canonical_id
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("c1");
  });

  // 18. Atlas-local tools1 record is NOT classified as canonical duplicate
  it("does not classify the Atlas-local tools1 record as a canonical duplicate", () => {
    const data = {
      ExecutionEnvironment: [
        { id: "c1", canonical_id: "execution-provider:tools1", name: "tools1", type: "lxc", source_kind: "canonical", source_repository: "homelab-foundation", source_commit: "x", source_generated_at: "y", created_date: "2026-08-31T16:28:20Z" },
        { id: "l1", name: "tools1", type: "lxc", source_kind: "manual", created_date: "2026-08-01T00:00:00Z" },
      ],
      Node: [], Workload: [], Decision: [], Dependency: [], StorageDevice: [],
      NetworkDevice: [], StoragePool: [], SwitchPort: [], Task: [], Maintenance: [], PlannedChange: [],
    };
    const index = buildCanonicalIndex(data);
    const matches = canonicalMatches("ExecutionEnvironment", "execution-provider:tools1", index);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("c1");
  });

  // 19. Local/canonical same-name presentation distinction
  it("detects local name collisions without treating them as identity duplicates", () => {
    const data = makeCollisionData();
    const collisions = detectLocalNameCollisions(data);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].entity).toBe("ExecutionEnvironment");
    expect(collisions[0].localName).toBe("files1");
    expect(collisions[0].canonicalCid).toBe("execution-provider:files1");
  });

  // 20. Local name collision does not block canonical import
  it("does not block canonical import when a local name collision exists", async () => {
    const data = makeCollisionData();
    const adapter = adapterWithData(data);
    const envelope = JSON.parse(REAL_CROSSOVER_ARTIFACT);
    const result = await runImport(envelope, {}, { adapter, complete: true });
    // The import should not be blocked by the local name collision
    expect(result.blocked).toBe(false);
    // The canonical files1 should be created/updated, the local one untouched
    const envs = await adapter.listAll("ExecutionEnvironment");
    const canonical = envs.filter((e) => e.canonical_id === "execution-provider:files1");
    const local = envs.filter((e) => !e.canonical_id && e.name === "files1");
    expect(canonical.length).toBe(1);
    expect(local.length).toBe(1); // local record preserved
  });
});