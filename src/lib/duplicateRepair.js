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
import { validateV1Strict } from "@/lib/v1Schema";
import {
  REPAIR_REF_DESC,
  REPAIRABLE_ENTITIES,
  resolveRefTarget,
  planOperationRemaps,
  applyOperationRemaps,
} from "@/lib/repairRefs";

// F4: Set equality for verifying array remap persistence (primitive ID arrays).
function setEquals(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = new Set(a), sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

// S2: Deep structural equality — object key order does not matter, array order DOES matter.
// A real database reread deserializes fresh object instances; JavaScript Set
// equality compares object identity, so structurally equal persisted operations
// can be falsely classified as not applied. This helper compares by value.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// S2: Field-aware comparison for R3 remap verification.
// For primitive reference arrays (related_nodes, eligible_execution_providers, etc.):
//   set semantics (order-independent).
// For PlannedChange.operations: deep structural equality (order matters).
function remapFieldEquals(entity, field, persisted, intended) {
  if (Array.isArray(intended)) {
    if (entity === "PlannedChange" && field === "operations") {
      return deepEqual(persisted || [], intended);
    }
    return setEquals(persisted || [], intended);
  }
  // Scalar — primitive value comparison
  return persisted === intended;
}

// F2: Parse content_digest from source_note provenance metadata.
function parseContentDigest(sourceNote) {
  if (!sourceNote || typeof sourceNote !== "string") return null;
  const match = sourceNote.match(/content_digest=(sha256:[a-f0-9]{64})/i);
  return match ? match[1] : null;
}

// F5/S4: Stable artifact preview key for binding preview to the current artifact.
// S4: Also fingerprints the ACTUAL parsed envelope content — not just claimed
// producer metadata. Two envelopes with identical schema_version/repository/
// commit/content_digest but different entity/relationship bodies must produce
// different keys so the operator-facing invariant ("the artifact being repaired
// must receive its own dry-run preview") is guaranteed.
export function artifactPreviewKey(envelope) {
  if (!envelope || !envelope.source) return "";
  const src = envelope.source;
  const metaKey = [envelope.schema_version || "", src.repository || "", src.commit || "", src.content_digest || ""].join("|");
  const bodyFingerprint = fingerprintEnvelopeBody(envelope);
  return `${metaKey}|${bodyFingerprint}`;
}

// S4: Deterministic fingerprint of the actual parsed envelope content.
// Uses stable JSON serialization (sorted object keys) of entities and relationships.
function fingerprintEnvelopeBody(envelope) {
  const parts = [];
  if (Array.isArray(envelope.entities)) {
    parts.push("entities:" + envelope.entities.map(stableSerialize).join(","));
  }
  if (Array.isArray(envelope.relationships)) {
    parts.push("relationships:" + envelope.relationships.map(stableSerialize).join(","));
  }
  // Section-format arrays (legacy/backup-restore)
  const sections = ["nodes", "workloads", "execution_environments", "dependencies", "decisions", "storage_devices", "network_devices", "storage_pools", "switch_ports"];
  for (const section of sections) {
    if (Array.isArray(envelope[section])) {
      parts.push(section + ":" + envelope[section].map(stableSerialize).join(","));
    }
  }
  return parts.join("|");
}

function stableSerialize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableSerialize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableSerialize(value[k])).join(",") + "}";
}

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

function checkGroupEligibility(members, expectedCommit, expectedRepo, entity, artifactProvenance) {
  const expectedGeneratedAt = artifactProvenance ? artifactProvenance.generatedAt : "";
  const expectedDigest = artifactProvenance ? artifactProvenance.contentDigest : "";

  for (const m of members) {
    if (m.source_kind !== "canonical")
      return { eligible: false, reason: `member ${m.id} has source_kind="${m.source_kind}" (not canonical)` };
    if (m.source_repository !== expectedRepo)
      return { eligible: false, reason: `member ${m.id} has source_repository="${m.source_repository}" (expected "${expectedRepo}")` };
    if (m.source_commit !== expectedCommit)
      return { eligible: false, reason: `member ${m.id} has source_commit="${m.source_commit}" (expected "${expectedCommit}")` };

    // R4: Require EXACT V1 artifact provenance for destructive repair.
    // source_generated_at MUST be present and exactly match the loaded artifact.
    // Do not infer that repo+commit alone proves the exact artifact.
    if (!m.source_generated_at)
      return { eligible: false, reason: `member ${m.id} is missing source_generated_at (required for exact-artifact authorization)` };
    if (m.source_generated_at !== expectedGeneratedAt)
      return { eligible: false, reason: `member ${m.id} has source_generated_at="${m.source_generated_at}" (expected "${expectedGeneratedAt}")` };

    // R4: content_digest MUST be parseable from source_note and exactly match.
    const storedDigest = parseContentDigest(m.source_note);
    if (!storedDigest)
      return { eligible: false, reason: `member ${m.id} has no parseable content_digest in source_note (required for exact-artifact authorization)` };
    if (storedDigest !== expectedDigest)
      return { eligible: false, reason: `member ${m.id} has content_digest="${storedDigest}" (expected "${expectedDigest}")` };

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
        // R2: Type safety for array references — for each array element matching
        // a deleted ID, verify the actual deleted entity kind matches the
        // descriptor's declared target. A cross-type reference is unsafe: do
        // NOT remap, mark the specific deleted ID unsafe, and block the group
        // that owns that ID.
        const target = resolveRefTarget(desc, rec);
        let typeMismatch = false;
        if (target && REPAIRABLE_ENTITIES.has(target)) {
          for (const v of arr) {
            if (deletedIds.has(v) && deleteIdToEntity.get(v) !== target) {
              unsafeRefs.push({ deletedId: v, reason: `type mismatch: ${desc.entity}.${desc.field} expects ${target} but deleted ID belongs to ${deleteIdToEntity.get(v)}` });
              typeMismatch = true;
            }
          }
        }
        if (typeMismatch) continue; // skip remap — the owning group will be blocked
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
        // F3: Type mismatch — candidate-deleted ID whose entity kind conflicts with declared target → BLOCK
        if (deleteIdToEntity.get(val) !== target) {
          unsafeRefs.push({ deletedId: val, reason: `type mismatch: ${desc.entity}.${desc.field} expects ${target} but deleted ID belongs to ${deleteIdToEntity.get(val)}` });
          continue;
        }
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
    // R5: planOperationRemaps now returns { unsafe, remaps } — never null.
    // Unsafe findings carry the specific candidate-deleted ID so the caller
    // can block ONLY the owning group, not globally block all groups.
    const { unsafe: opUnsafe, remaps: opRemaps } = planOperationRemaps(ops, deleteIdToKeeper, deleteIdToEntity);
    for (const u of opUnsafe) {
      unsafeRefs.push({ deletedId: u.deletedId, reason: `unsafe structured reference in ${rec.id}.operations[${u.opIndex}].${u.fieldPath}: ${u.reason}` });
    }
    if (opRemaps.length > 0) {
      const newOps = applyOperationRemaps(ops, opRemaps);
      remaps.push({ entity: "PlannedChange", id: rec.id, field: "operations", oldValue: ops, newValue: newOps });
    }
  }

  return { remaps, unsafeRefs };
}

// Preview: detect groups, check eligibility, select keepers, plan remaps. No writes.
// F2: Strictly validate the artifact before considering repair eligibility.
export function previewRepair(envelope, liveData) {
  // F2: Strict V1 validation — same boundary as normal canonical import
  const validation = validateV1Strict(envelope);
  if (!validation.valid) {
    return {
      groups: [], ready: [], blocked: [], remaps: [],
      validationErrors: validation.errors,
    };
  }

  const eligibleCids = artifactCanonicalIds(envelope);
  const index = buildCanonicalIndex(liveData);
  const src = envelope.source || {};
  const expectedRepo = src.repository || "";
  const expectedCommit = src.commit || "";
  const artifactProvenance = {
    generatedAt: envelope.generated_at || "",
    contentDigest: (envelope.source && envelope.source.content_digest) || "",
  };

  const groups = [];

  eligibleCids.forEach((cid) => {
    const parts = cid.split(":");
    const kind = parts[0];
    const entity = KIND_TO_ENTITY[kind];
    if (!entity) return;

    const matches = canonicalMatches(entity, cid, index);
    if (matches.length <= 1) return; // no duplicates

    const eligibility = checkGroupEligibility(matches, expectedCommit, expectedRepo, entity, artifactProvenance);

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
    unverifiedRemaps: [],
    failedOperation: null,
    databaseStateUncertain: false,
    writesOccurred: false,
  };

  // F2: Strictly validate the artifact before execution — same boundary as preview
  const validation = validateV1Strict(envelope);
  if (!validation.valid) {
    return {
      ...report, blocked: true,
      blockedReason: `artifact validation failed: ${validation.errors.join("; ")}`,
      validationErrors: validation.errors,
    };
  }

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

  // F4: Apply reference remaps one persisted record at a time with explicit
  // success tracking. Do not assume bulkUpdate is atomic. Correctness > batching
  // for rare repair. If an update fails, stop before deletion, fresh-read to
  // verify which intended remaps actually persisted, and report the real outcome.
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

  const attemptedRemaps = []; // { entity, id, fields, intendedValues, succeeded }
  for (const intended of intendedRemaps) {
    const { entity, id, payload } = intended;
    // R3: Track the intended operation BEFORE the await — a server may persist
    // the write and still throw to the caller. The failed operation must be
    // included in reconciliation so we can verify whether it actually persisted.
    const attemptedEntry = { entity, id, fields: Object.keys(payload), intendedValues: payload, succeeded: false };
    try {
      await adapter.update(entity, id, payload);
      report.writesOccurred = true;
      attemptedEntry.succeeded = true;
      attemptedRemaps.push(attemptedEntry);
    } catch (e) {
      // R3: Include the FAILED intended operation in reconciliation — the
      // server may have persisted the write before throwing.
      attemptedRemaps.push(attemptedEntry);
      report.partial = true;
      report.recoveryRequired = true;
      report.failedOperation = { phase: "remap", operation: `update ${entity} ${id}`, reason: e.message };
      try {
        const verifyData = await freshRead(adapter);
        // S2/S3: Field-aware comparison. Only verified persisted remaps go to
        // report.remapped. PlannedChange.operations uses deep structural equality
        // (order matters); primitive ID arrays use set semantics.
        report.remapped = attemptedRemaps.filter((r) => {
          const rec = (verifyData[r.entity] || []).find((x) => x.id === r.id);
          if (!rec) return false;
          for (const [field, val] of Object.entries(r.intendedValues)) {
            if (!remapFieldEquals(r.entity, field, rec[field], val)) return false;
          }
          return true;
        }).map(({ entity, id, fields }) => ({ entity, id, fields }));
        // R3: Set writesOccurred from verified persisted mutations, not fulfilled promises.
        if (report.remapped.length > 0) report.writesOccurred = true;
      } catch (e2) {
        // S3: Complete reread cannot establish state — mark uncertain.
        // Do NOT add unverified operations to report.remapped — an attempted
        // operation is NOT a verified remap. Prior successful operations (whose
        // update call returned without throwing) remain in report.remapped as
        // independently known. The failed operation is surfaced separately as
        // unverified. writesOccurred is NOT set to true merely because an
        // operation was attempted — only prior independently-known successes count.
        report.databaseStateUncertain = true;
        report.remapped = attemptedRemaps
          .filter((r) => r.succeeded)
          .map(({ entity, id, fields }) => ({ entity, id, fields }));
        report.unverifiedRemaps = attemptedRemaps
          .filter((r) => !r.succeeded)
          .map(({ entity, id, fields }) => ({ entity, id, fields }));
      }
      // R3: Deletion must NOT begin after a remap-phase error.
      return report;
    }
  }

  // All remaps succeeded — copy verified remaps to report
  report.remapped = attemptedRemaps.map(({ entity, id, fields }) => ({ entity, id, fields }));

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
        // R3: Set writesOccurred for successful deletes even when there were
        // zero reference remaps — a deletion IS a persisted mutation.
        report.writesOccurred = true;
      } catch (e) {
        // R3: A delete request can delete successfully and still throw to the
        // caller. Fresh-read the affected entity data to determine whether the
        // failed ID still exists. Report successful/failed deletion according
        // to actual persisted state where it can be established.
        report.partial = true;
        report.recoveryRequired = true;
        report.failedOperation = { phase: "delete", operation: `delete ${group.canonical_id} ${del.id}`, reason: e.message };
        try {
          const verifyData = await freshRead(adapter);
          // R3: Determine whether the failed ID still exists in the database
          const stillExists = (verifyData[group.entity] || []).some((r) => r.id === del.id);
          if (!stillExists) {
            // R3: The delete actually succeeded — report it and set writesOccurred
            report.deleted.push({
              canonical_id: group.canonical_id,
              entity: group.entity,
              id: del.id,
            });
            report.writesOccurred = true;
          }
        } catch (e2) {
          // R3: Complete reread cannot establish state — mark uncertain
          report.databaseStateUncertain = true;
        }
        return report;
      }
    }
  }

  // Phase 4: Complete
  report.phase = "complete";
  return report;
}