// Operator-initiated duplicate-repair recovery for canonical import incidents.
//
// Normal canonical import remains fail-closed on ambiguous canonical identity
// (multiple existing records for one canonical_id). This module provides an
// EXPLICIT, separately invoked repair path for the scenario where a stale
// caller dataset caused the importer to create duplicate canonical records.
//
// Repair is driven by the currently loaded canonical artifact: only canonical
// IDs contained in that artifact are eligible. For every duplicate group,
// fresh-read all matching records and verify they are exact canonical
// projections from the same source artifact before collapsing them.
//
// Safety model (C3):
//  - Only canonical IDs in the loaded artifact are eligible.
//  - Every member must be source_kind=canonical, same source_repository, same source_commit.
//  - Every member must have the same V1 projection semantics (scalar fields identical).
//  - No Atlas-local overrides or non-equivalent field_provenance overlays may be present.
//  - Atlas-local relationship fields (preferred_node, eligible_alternative_nodes,
//    current_environment, Workload current_host) are NOT ignored — differences block.
//  - observed_at, confidence, source_note are NOT ignored — differences block.
//  - Heterogeneous/unsafe groups are BLOCKED — never guessed, never auto-chosen.
//
// Reference remapping (C1):
//  - ONE global deletedId → keeperId mapping is built from ALL eligible groups.
//  - Each persisted reference field is scanned ONCE against the complete mapping.
//  - A field referencing deleted IDs from multiple groups receives ALL replacements.
//  - Records scheduled for deletion are excluded from remapping.
//
// Reference coverage (C2):
//  - Uses repairRefs.js as the single source of truth for the repair-reference vocabulary.
//  - Covers Task, Maintenance, PlannedChange, and PlannedChange.operations.
//  - Unsafe/unknown structured references block the group (fail closed).
//
// Partial failure (C4):
//  - Tracks whether writes occurred, which phase failed, and successful operations.
//  - After any write, a later failure is reported as partial/recovery-required.
//  - Fresh read/reconciliation is attempted after any write-phase failure.
//  - Retries must fresh-read and revalidate independently of the prior preview.

import { ENTITY_KINDS, buildCanonicalIndex, canonicalMatches } from "@/lib/relationships";
import { readFieldProvenance } from "@/lib/provenance";
import {
  REPAIR_REF_DESC,
  REPAIRABLE_ENTITIES,
  resolveRefTarget,
  planOperationRemaps,
  applyOperationRemaps,
} from "@/lib/repairRefs";

const KIND_TO_ENTITY = {
  node: "Node",
  "execution-provider": "ExecutionEnvironment",
  workload: "Workload",
};

// Extract canonical IDs from a V1 unified envelope.
export function artifactCanonicalIds(envelope) {
  const ids = new Set();
  if (envelope && Array.isArray(envelope.entities)) {
    envelope.entities.forEach((e) => {
      if (e && e.kind && e.id) ids.add(`${e.kind}:${e.id}`);
    });
  }
  return ids;
}

// ---- C3: Semantic equality (narrowed skip set) ----
// Only skip fields that are truly:
//  1. Internal identity/timestamps that naturally differ between duplicate creates.
//  2. Canonical-owned relationship state that the SAME loaded complete artifact
//     will deterministically reconstruct during normalization.
// Atlas-local relationship fields are NOT skipped — differences block.
function repairSkipFields(entity) {
  const skip = new Set([
    // Internal identity/timestamps
    "id", "created_date", "updated_date", "created_by_id",
    // Provenance metadata (checked separately in eligibility)
    "canonical_id", "source_kind", "source_repository", "source_version",
    "source_commit",
    // Provenance timestamps (naturally differ between import races)
    "imported_at", "source_generated_at",
    "last_seen_source_commit", "last_seen_import_at",
    // Field-level provenance overlay (checked separately)
    "field_provenance",
  ]);
  // Canonical-owned relationship state reconstructed by the same artifact
  if (entity === "ExecutionEnvironment") skip.add("current_host");
  if (entity === "Workload") {
    skip.add("eligible_execution_providers");
    skip.add("placement_allowed_nodes");
  }
  return skip;
}

function semanticProjection(rec, entity) {
  const skip = repairSkipFields(entity);
  const o = {};
  Object.keys(rec).forEach((k) => {
    if (!skip.has(k) && rec[k] !== undefined) o[k] = JSON.stringify(rec[k]);
  });
  return JSON.stringify(o);
}

// Normalize field_provenance for equivalence comparison across duplicate members.
// Compares ALL overlay layers (observed/planned/inferred/local) — not just local.
function normalizeFieldProvenance(rec) {
  const fp = readFieldProvenance(rec);
  const keys = Object.keys(fp).sort();
  return keys.map((k) => `${k}:${JSON.stringify(fp[k])}`).join("|");
}

function checkGroupEligibility(members, expectedCommit, expectedRepo, entity) {
  for (const m of members) {
    if (m.source_kind !== "canonical")
      return { eligible: false, reason: `member ${m.id} has source_kind="${m.source_kind}" (not canonical)` };
    if (m.source_repository !== expectedRepo)
      return { eligible: false, reason: `member ${m.id} has source_repository="${m.source_repository}" (expected "${expectedRepo}")` };
    if (m.source_commit !== expectedCommit)
      return { eligible: false, reason: `member ${m.id} has source_commit="${m.source_commit}" (expected "${expectedCommit}")` };

    // Check for Atlas-local overrides (field_provenance with local layer)
    const fp = readFieldProvenance(m);
    for (const field of Object.keys(fp)) {
      if (fp[field] && fp[field].local != null)
        return { eligible: false, reason: `member ${m.id} has local override on field "${field}"` };
    }
  }

  // C3: Compare field_provenance across ALL members — different non-local overlays block
  const fpNormalized = members.map(normalizeFieldProvenance);
  if (!fpNormalized.every((n) => n === fpNormalized[0]))
    return { eligible: false, reason: "members have different field_provenance overlays (observed/planned/inferred)" };

  // Check same V1 projection semantics (scalar fields identical, entity-aware skip)
  const projections = members.map((m) => semanticProjection(m, entity));
  if (!projections.every((p) => p === projections[0]))
    return { eligible: false, reason: "members have different V1 projection semantics" };

  return { eligible: true, reason: "" };
}

// Deterministic keeper selection: oldest created_date, tie-break by internal ID lexical order.
export function selectKeeper(members) {
  return [...members].sort((a, b) => {
    const ac = a.created_date || "";
    const bc = b.created_date || "";
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

// ---- C1: Build ONE global deletedId → keeperId mapping from ALL eligible groups ----
function buildGlobalRemapMap(readyGroups) {
  const deleteIdToKeeper = new Map(); // deleted internal ID → keeper internal ID
  const deleteIdToEntity = new Map(); // deleted internal ID → entity kind
  for (const g of readyGroups) {
    for (const d of g.deletions) {
      deleteIdToKeeper.set(d.id, g.keeper.id);
      deleteIdToEntity.set(d.id, g.entity);
    }
  }
  return { deleteIdToKeeper, deleteIdToEntity };
}

// ---- C1 + C2: Scan all persisted reference fields ONCE against the global mapping ----
// For arrays: map every element through the complete global mapping, then deduplicate.
// A field referencing deleted IDs from multiple groups receives ALL replacements.
// Records scheduled for deletion are excluded from remapping.
// Returns { remaps, unsafeRefs } where unsafeRefs blocks the corresponding groups.
function planGlobalReferenceRemaps(deleteIdToKeeper, deleteIdToEntity, liveData) {
  const remaps = [];
  const unsafeRefs = []; // { deletedId, reason }

  const deletedIds = new Set(deleteIdToKeeper.keys());

  for (const desc of REPAIR_REF_DESC) {
    const recs = liveData[desc.entity] || [];
    for (const rec of recs) {
      if (deletedIds.has(rec.id)) continue; // exclude records being deleted

      if (desc.array) {
        const arr = rec[desc.field];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        if (!arr.some((v) => deletedIds.has(v))) continue;
        // Map every element through the global mapping, then deduplicate
        const newArr = [];
        const seen = new Set();
        for (const v of arr) {
          const mapped = deleteIdToKeeper.get(v) || v;
          if (!seen.has(mapped)) { seen.add(mapped); newArr.push(mapped); }
        }
        remaps.push({ entity: desc.entity, id: rec.id, field: desc.field, oldValue: arr, newValue: newArr });
      } else {
        const val = rec[desc.field];
        if (val == null || val === "") continue;
        if (!deletedIds.has(val)) continue;
        // Determine target entity — if undeterminable, this is unsafe
        const target = resolveRefTarget(desc, rec);
        if (!target) {
          unsafeRefs.push({ deletedId: val, reason: `undeterminable reference target for ${desc.entity}.${desc.field}` });
          continue;
        }
        if (!REPAIRABLE_ENTITIES.has(target)) continue; // not a repairable entity — skip
        // Verify the deleted ID belongs to the expected entity kind
        if (deleteIdToEntity.get(val) !== target) continue; // ID belongs to a different entity — skip
        remaps.push({ entity: desc.entity, id: rec.id, field: desc.field, oldValue: val, newValue: deleteIdToKeeper.get(val) });
      }
    }
  }

  // Also scan PlannedChange.operations (structured array)
  const pcRecs = liveData.PlannedChange || [];
  for (const rec of pcRecs) {
    if (deletedIds.has(rec.id)) continue;
    const ops = rec.operations;
    if (!Array.isArray(ops) || ops.length === 0) continue;
    const opRemaps = planOperationRemaps(ops, deleteIdToKeeper, deleteIdToEntity);
    if (opRemaps === null) {
      // Unsafe reference found in operations — block
      unsafeRefs.push({ deletedId: null, reason: `unsafe/unknown structured reference in ${rec.id}.operations` });
      continue;
    }
    if (opRemaps.length > 0) {
      const newOps = applyOperationRemaps(ops, opRemaps);
      remaps.push({ entity: "PlannedChange", id: rec.id, field: "operations", oldValue: ops, newValue: newOps });
    }
  }

  return { remaps, unsafeRefs };
}

// Preview: detect groups, check eligibility, select keepers, plan remaps. No writes.
export function previewRepair(envelope, liveData) {
  const eligibleCids = artifactCanonicalIds(envelope);
  const index = buildCanonicalIndex(liveData);
  const src = envelope.source || {};
  const expectedRepo = src.repository || "";
  const expectedCommit = src.commit || "";

  const groups = [];

  eligibleCids.forEach((cid) => {
    const parts = cid.split(":");
    const kind = parts[0];
    const entity = KIND_TO_ENTITY[kind];
    if (!entity) return;

    const matches = canonicalMatches(entity, cid, index);
    if (matches.length <= 1) return; // no duplicates

    const eligibility = checkGroupEligibility(matches, expectedCommit, expectedRepo, entity);

    if (!eligibility.eligible) {
      groups.push({
        canonical_id: cid, entity,
        memberCount: matches.length,
        members: matches.map((m) => ({ id: m.id, created_date: m.created_date })),
        eligible: false, blockedReason: eligibility.reason,
        keeper: null, deletions: [],
      });
      return;
    }

    const keeper = selectKeeper(matches);
    const deletions = matches.filter((m) => m.id !== keeper.id);

    groups.push({
      canonical_id: cid, entity,
      memberCount: matches.length,
      members: matches.map((m) => ({ id: m.id, created_date: m.created_date })),
      eligible: true, blockedReason: "",
      keeper: { id: keeper.id, created_date: keeper.created_date },
      deletions: deletions.map((d) => ({ id: d.id, created_date: d.created_date })),
    });
  });

  // C1: Build ONE global remap mapping from eligible groups
  let ready = groups.filter((g) => g.eligible);
  const { deleteIdToKeeper, deleteIdToEntity } = buildGlobalRemapMap(ready);

  // C1 + C2: Scan all persisted reference fields ONCE against the global mapping
  const { remaps, unsafeRefs } = planGlobalReferenceRemaps(deleteIdToKeeper, deleteIdToEntity, liveData);

  // C2: If unsafe references were found, block the groups that own those deleted IDs
  if (unsafeRefs.length > 0) {
    // Collect all deleted IDs that caused unsafe refs (null means a general operations block)
    const hasGeneralBlock = unsafeRefs.some((u) => u.deletedId === null);
    const unsafeDeletedIds = new Set(unsafeRefs.filter((u) => u.deletedId !== null).map((u) => u.deletedId));

    ready.forEach((g) => {
      const shouldBlock = hasGeneralBlock || g.deletions.some((d) => unsafeDeletedIds.has(d.id));
      if (shouldBlock) {
        g.eligible = false;
        const reason = unsafeRefs.find((u) => u.deletedId === null || g.deletions.some((d) => d.id === u.deletedId));
        g.blockedReason = reason ? reason.reason : "unsafe reference detected";
        g.keeper = null;
        g.deletions = [];
      }
    });
  }

  const finalReady = groups.filter((g) => g.eligible);
  const blocked = groups.filter((g) => !g.eligible);

  // Rebuild global map without blocked groups and re-scan
  const { deleteIdToKeeper: finalMap, deleteIdToEntity: finalEntityMap } = buildGlobalRemapMap(finalReady);
  const { remaps: finalRemaps } = planGlobalReferenceRemaps(finalMap, finalEntityMap, liveData);

  return { groups, ready: finalReady, blocked, remaps: finalRemaps };
}

// Fresh read all entity classes.
async function freshRead(adapter) {
  const loaded = await Promise.all(
    ENTITY_KINDS.map(async (k) => [k, await adapter.listAll(k)])
  );
  return Object.fromEntries(loaded);
}

// Execute repair: fresh-read, apply remaps, delete duplicates. Returns repair report.
// C4: Honest partial failure — tracks writes, phase, successful operations, recovery.
// options: { adapter }
export async function runRepair(envelope, options = {}) {
  const adapter = options.adapter;
  if (!adapter) throw new Error("runRepair requires an adapter");

  const report = {
    blocked: false, blockedReason: "",
    partial: false, recoveryRequired: false,
    phase: "", groups: [], remaps: [],
    deleted: [], remapped: [],
    failedOperation: null,
    databaseStateUncertain: false,
  };

  // Phase 0: Fresh read (execution revalidates independently of preview)
  let liveData;
  try {
    liveData = await freshRead(adapter);
  } catch (e) {
    return {
      ...report, blocked: true,
      blockedReason: `incomplete existing-dataset load: ${e.message}`,
    };
  }

  // Phase 1: Preview (using fresh data)
  const preview = previewRepair(envelope, liveData);
  report.groups = preview.groups;
  report.remaps = preview.remaps;

  if (preview.ready.length === 0) {
    return {
      ...report, blocked: true,
      blockedReason: preview.blocked.length > 0
        ? "all duplicate groups are blocked (unsafe)"
        : "no duplicate groups found for repair",
    };
  }

  // Phase 2: Apply reference remaps (before any deletion)
  report.phase = "remap";
  const remapsByEntity = {};
  preview.remaps.forEach((r) => {
    if (!remapsByEntity[r.entity]) remapsByEntity[r.entity] = new Map();
    const m = remapsByEntity[r.entity].get(r.id) || { id: r.id };
    m[r.field] = r.newValue;
    remapsByEntity[r.entity].set(r.id, m);
  });

  for (const entity of Object.keys(remapsByEntity)) {
    const updates = Array.from(remapsByEntity[entity].values());
    if (updates.length === 0) continue;
    try {
      await adapter.bulkUpdate(entity, updates);
      updates.forEach((u) =>
        report.remapped.push({
          entity, id: u.id,
          fields: Object.keys(u).filter((k) => k !== "id"),
        })
      );
    } catch (e) {
      // C4: Some remaps may have succeeded, this one failed
      report.partial = true;
      report.recoveryRequired = true;
      report.failedOperation = { phase: "remap", operation: `bulkUpdate ${entity}`, reason: e.message };
      // Attempt fresh read to reconcile
      try { await freshRead(adapter); }
      catch (e2) { report.databaseStateUncertain = true; }
      return report;
    }
  }

  // Phase 3: Delete duplicate records (only verified eligible groups)
  report.phase = "delete";
  for (const group of preview.ready) {
    for (const del of group.deletions) {
      try {
        await adapter.delete(group.entity, del.id);
        report.deleted.push({
          canonical_id: group.canonical_id,
          entity: group.entity,
          id: del.id,
        });
      } catch (e) {
        // C4: Some deletes may have succeeded, this one failed
        report.partial = true;
        report.recoveryRequired = true;
        report.failedOperation = { phase: "delete", operation: `delete ${group.canonical_id} ${del.id}`, reason: e.message };
        // Attempt fresh read to reconcile
        try { await freshRead(adapter); }
        catch (e2) { report.databaseStateUncertain = true; }
        return report;
      }
    }
  }

  // Phase 4: Complete
  report.phase = "complete";
  return report;
}