import { describe, it, expect, beforeEach } from "vitest";
import {
  runImport,
  createMemoryAdapter,
  REAL_CROSSOVER_ARTIFACT,
} from "@/lib/canonicalImport";
import {
  previewRepair,
  runRepair,
  selectKeeper,
  artifactCanonicalIds,
} from "@/lib/duplicateRepair";

const ARTIFACT = JSON.parse(REAL_CROSSOVER_ARTIFACT);
const ARTIFACT_STR = REAL_CROSSOVER_ARTIFACT;
const INCIDENT_COMMIT = "a1f33a877db26ed0d351113ca064791eb7f4792d";
const INCIDENT_REPO = "homelab-foundation";

const EXPECTED_CIDS = [
  "node:futro", "node:pve7", "node:rack1", "node:rig9",
  "execution-provider:files1", "execution-provider:tools1",
  "workload:ssd-intake",
];

// Count records per canonical_id across all entity kinds in the store.
function countByCanonical(store) {
  const counts = {};
  for (const entity of ["Node", "ExecutionEnvironment", "Workload"]) {
    const map = store[entity];
    if (!map) continue;
    for (const rec of map.values()) {
      if (rec.canonical_id) counts[rec.canonical_id] = (counts[rec.canonical_id] || 0) + 1;
    }
  }
  return counts;
}

// ---- §1: STALE CALLER DATASET + FIRST IMPORT ----
describe("§1: stale caller dataset + first import", () => {
  it("first import with empty caller data creates all 7 entities", async () => {
    const adapter = createMemoryAdapter();
    const r = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r.counts.created).toBe(7);
    expect(r.counts.failed).toBe(0);
    expect(r.blocked).toBe(false);
  });
});

// ---- §2: SAME STALE DATASET + SECOND IMPORT ----
describe("§2: same stale dataset + second import", () => {
  it("second import with SAME stale empty caller data does not duplicate", async () => {
    const adapter = createMemoryAdapter();
    // Run #1 with stale empty caller data
    const r1 = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r1.counts.created).toBe(7);

    // Run #2 with the SAME stale empty caller data — runImport must fresh-read
    const r2 = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r2.counts.created).toBe(0);
    expect(r2.counts.updated).toBe(0);
    expect(r2.counts.unchanged).toBe(7);
    expect(r2.counts.conflicts).toBe(0);
  });
});

// ---- §3: EXACTLY ONE PERSISTENT CANONICAL RECORD AFTER BOTH ----
describe("§3: exactly one persistent canonical record after both", () => {
  it("persistent store has exactly one record per canonical_id after double import", async () => {
    const adapter = createMemoryAdapter();
    await runImport(ARTIFACT, {}, { adapter, complete: true });
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    const counts = countByCanonical(adapter._store);
    for (const cid of EXPECTED_CIDS) {
      expect(counts[cid]).toBe(1);
    }
  });
});

// ---- §4: FRESH-READ FAILURE BLOCKS BEFORE WRITES ----
describe("§4: fresh-read failure blocks before writes", () => {
  it("listAll failure blocks import and creates nothing", async () => {
    const adapter = createMemoryAdapter();
    // Override listAll to throw
    adapter.listAll = async () => { throw new Error("connection refused"); };

    const r = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r.blocked).toBe(true);
    expect(r.blockedReasons[0]).toMatch(/incomplete existing-dataset load/);
    expect(r.sync_state).toBe("import_blocked");

    // Nothing was created
    const counts = countByCanonical(adapter._store);
    expect(Object.keys(counts).length).toBe(0);
  });
});

// ---- §7: DUPLICATE-REPAIR DRY-RUN ----
describe("§7: duplicate-repair dry-run", () => {
  it("preview detects duplicate groups, selects keepers, proposes deletions and remaps", () => {
    const adapter = createMemoryAdapter();
    // Manually insert duplicate records for node:pve7
    const now = new Date().toISOString();
    const a = adapter.create("Node", {
      canonical_id: "node:pve7", hostname: "pve7", source_kind: "canonical",
      source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
      lifecycle_state: "active",
    });
    // Simulate async timing: second record has slightly later created_date
    const b = adapter.create("Node", {
      canonical_id: "node:pve7", hostname: "pve7", source_kind: "canonical",
      source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
      lifecycle_state: "active",
    });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);

    expect(preview.groups.length).toBe(1);
    expect(preview.groups[0].canonical_id).toBe("node:pve7");
    expect(preview.groups[0].eligible).toBe(true);
    expect(preview.groups[0].memberCount).toBe(2);
    expect(preview.groups[0].deletions.length).toBe(1);
    expect(preview.groups[0].keeper).toBeTruthy();
  });
});

// ---- §8: EXACT DUPLICATE REPAIR ----
describe("§8: exact duplicate repair", () => {
  it("runRepair collapses exact duplicates to one record per canonical_id", async () => {
    const adapter = createMemoryAdapter();
    // Create duplicates for multiple canonical IDs
    for (const cid of ["node:pve7", "execution-provider:tools1", "workload:ssd-intake"]) {
      const [kind, id] = cid.split(":");
      const entity = { node: "Node", "execution-provider": "ExecutionEnvironment", workload: "Workload" }[kind];
      const base = {
        canonical_id: cid, source_kind: "canonical",
        source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
      };
      if (entity === "Node") base.hostname = id;
      if (entity === "ExecutionEnvironment") { base.name = id; base.type = "unknown"; }
      if (entity === "Workload") { base.name = id; base.category = "unknown"; }
      adapter.create(entity, { ...base });
      adapter.create(entity, { ...base });
    }

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);
    expect(r.deleted.length).toBe(3);

    // Exactly one record per repaired canonical_id
    const counts = countByCanonical(adapter._store);
    expect(counts["node:pve7"]).toBe(1);
    expect(counts["execution-provider:tools1"]).toBe(1);
    expect(counts["workload:ssd-intake"]).toBe(1);
  });
});

// ---- §9: HETEROGENEOUS DUPLICATE GROUP BLOCKS REPAIR ----
describe("§9: heterogeneous duplicate group blocks repair", () => {
  it("group with different scalar fields is blocked, not repaired", () => {
    const adapter = createMemoryAdapter();
    adapter.create("Node", {
      canonical_id: "node:pve7", hostname: "pve7", lifecycle_state: "active",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });
    adapter.create("Node", {
      canonical_id: "node:pve7", hostname: "pve7", lifecycle_state: "degraded", // different!
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);

    expect(preview.groups.length).toBe(1);
    expect(preview.groups[0].eligible).toBe(false);
    expect(preview.groups[0].blockedReason).toMatch(/projection semantics/);
  });
});

// ---- §10: LOCAL OVERRIDE BLOCKS UNSAFE REPAIR ----
describe("§10: local override blocks unsafe repair", () => {
  it("group with a local field_provenance override is blocked", () => {
    const adapter = createMemoryAdapter();
    adapter.create("Node", {
      canonical_id: "node:pve7", hostname: "pve7", lifecycle_state: "active",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });
    adapter.create("Node", {
      canonical_id: "node:pve7", hostname: "pve7", lifecycle_state: "active",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
      field_provenance: JSON.stringify({ lifecycle_state: { local: "maintenance" } }),
    });

    const data = { Node: Array.from(adapter._store.Node.values()) };
    const preview = previewRepair(ARTIFACT, data);

    expect(preview.groups.length).toBe(1);
    expect(preview.groups[0].eligible).toBe(false);
    expect(preview.groups[0].blockedReason).toMatch(/local override/);
  });
});

// ---- §11: KEEPER SELECTION DETERMINISM ----
describe("§11: keeper selection determinism", () => {
  it("oldest created_date is selected as keeper", () => {
    const older = { id: "b-rec", created_date: "2026-08-31T10:00:00Z", canonical_id: "node:pve7" };
    const newer = { id: "a-rec", created_date: "2026-08-31T12:00:00Z", canonical_id: "node:pve7" };
    const keeper = selectKeeper([newer, older]);
    expect(keeper.id).toBe("b-rec");
  });

  it("tie-break by internal ID lexical order when created_date is equal", () => {
    const a = { id: "zzz", created_date: "2026-08-31T10:00:00Z", canonical_id: "node:pve7" };
    const b = { id: "aaa", created_date: "2026-08-31T10:00:00Z", canonical_id: "node:pve7" };
    const keeper = selectKeeper([a, b]);
    expect(keeper.id).toBe("aaa");
  });

  it("keeper selection is deterministic across multiple calls", () => {
    const members = [
      { id: "m3", created_date: "2026-08-31T10:00:00Z" },
      { id: "m1", created_date: "2026-08-31T09:00:00Z" },
      { id: "m2", created_date: "2026-08-31T09:00:00Z" },
    ];
    const k1 = selectKeeper(members);
    const k2 = selectKeeper(members);
    expect(k1.id).toBe("m1");
    expect(k2.id).toBe("m1");
  });
});

// ---- §12: REFERENCE REMAPPING ----
describe("§12: reference remapping before delete", () => {
  it("references to deleted duplicate IDs are remapped to keeper", async () => {
    const adapter = createMemoryAdapter();
    // Create duplicate execution-provider:tools1
    const keeper = await adapter.create("ExecutionEnvironment", {
      canonical_id: "execution-provider:tools1", name: "tools1", type: "lxc", runtime_kind: "lxc",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });
    const dup = await adapter.create("ExecutionEnvironment", {
      canonical_id: "execution-provider:tools1", name: "tools1", type: "lxc", runtime_kind: "lxc",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });

    // Create a workload referencing the DUPLICATE id (not the keeper)
    const wl = await adapter.create("Workload", {
      canonical_id: "workload:ssd-intake", name: "SSD Intake", category: "unknown",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
      eligible_execution_providers: [dup.id],
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);
    expect(r.deleted.length).toBe(1);

    // The workload's reference should now point to the keeper
    const updatedWl = adapter._store.Workload.get(wl.id);
    expect(updatedWl.eligible_execution_providers).toContain(keeper.id);
    expect(updatedWl.eligible_execution_providers).not.toContain(dup.id);
  });

  it("Dependency source_id/target_id referencing deleted IDs are remapped", async () => {
    const adapter = createMemoryAdapter();
    // Create duplicate workloads
    const keeper = await adapter.create("Workload", {
      canonical_id: "workload:ssd-intake", name: "SSD Intake", category: "unknown",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });
    const dup = await adapter.create("Workload", {
      canonical_id: "workload:ssd-intake", name: "SSD Intake", category: "unknown",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });

    // Create a Dependency referencing the duplicate
    const dep = await adapter.create("Dependency", {
      source_type: "workload", source_id: dup.id,
      target_type: "workload", target_id: dup.id,
      kind: "unknown", relationship_key: "workload:ssd-intake|depends_on|workload:ssd-intake",
      source_kind: "canonical", source_repository: INCIDENT_REPO, source_commit: INCIDENT_COMMIT,
    });

    const r = await runRepair(ARTIFACT, { adapter });
    expect(r.blocked).toBe(false);

    const updatedDep = adapter._store.Dependency.get(dep.id);
    expect(updatedDep.source_id).toBe(keeper.id);
    expect(updatedDep.target_id).toBe(keeper.id);
  });
});

// Helper: duplicate every canonical record in the store (simulates the stale-data incident).
async function duplicateAllCanonical(adapter) {
  for (const entity of ["Node", "ExecutionEnvironment", "Workload"]) {
    const recs = Array.from(adapter._store[entity].values());
    for (const rec of recs) {
      if (!rec.canonical_id) continue;
      const { id, created_date, updated_date, created_by_id, ...rest } = rec;
      await adapter.create(entity, { ...rest });
    }
  }
}

// ---- §13: POST-REPAIR EXACT ARTIFACT IS UNCHANGED/IDEMPOTENT ----
describe("§13: post-repair exact artifact is unchanged/idempotent", () => {
  it("after repair + re-import, created=0, unchanged=7, no duplicates", async () => {
    const adapter = createMemoryAdapter();
    // Step 1: Initial import creates 7 records with correct V1 projection
    await runImport(ARTIFACT, {}, { adapter, complete: true });

    // Step 2: Simulate the incident — duplicate every canonical record
    await duplicateAllCanonical(adapter);

    // Step 3: Repair duplicates
    const repair = await runRepair(ARTIFACT, { adapter });
    expect(repair.deleted.length).toBe(7);

    // Step 4: Re-run the normal fresh-read importer
    const r = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r.counts.created).toBe(0);
    expect(r.counts.unchanged).toBe(7);
    expect(r.counts.conflicts).toBe(0);

    // Persistent: one record per canonical_id
    const counts = countByCanonical(adapter._store);
    for (const cid of EXPECTED_CIDS) {
      expect(counts[cid]).toBe(1);
    }
  });
});

// ---- §14: REPEATED POST-REPAIR IMPORT REMAINS UNCHANGED ----
describe("§14: repeated post-repair import remains unchanged", () => {
  it("second post-repair import is also all unchanged, no duplicates", async () => {
    const adapter = createMemoryAdapter();
    // Create initial records, duplicate, then repair
    await runImport(ARTIFACT, {}, { adapter, complete: true });
    await duplicateAllCanonical(adapter);
    await runRepair(ARTIFACT, { adapter });

    // First post-repair import
    const r1 = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r1.counts.created).toBe(0);
    expect(r1.counts.unchanged).toBe(7);

    // Second post-repair import — still idempotent
    const r2 = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r2.counts.created).toBe(0);
    expect(r2.counts.unchanged).toBe(7);
    expect(r2.counts.conflicts).toBe(0);

    // Still exactly one per canonical_id
    const counts = countByCanonical(adapter._store);
    for (const cid of EXPECTED_CIDS) {
      expect(counts[cid]).toBe(1);
    }
  });
});

// ---- §15: CAPABILITY FINDING REMAINS UNRESOLVED ----
describe("§15: capability finding remains unresolved by design", () => {
  it("ssd-intake block-device-intake intake0 is reported as unresolved", async () => {
    const adapter = createMemoryAdapter();
    const r = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r.capability_findings.length).toBe(1);
    const f = r.capability_findings[0];
    expect(f.canonical_id).toBe("workload:ssd-intake");
    expect(f.type).toBe("block-device-intake");
    expect(f.instance).toBe("intake0");
    expect(f.resolution).toBe("unresolved");
  });
});

// ---- §16: RELATIONSHIP SEMANTICS PRESERVED ----
describe("§16: relationship semantics preserved", () => {
  it("files1 --hosted_on--> pve7, tools1 --hosted_on--> pve7, ssd-intake --placement_allowed_on_provider--> tools1", async () => {
    const adapter = createMemoryAdapter();
    const r = await runImport(ARTIFACT, {}, { adapter, complete: true });
    expect(r.relationships.length).toBe(3);

    const rels = r.relationships.map((x) => `${x.source}|${x.type}|${x.target}`).sort();
    expect(rels).toContain("execution-provider:files1|hosted_on|node:pve7");
    expect(rels).toContain("execution-provider:tools1|hosted_on|node:pve7");
    expect(rels).toContain("workload:ssd-intake|placement_allowed_on_provider|execution-provider:tools1");
  });
});

// ---- §17: ARTIFACT CANONICAL IDS ----
describe("§17: artifact canonical IDs extraction", () => {
  it("extracts all 7 canonical IDs from the real artifact", () => {
    const ids = artifactCanonicalIds(ARTIFACT);
    expect(ids.size).toBe(7);
    for (const cid of EXPECTED_CIDS) {
      expect(ids.has(cid)).toBe(true);
    }
  });
});