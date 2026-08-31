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
// Safety model:
//  - Only canonical IDs in the loaded artifact are eligible.
//  - Every member must be source_kind=canonical, same source_repository, same source_commit.
//  - Every member must have the same V1 projection semantics (scalar fields identical).
//  - No Atlas-local overrides or local provenance may be present.
//  - Heterogeneous/unsafe groups are BLOCKED — never guessed, never auto-chosen.
//  - References to deleted duplicate IDs are remapped to the keeper BEFORE deletion.
//  - Dry-run preview is mandatory before any repair writes.
import { ENTITY_KINDS, REF_FIELDS, DEP_TYPE_MAP, buildCanonicalIndex, canonicalMatches } from "@/lib/relationships";
import { readFieldProvenance } from "@/lib/provenance";

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

// Fields that may legitimately differ between exact duplicates from the same
// artifact import race: internal identity, timestamps, provenance metadata,
// and canonical relationship fields (which may have been applied differently).
const REPAIR_SKIP = new Set([
  "id", "created_date", "updated_date", "created_by_id",
  "canonical_id", "source_kind", "source_repository", "source_version",
  "source_commit", "imported_at", "source_generated_at",
  "last_seen_source_commit", "last_seen_import_at",
  "external_id", "import_source", "import_timestamp", "field_provenance",
  "source_note", "confidence", "observed_at",
  // Relationship fields that may differ due to the duplicate race
  "current_host", "eligible_execution_providers", "placement_allowed_nodes",
  "current_environment", "preferred_node", "eligible_alternative_nodes",
]);

function semanticProjection(rec) {
  const o = {};
  Object.keys(rec).forEach((k) => {
    if (!REPAIR_SKIP.has(k) && rec[k] !== undefined) o[k] = JSON.stringify(rec[k]);
  });
  return JSON.stringify(o);
}

function checkGroupEligibility(members, expectedCommit, expectedRepo) {
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

  // Check same V1 projection semantics (scalar fields identical)
  const projections = members.map(semanticProjection);
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

// Plan reference remaps: find all references to non-keeper (deleted) IDs and remap to keeper.
// Covers all REF_FIELDS across all entity classes, including Dependency source/target.
function planReferenceRemaps(groups, liveData) {
  const remaps = [];

  groups.filter((g) => g.eligible).forEach((group) => {
    const { entity, keeper, deletions } = group;
    const deleteIds = new Set(deletions.map((d) => d.id));

    // Search all entity classes for references to deleted IDs.
    ENTITY_KINDS.forEach((refEntity) => {
      (liveData[refEntity] || []).forEach((rec) => {
        if (deleteIds.has(rec.id)) return; // skip records being deleted

        REF_FIELDS.filter((f) => f.entity === refEntity).forEach((f) => {
          const val = rec[f.field];
          if (val == null || val === "") return;

          let target = f.target;
          if (target === "_source_type") target = DEP_TYPE_MAP[rec.source_type];
          else if (target === "_target_type") target = DEP_TYPE_MAP[rec.target_type];
          if (!target || target !== entity) return;

          if (f.array) {
            const arr = Array.isArray(val) ? val : [];
            if (arr.some((v) => deleteIds.has(v))) {
              // Remap deleted IDs to keeper, deduplicate
              const newArr = arr
                .map((v) => (deleteIds.has(v) ? keeper.id : v))
                .filter((v, i, self) => self.indexOf(v) === i);
              remaps.push({ entity: refEntity, id: rec.id, field: f.field, oldValue: arr, newValue: newArr });
            }
          } else {
            if (deleteIds.has(val)) {
              remaps.push({ entity: refEntity, id: rec.id, field: f.field, oldValue: val, newValue: keeper.id });
            }
          }
        });
      });
    });
  });

  return remaps;
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

    const eligibility = checkGroupEligibility(matches, expectedCommit, expectedRepo);

    if (!eligibility.eligible) {
      groups.push({
        canonical_id: cid,
        entity,
        memberCount: matches.length,
        members: matches.map((m) => ({ id: m.id, created_date: m.created_date })),
        eligible: false,
        blockedReason: eligibility.reason,
        keeper: null,
        deletions: [],
      });
      return;
    }

    const keeper = selectKeeper(matches);
    const deletions = matches.filter((m) => m.id !== keeper.id);

    groups.push({
      canonical_id: cid,
      entity,
      memberCount: matches.length,
      members: matches.map((m) => ({ id: m.id, created_date: m.created_date })),
      eligible: true,
      blockedReason: "",
      keeper: { id: keeper.id, created_date: keeper.created_date },
      deletions: deletions.map((d) => ({ id: d.id, created_date: d.created_date })),
    });
  });

  const remaps = planReferenceRemaps(groups, liveData);
  const ready = groups.filter((g) => g.eligible);
  const blocked = groups.filter((g) => !g.eligible);

  return { groups, ready, blocked, remaps };
}

// Execute repair: fresh-read, apply remaps, delete duplicates. Returns repair report.
// options: { adapter }
export async function runRepair(envelope, options = {}) {
  const adapter = options.adapter;
  if (!adapter) throw new Error("runRepair requires an adapter");

  // Fresh read all entity classes
  let liveData = {};
  try {
    const loaded = await Promise.all(
      ENTITY_KINDS.map(async (k) => [k, await adapter.listAll(k)])
    );
    liveData = Object.fromEntries(loaded);
  } catch (e) {
    return {
      blocked: true,
      blockedReason: `incomplete existing-dataset load: ${e.message}`,
      groups: [],
      remaps: [],
      deleted: [],
      remapped: [],
    };
  }

  const preview = previewRepair(envelope, liveData);

  if (preview.ready.length === 0) {
    return {
      blocked: true,
      blockedReason: preview.blocked.length > 0
        ? "all duplicate groups are blocked (unsafe)"
        : "no duplicate groups found for repair",
      groups: preview.groups,
      remaps: [],
      deleted: [],
      remapped: [],
    };
  }

  const report = {
    blocked: false,
    blockedReason: "",
    groups: preview.groups,
    remaps: preview.remaps,
    deleted: [],
    remapped: [],
  };

  // Phase 1: Apply reference remaps (before any deletion)
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
          entity,
          id: u.id,
          fields: Object.keys(u).filter((k) => k !== "id"),
        })
      );
    } catch (e) {
      return {
        ...report,
        blocked: true,
        blockedReason: `reference remap failed for ${entity}: ${e.message}`,
      };
    }
  }

  // Phase 2: Delete duplicate records (only verified eligible groups)
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
        return {
          ...report,
          blocked: true,
          blockedReason: `delete failed for ${group.canonical_id} ${del.id}: ${e.message}`,
        };
      }
    }
  }

  return report;
}