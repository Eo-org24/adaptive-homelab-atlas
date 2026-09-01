// One-time legacy incident recovery for pre-hardening canonical duplicate rows
// that cannot satisfy modern R4 exact-artifact authorization (content_digest)
// solely because they predate content-digest persistence.
//
// This path is TIGHTLY SCOPED to explicit record IDs and explicit expected
// provenance. It cannot be used for arbitrary future duplicates. Normal
// duplicate repair (runRepair) remains strict R4 — this does NOT weaken it.
//
// Requirements (section 15):
//   - explicit record IDs (keeper + duplicates)
//   - explicit expected canonical IDs
//   - explicit expected source commit
//   - explicit expected generated_at
//   - semantic equality verification
//   - no local overrides
//   - reference preview
//   - deterministic keeper (oldest created_date, tie-break by ID)
//   - dry-run + explicit Execute
//   - no wildcard matching
//   - no name-based matching
//   - cannot be used for arbitrary future duplicates

import { ENTITY_KINDS, buildCanonicalIndex, canonicalMatches } from "@/lib/relationships";
import { readFieldProvenance, normalizeSourceKind } from "@/lib/provenance";
import {
  REPAIR_REF_DESC,
  REPAIRABLE_ENTITIES,
  resolveRefTarget,
  planOperationRemaps,
  applyOperationRemaps,
} from "@/lib/repairRefs";
import { selectKeeper, buildGlobalRemapMap, planGlobalReferenceRemaps } from "@/lib/duplicateRepair";

// Validate a single legacy recovery group against explicit expected provenance.
function validateLegacyGroup(g, members) {
  if (members.length === 0) return { valid: false, reason: "no records found for the specified IDs" };

  for (const m of members) {
    if (m.source_kind !== "canonical")
      return { valid: false, reason: `record ${m.id} has source_kind="${m.source_kind}" (expected "canonical")` };
    if (m.canonical_id !== g.canonical_id)
      return { valid: false, reason: `record ${m.id} has canonical_id="${m.canonical_id}" (expected "${g.canonical_id}")` };
    if (m.source_repository !== g.expectedRepository)
      return { valid: false, reason: `record ${m.id} has source_repository="${m.source_repository}" (expected "${g.expectedRepository}")` };
    if (m.source_commit !== g.expectedSourceCommit)
      return { valid: false, reason: `record ${m.id} has source_commit="${m.source_commit}" (expected "${g.expectedSourceCommit}")` };
    if (!m.source_generated_at)
      return { valid: false, reason: `record ${m.id} is missing source_generated_at` };
    if (m.source_generated_at !== g.expectedSourceGeneratedAt)
      return { valid: false, reason: `record ${m.id} has source_generated_at="${m.source_generated_at}" (expected "${g.expectedSourceGeneratedAt}")` };

    // No local overrides
    const fp = readFieldProvenance(m);
    for (const field of Object.keys(fp)) {
      if (fp[field] && fp[field].local != null)
        return { valid: false, reason: `record ${m.id} has local override on field "${field}"` };
    }
  }

  // Verify the specified keeper is the deterministic keeper
  const deterministicKeeper = selectKeeper(members);
  if (g.keeperId !== deterministicKeeper.id)
    return { valid: false, reason: `specified keeper ${g.keeperId} is not the deterministic keeper (${deterministicKeeper.id})` };

  // Verify all members have the same scalar semantics (excluding provenance/timestamps)
  const skip = new Set([
    "id", "created_date", "updated_date", "created_by_id",
    "canonical_id", "source_kind", "source_repository", "source_version",
    "source_commit", "imported_at", "source_generated_at",
    "last_seen_source_commit", "last_seen_import_at",
    "field_provenance", "source_note",
  ]);
  if (g.entity === "ExecutionEnvironment") skip.add("current_host");
  if (g.entity === "Workload") { skip.add("eligible_execution_providers"); skip.add("placement_allowed_nodes"); }
  const projections = members.map((m) => {
    const o = {};
    Object.keys(m).forEach((k) => { if (!skip.has(k) && m[k] !== undefined) o[k] = JSON.stringify(m[k]); });
    return JSON.stringify(o);
  });
  if (!projections.every((p) => p === projections[0]))
    return { valid: false, reason: "members have different scalar projection semantics" };

  return { valid: true, reason: "" };
}

// Preview legacy recovery: validate groups, plan reference remaps. No writes.
// spec: { groups: [{ entity, canonical_id, keeperId, duplicateIds, expectedSourceCommit, expectedSourceGeneratedAt, expectedRepository }] }
export function previewLegacyRecovery(spec, liveData) {
  const groups = [];
  for (const g of (spec.groups || [])) {
    const allIds = [g.keeperId, ...(g.duplicateIds || [])];
    const members = (liveData[g.entity] || []).filter((r) => allIds.includes(r.id));

    if (members.length !== allIds.length) {
      groups.push({
        ...g, eligible: false,
        blockedReason: `not all specified records found (${members.length}/${allIds.length})`,
        members: members.map((m) => ({ id: m.id })),
        keeper: null, deletions: [],
      });
      continue;
    }

    const validation = validateLegacyGroup(g, members);
    if (!validation.valid) {
      groups.push({
        ...g, eligible: false, blockedReason: validation.reason,
        members: members.map((m) => ({ id: m.id, created_date: m.created_date })),
        keeper: null, deletions: [],
      });
      continue;
    }

    const keeper = members.find((m) => m.id === g.keeperId);
    const duplicates = members.filter((m) => m.id !== g.keeperId);
    groups.push({
      ...g, eligible: true, blockedReason: "",
      members: members.map((m) => ({ id: m.id, created_date: m.created_date })),
      keeper: { id: keeper.id, created_date: keeper.created_date },
      deletions: duplicates.map((d) => ({ id: d.id, created_date: d.created_date })),
    });
  }

  const ready = groups.filter((g) => g.eligible);
  const blocked = groups.filter((g) => !g.eligible);

  // Plan reference remaps using the shared repair vocabulary
  const { deleteIdToKeeper, deleteIdToEntity } = buildGlobalRemapMap(
    ready.map((g) => ({ entity: g.entity, keeper: { id: g.keeper.id }, deletions: g.deletions }))
  );
  const { remaps, unsafeRefs } = planGlobalReferenceRemaps(deleteIdToKeeper, deleteIdToEntity, liveData);

  // Block groups with unsafe references
  if (unsafeRefs.length > 0) {
    const unsafeDeletedIds = new Set(unsafeRefs.filter((u) => u.deletedId).map((u) => u.deletedId));
    ready.forEach((g) => {
      if (g.deletions.some((d) => unsafeDeletedIds.has(d.id))) {
        g.eligible = false;
        const reason = unsafeRefs.find((u) => g.deletions.some((d) => d.id === u.deletedId));
        g.blockedReason = reason ? reason.reason : "unsafe reference detected";
        g.keeper = null;
        g.deletions = [];
      }
    });
  }

  const finalReady = groups.filter((g) => g.eligible);
  const finalBlocked = groups.filter((g) => !g.eligible);
  const { deleteIdToKeeper: finalMap, deleteIdToEntity: finalEntityMap } = buildGlobalRemapMap(
    finalReady.map((g) => ({ entity: g.entity, keeper: { id: g.keeper.id }, deletions: g.deletions }))
  );
  const { remaps: finalRemaps } = planGlobalReferenceRemaps(finalMap, finalEntityMap, liveData);

  return { groups, ready: finalReady, blocked: finalBlocked, remaps: finalRemaps };
}

// Execute legacy recovery: fresh-read, validate, remap references, delete duplicates.
export async function runLegacyRecovery(spec, options = {}) {
  const adapter = options.adapter;
  if (!adapter) throw new Error("runLegacyRecovery requires an adapter");

  const report = {
    blocked: false, blockedReason: "", partial: false, recoveryRequired: false,
    phase: "", groups: [], remaps: [], deleted: [], remapped: [],
    unverifiedRemaps: [], failedOperation: null, databaseStateUncertain: false,
    writesOccurred: false,
  };

  // Phase 0: Fresh read
  let liveData;
  try {
    const loaded = await Promise.all(
      ENTITY_KINDS.map(async (k) => [k, await adapter.listAll(k)])
    );
    liveData = Object.fromEntries(loaded);
  } catch (e) {
    return { ...report, blocked: true, blockedReason: `incomplete existing-dataset load: ${e.message}` };
  }

  // Phase 1: Preview (using fresh data)
  const preview = previewLegacyRecovery(spec, liveData);
  report.groups = preview.groups;
  report.remaps = preview.remaps;

  if (preview.ready.length === 0) {
    return {
      ...report, blocked: true,
      blockedReason: preview.blocked.length > 0
        ? `all groups blocked: ${preview.blocked.map((g) => g.blockedReason).join("; ")}`
        : "no eligible groups found",
    };
  }

  // Phase 2: Apply reference remaps one record at a time
  report.phase = "remap";
  const remapsByEntity = {};
  preview.remaps.forEach((r) => {
    if (!remapsByEntity[r.entity]) remapsByEntity[r.entity] = new Map();
    const m = remapsByEntity[r.entity].get(r.id) || { id: r.id };
    m[r.field] = r.newValue;
    remapsByEntity[r.entity].set(r.id, m);
  });

  const intendedRemaps = [];
  for (const entity of Object.keys(remapsByEntity)) {
    Array.from(remapsByEntity[entity].values()).forEach((u) => {
      const { id, ...payload } = u;
      intendedRemaps.push({ entity, id, payload });
    });
  }

  const attemptedRemaps = [];
  for (const intended of intendedRemaps) {
    const { entity, id, payload } = intended;
    const attemptedEntry = { entity, id, fields: Object.keys(payload), intendedValues: payload, succeeded: false };
    try {
      await adapter.update(entity, id, payload);
      report.writesOccurred = true;
      attemptedEntry.succeeded = true;
      attemptedRemaps.push(attemptedEntry);
    } catch (e) {
      attemptedRemaps.push(attemptedEntry);
      report.partial = true;
      report.recoveryRequired = true;
      report.failedOperation = { phase: "remap", operation: `update ${entity} ${id}`, reason: e.message };
      try {
        const verifyData = await Promise.all(
          ENTITY_KINDS.map(async (k) => [k, await adapter.listAll(k)])
        );
        const verifyMap = Object.fromEntries(verifyData);
        report.remapped = attemptedRemaps.filter((r) => {
          const rec = (verifyMap[r.entity] || []).find((x) => x.id === r.id);
          if (!rec) return false;
          for (const [field, val] of Object.entries(r.intendedValues)) {
            if (Array.isArray(val)) {
              const a = rec[field] || [], b = val;
              if (a.length !== b.length) return false;
              const sa = new Set(a), sb = new Set(b);
              if (sa.size !== sb.size) return false;
              for (const v of sa) if (!sb.has(v)) return false;
            } else if (JSON.stringify(rec[field]) !== JSON.stringify(val)) return false;
          }
          return true;
        }).map(({ entity, id, fields }) => ({ entity, id, fields }));
        if (report.remapped.length > 0) report.writesOccurred = true;
      } catch (e2) {
        report.databaseStateUncertain = true;
        report.remapped = attemptedRemaps.filter((r) => r.succeeded).map(({ entity, id, fields }) => ({ entity, id, fields }));
        report.unverifiedRemaps = attemptedRemaps.filter((r) => !r.succeeded).map(({ entity, id, fields }) => ({ entity, id, fields }));
      }
      return report;
    }
  }

  report.remapped = attemptedRemaps.map(({ entity, id, fields }) => ({ entity, id, fields }));

  // Phase 3: Delete duplicate records
  report.phase = "delete";
  for (const group of preview.ready) {
    for (const del of group.deletions) {
      try {
        await adapter.delete(group.entity, del.id);
        report.deleted.push({ canonical_id: group.canonical_id, entity: group.entity, id: del.id });
        report.writesOccurred = true;
      } catch (e) {
        report.partial = true;
        report.recoveryRequired = true;
        report.failedOperation = { phase: "delete", operation: `delete ${group.canonical_id} ${del.id}`, reason: e.message };
        try {
          const verifyData = await Promise.all(
            ENTITY_KINDS.map(async (k) => [k, await adapter.listAll(k)])
          );
          const verifyMap = Object.fromEntries(verifyData);
          const stillExists = (verifyMap[group.entity] || []).some((r) => r.id === del.id);
          if (!stillExists) {
            report.deleted.push({ canonical_id: group.canonical_id, entity: group.entity, id: del.id });
            report.writesOccurred = true;
          }
        } catch (e2) {
          report.databaseStateUncertain = true;
        }
        return report;
      }
    }
  }

  report.phase = "complete";
  return report;
}