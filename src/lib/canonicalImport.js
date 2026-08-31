// Canonical one-way import engine: homelab-foundation -> Atlas.
// Idempotent: upserts by canonical_id. Never duplicates. Never deletes. Never mutates infrastructure.
//
// Safety model:
//  - A shared normalization/validation phase is consumed by BOTH preview and run.
//  - runImport executes a blocking preflight before any write.
//  - Existing canonical identity ambiguity (multiple Atlas records for one canonical_id)
//    is a hard error (AMBIGUOUS_EXISTING_CANONICAL_ID) — never silently choose one.
//  - The persistence adapter is injectable: production = Base44, tests = in-memory.
//  - Per-record provenance distinguishes "last canonical value change" (source_commit /
//    imported_at) from "last seen in canonical snapshot" (last_seen_source_commit /
//    last_seen_import_at). Unchanged records still get their last_seen_* refreshed.
import { base44 } from "@/api/base44Client";
import { ENTITY_KINDS, REF_FIELDS, DEP_TYPE_MAP, refFieldNames, buildLookups, resolveRef, buildCanonicalIndex, canonicalMatches } from "@/lib/relationships";
import { loadEntityComplete } from "@/lib/datasetLoader";

const SUPPORTED_PREFIX = "adaptive-homelab-atlas/v";
const SUPPORTED_MAJOR = 1;
const SCHEMA_RE = /^adaptive-homelab-atlas\/v(\d+)/;

// envelope section name -> entity kind
export const ENVELOPE_SECTIONS = {
  nodes: "Node",
  execution_environments: "ExecutionEnvironment",
  workloads: "Workload",
  decisions: "Decision",
  dependencies: "Dependency",
  storage_devices: "StorageDevice",
  network_devices: "NetworkDevice",
  storage_pools: "StoragePool",
  switch_ports: "SwitchPort",
};

// Importer-managed / legacy provenance fields — never driven by the envelope.
const PROVENANCE_SKIP = new Set([
  "canonical_id", "source_kind", "source_repository", "source_version",
  "source_commit", "imported_at", "last_seen_source_commit", "last_seen_import_at",
  "external_id", "import_source", "import_timestamp", "field_provenance",
]);

export function validateEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { valid: false, errors: ["Envelope is not a JSON object."] };
  if (!envelope.schema_version) errors.push("Missing schema_version.");
  else if (typeof envelope.schema_version !== "string") errors.push("schema_version must be a string.");
  else {
    const m = envelope.schema_version.match(SCHEMA_RE);
    if (!m) errors.push(`Unsupported schema_version "${envelope.schema_version}" — expected prefix "${SUPPORTED_PREFIX}".`);
    else if (Number(m[1]) !== SUPPORTED_MAJOR) errors.push(`Unsupported schema major version v${m[1]} — supported major version is v${SUPPORTED_MAJOR}.`);
  }
  return { valid: errors.length === 0, errors };
}

const emptyReport = () => ({ created: [], updated: [], unchanged: [], failed: [], unresolved: [], conflicts: [], warnings: [], ambiguous: [], blocked: false, blockedReasons: [], sync_state: "", partial: false });
const countReport = (r) => ({
  created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length,
  failed: r.failed.length, unresolved: r.unresolved.length, conflicts: r.conflicts.length,
  warnings: r.warnings.length, ambiguous: r.ambiguous.length,
});

// Compare incoming scalar (non-ref, non-canonical, non-provenance) fields to existing.
function changed(incoming, existing, entity) {
  const skip = new Set([...refFieldNames(entity), ...PROVENANCE_SKIP]);
  const keys = Object.keys(incoming).filter((k) => !skip.has(k) && incoming[k] !== undefined);
  const proj = (rec) => { const o = {}; keys.forEach((k) => { o[k] = rec[k]; }); return JSON.stringify(o); };
  return proj(incoming) !== proj(existing);
}

// ---- Shared normalization/validation phase (consumed by preview AND run) ----
// Parses the envelope into valid import items + per-record errors + duplicate-input
// conflicts. Rejects null/array/string records and missing/non-string canonical_id
// exactly the same way for both paths.
function normalizeEnvelope(envelope) {
  const items = [];
  const inputErrors = [];
  const conflicts = [];
  const seen = new Map(); // canonical_id -> [section, idx]
  Object.entries(ENVELOPE_SECTIONS).forEach(([section, entity]) => {
    const list = envelope[section];
    if (!Array.isArray(list)) return;
    list.forEach((rec, idx) => {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
        inputErrors.push({ entity, index: idx, reason: "null or non-object record" });
        return;
      }
      const cid = rec.canonical_id;
      if (!cid || typeof cid !== "string") {
        inputErrors.push({ entity, index: idx, reason: "missing or non-string canonical_id" });
        return;
      }
      if (seen.has(cid)) { conflicts.push({ canonical_id: cid, first: seen.get(cid), duplicate: [section, idx] }); return; }
      seen.set(cid, [section, idx]);
      items.push({ entity, section, index: idx, canonical_id: cid, incoming: rec });
    });
  });
  return { items, inputErrors, conflicts };
}

// Plan the import: match incoming canonical_ids against existing Atlas records,
// distinguishing ZERO / ONE / MULTIPLE existing matches. Multiple = ambiguous = blocked.
export function planImport(envelope, data) {
  const v = validateEnvelope(envelope);
  if (!v.valid) return { valid: false, errors: v.errors, items: [], inputErrors: [], conflicts: [], ambiguous: [], plans: [], lookups: buildLookups(data || {}), index: buildCanonicalIndex(data || {}) };
  const { items, inputErrors, conflicts } = normalizeEnvelope(envelope);
  const index = buildCanonicalIndex(data || {});
  const lookups = buildLookups(data || {});
  const ambiguous = [];
  const plans = [];
  items.forEach((it) => {
    const matches = canonicalMatches(it.entity, it.canonical_id, index);
    if (matches.length > 1) {
      ambiguous.push({
        canonical_id: it.canonical_id, entity: it.entity,
        matches: matches.map((m) => ({ id: m.id, name: m.hostname || m.name || m.title || m.model || m.id })),
      });
      return; // blocked — do not plan
    }
    const existing = matches.length === 1 ? matches[0] : null;
    const action = !existing ? "create" : changed(it.incoming, existing, it.entity) ? "update" : "unchanged";
    plans.push({ ...it, existing, action });
  });
  return { valid: true, errors: [], items, inputErrors, conflicts, ambiguous, plans, lookups, index };
}

// Preflight: decide whether writes are blocked. Forward references (to records
// being created in this same import) are valid; truly unresolved canonical refs
// block unless the operator explicitly enables partial-import mode.
export function preflightImport(envelope, data, options = {}) {
  const complete = options.complete !== false;
  const allowPartialRefs = !!options.allowPartialRefs;
  const plan = planImport(envelope, data);
  if (!plan.valid) return { blocked: true, reasons: plan.errors, plan };
  const reasons = [];
  if (!complete) reasons.push("incomplete existing-dataset load");
  if (plan.inputErrors.length) reasons.push("malformed records");
  if (plan.conflicts.length) reasons.push("duplicate canonical IDs in incoming snapshot");
  if (plan.ambiguous.length) reasons.push("ambiguous existing canonical identity");
  if (!allowPartialRefs) {
    const canonicalPlan = new Map(plan.plans.map((p) => [p.canonical_id, p.action]));
    let unresolved = 0;
    plan.plans.forEach((p) => {
      REF_FIELDS.filter((f) => f.entity === p.entity).forEach((f) => {
        const val = p.incoming[f.field];
        if (val == null || val === "") return;
        let target = f.target;
        if (target === "_source_type") target = DEP_TYPE_MAP[p.incoming.source_type];
        else if (target === "_target_type") target = DEP_TYPE_MAP[p.incoming.target_type];
        if (!target) return;
        const values = f.array ? val : [val];
        values.forEach((v) => {
          if (!v) return;
          if (resolveRef(target, v, plan.lookups)) return;
          if (canonicalPlan.has(v)) return; // forward reference — will resolve on run
          unresolved++;
        });
      });
    });
    if (unresolved > 0) reasons.push("unresolved canonical references");
  }
  return { blocked: reasons.length > 0, reasons, plan };
}

// Pure planning: no writes. Returns a report of what WOULD happen (incl. blocked flag).
export function previewImport(envelope, data) {
  const report = emptyReport();
  const plan = planImport(envelope, data);
  if (!plan.valid) {
    report.failed.push({ reason: plan.errors.join(" ") });
    report.blocked = true; report.blockedReasons = plan.errors; report.sync_state = "import_blocked";
    report.counts = countReport(report); return report;
  }
  plan.inputErrors.forEach((e) => report.failed.push({ entity: e.entity, index: e.index, reason: e.reason }));
  plan.conflicts.forEach((c) => report.conflicts.push(c));
  plan.ambiguous.forEach((a) => report.ambiguous.push(a));
  plan.plans.forEach((p) => {
    if (p.action === "create") report.created.push({ entity: p.entity, canonical_id: p.canonical_id });
    else if (p.action === "update") report.updated.push({ entity: p.entity, canonical_id: p.canonical_id });
    else report.unchanged.push({ entity: p.entity, canonical_id: p.canonical_id });
  });
  // dry relationship resolution
  const canonicalPlan = new Map(plan.plans.map((p) => [p.canonical_id, p.action]));
  plan.plans.forEach((p) => {
    REF_FIELDS.filter((f) => f.entity === p.entity).forEach((f) => {
      const val = p.incoming[f.field];
      if (val == null || val === "") return;
      let target = f.target;
      if (target === "_source_type") target = DEP_TYPE_MAP[p.incoming.source_type];
      else if (target === "_target_type") target = DEP_TYPE_MAP[p.incoming.target_type];
      if (!target) return;
      const values = f.array ? val : [val];
      values.forEach((v) => {
        if (!v) return;
        if (resolveRef(target, v, plan.lookups)) return;
        if (canonicalPlan.has(v)) report.warnings.push({ entity: p.entity, canonical_id: p.canonical_id, field: f.field, ref: v, note: "references a record being created in this import (will resolve on run)" });
        else report.unresolved.push({ entity: p.entity, canonical_id: p.canonical_id, field: f.field, ref: v, target });
      });
    });
  });
  const preflight = preflightImport(envelope, data, { complete: true, allowPartialRefs: false });
  report.blocked = preflight.blocked;
  report.blockedReasons = preflight.reasons;
  report.sync_state = preflight.blocked ? "import_blocked"
    : (report.unresolved.length || report.conflicts.length || report.failed.length || report.ambiguous.length ? "import_warnings" : "synchronized");
  report.counts = countReport(report);
  return report;
}

function buildScalarPayload(item, meta) {
  const { entity, incoming } = item;
  const skip = new Set([...refFieldNames(entity), ...PROVENANCE_SKIP]);
  const payload = {
    canonical_id: incoming.canonical_id,
    source_kind: "canonical",
    source_repository: meta.source_repository,
    source_version: meta.schema_version,
    source_commit: meta.source_commit,
    imported_at: meta.imported_at,
    last_seen_source_commit: meta.source_commit,
    last_seen_import_at: meta.imported_at,
  };
  Object.keys(incoming).forEach((k) => { if (!skip.has(k) && incoming[k] !== undefined) payload[k] = incoming[k]; });
  return payload;
}

function resolveRelationshipFields(item, lookups, report, allowPartialRefs) {
  const { entity, incoming, canonical_id } = item;
  const fields = {};
  REF_FIELDS.filter((f) => f.entity === entity).forEach((f) => {
    const val = incoming[f.field];
    if (val == null || val === "") return;
    let target = f.target;
    if (target === "_source_type") target = DEP_TYPE_MAP[incoming.source_type];
    else if (target === "_target_type") target = DEP_TYPE_MAP[incoming.target_type];
    if (!target) return;
    if (f.array) {
      const resolved = []; const missing = [];
      (val || []).forEach((v) => { if (!v) return; const r = resolveRef(target, v, lookups); if (r) resolved.push(r.id); else missing.push(v); });
      if (missing.length) {
        if (allowPartialRefs) report.warnings.push({ entity, canonical_id, field: f.field, refs: missing, target, note: "partial import: unresolved reference omitted" });
        else report.unresolved.push({ entity, canonical_id, field: f.field, refs: missing, target });
      }
      fields[f.field] = resolved;
    } else {
      const r = resolveRef(target, val, lookups);
      if (r) fields[f.field] = r.id;
      else if (allowPartialRefs) report.warnings.push({ entity, canonical_id, field: f.field, ref: val, target, note: "partial import: unresolved reference omitted" });
      else report.unresolved.push({ entity, canonical_id, field: f.field, ref: val, target });
    }
  });
  return fields;
}

// Perform the import (writes). Idempotent. Adapter is injectable.
// options: { adapter, complete, allowPartialRefs }
export async function runImport(envelope, data, options = {}) {
  const adapter = options.adapter || createBase44Adapter();
  const complete = options.complete !== false;
  const allowPartialRefs = !!options.allowPartialRefs;
  const report = emptyReport();

  const plan = planImport(envelope, data);
  if (!plan.valid) {
    report.failed.push({ reason: plan.errors.join(" ") });
    report.blocked = true; report.blockedReasons = plan.errors; report.sync_state = "import_blocked";
    report.counts = countReport(report); return report;
  }
  plan.inputErrors.forEach((e) => report.failed.push({ entity: e.entity, index: e.index, reason: e.reason }));
  plan.conflicts.forEach((c) => report.conflicts.push(c));
  plan.ambiguous.forEach((a) => report.ambiguous.push(a));

  // ---- Preflight: block before any write ----
  const preflight = preflightImport(envelope, data, { complete, allowPartialRefs });
  report.blocked = preflight.blocked;
  report.blockedReasons = preflight.reasons;
  if (preflight.blocked) {
    // Report the planned counts (what WOULD happen) but write nothing.
    plan.plans.forEach((p) => {
      if (p.action === "create") report.created.push({ entity: p.entity, canonical_id: p.canonical_id });
      else if (p.action === "update") report.updated.push({ entity: p.entity, canonical_id: p.canonical_id });
      else report.unchanged.push({ entity: p.entity, canonical_id: p.canonical_id });
    });
    report.sync_state = "import_blocked";
    report.counts = countReport(report);
    return report;
  }

  const meta = {
    source_repository: envelope.source?.repository || "",
    source_commit: envelope.source?.commit || "",
    schema_version: envelope.schema_version,
    imported_at: new Date().toISOString(),
  };

  // ---- Phase 1: upsert scalar fields by canonical_id ----
  const items = plan.plans;
  const recordByItem = new Map();
  let partialFailure = false;
  for (const item of items) {
    const { entity, incoming, canonical_id, existing, action } = item;
    if (action === "unchanged") { recordByItem.set(item, existing); continue; }
    const payload = buildScalarPayload(item, meta);
    try {
      if (existing) {
        const updated = await adapter.update(entity, existing.id, payload);
        report.updated.push({ entity, canonical_id });
        recordByItem.set(item, updated || { ...existing, ...payload, id: existing.id });
      } else {
        const created = await adapter.create(entity, payload);
        report.created.push({ entity, canonical_id });
        recordByItem.set(item, created);
      }
    } catch (e) {
      report.failed.push({ entity, canonical_id, reason: e.message });
      partialFailure = true;
    }
  }

  // ---- Phase 2: refresh lookups with fresh data (so new creates get ids) ----
  const involved = Array.from(new Set(items.map((i) => i.entity)));
  let fresh = {};
  if (!partialFailure) {
    try {
      const loaded = await Promise.all(involved.map(async (e) => [e, await adapter.listAll(e)]));
      fresh = Object.fromEntries(loaded);
    } catch (e) {
      report.warnings.push({ note: `post-write refresh failed: ${e.message}` });
      partialFailure = true;
    }
  }
  ENTITY_KINDS.forEach((k) => { if (!fresh[k]) fresh[k] = (data[k] || []).map((r) => ({ ...r })); });
  // Merge in created/updated records for accuracy even if refresh failed.
  involved.forEach((e) => {
    const recs = new Map((fresh[e] || []).map((r) => [r.id, r]));
    items.filter((i) => i.entity === e && recordByItem.has(i)).forEach((i) => {
      const rec = recordByItem.get(i);
      if (rec && rec.id) recs.set(rec.id, rec);
    });
    fresh[e] = Array.from(recs.values());
  });
  const lookups = buildLookups(fresh);

  // ---- Phase 3: resolve relationships -> internal ids; bulkUpdate ----
  if (!partialFailure) {
    const updatesByEntity = {};
    items.forEach((item) => {
      if (!recordByItem.has(item)) return;
      const record = recordByItem.get(item);
      const fields = resolveRelationshipFields(item, lookups, report, allowPartialRefs);
      // Workload physical node derives from its environment (do not store a contradictory current_host).
      if (item.entity === "Workload" && item.incoming.current_environment) {
        const env = resolveRef("ExecutionEnvironment", item.incoming.current_environment, lookups);
        if (env && env.current_host) {
          if (item.incoming.current_host && item.incoming.current_host !== env.current_host)
            report.warnings.push({ entity: "Workload", canonical_id: item.canonical_id, field: "current_host", note: "envelope current_host conflicts with environment host; using environment host" });
          fields.current_host = env.current_host;
        }
      }
      if (Object.keys(fields).length) (updatesByEntity[item.entity] ||= []).push({ id: record.id, ...fields });
    });
    for (const entity of Object.keys(updatesByEntity)) {
      try { await adapter.bulkUpdate(entity, updatesByEntity[entity]); }
      catch (e) { report.warnings.push({ entity, note: `relationship update failed: ${e.message}` }); partialFailure = true; }
    }
  }

  // ---- Phase 4: refresh last_seen_* provenance for unchanged records ----
  // Created/updated records already received last_seen_* in Phase 1. Unchanged
  // records still need their "last seen in canonical snapshot" refreshed so the
  // UI does not claim they were last seen in an older commit.
  if (!partialFailure) {
    const provByEntity = {};
    items.forEach((item) => {
      if (item.action !== "unchanged") return;
      const rec = recordByItem.get(item);
      if (!rec || !rec.id) return;
      (provByEntity[item.entity] ||= []).push({ id: rec.id, last_seen_source_commit: meta.source_commit, last_seen_import_at: meta.imported_at });
    });
    for (const entity of Object.keys(provByEntity)) {
      try { await adapter.bulkUpdate(entity, provByEntity[entity]); }
      catch (e) { report.warnings.push({ entity, note: `provenance refresh failed: ${e.message}` }); partialFailure = true; }
    }
  }

  // ---- Phase 5: persist sync metadata ----
  report.partial = partialFailure;
  const syncState = computeSyncState(report, fresh, partialFailure);
  report.sync_state = syncState;
  try { await adapter.upsertSync(buildSyncPayload(meta, report, fresh, syncState)); }
  catch (e) { report.warnings.push({ note: `sync state persistence failed: ${e.message}` }); }

  report.counts = countReport(report);
  return report;
}

function computeSyncState(report, fresh, partialFailure) {
  if (partialFailure) return "partial_failure";
  if (report.unresolved.length || report.conflicts.length || report.failed.length || report.ambiguous.length) return "import_warnings";
  const atlasLocalCount = ENTITY_KINDS.reduce((s, k) => s + (fresh[k] || []).filter((r) => !r.canonical_id).length, 0);
  return atlasLocalCount ? "local_additions" : "synchronized";
}

function buildSyncPayload(meta, report, fresh, syncState) {
  const importedCount = report.created.length + report.updated.length;
  const atlasLocalCount = ENTITY_KINDS.reduce((s, k) => s + (fresh[k] || []).filter((r) => !r.canonical_id).length, 0);
  return {
    source_repository: meta.source_repository,
    last_import_at: meta.imported_at,
    source_commit: meta.source_commit,
    schema_version: meta.schema_version,
    imported_count: importedCount,
    warning_count: report.unresolved.length + report.conflicts.length + report.failed.length + report.ambiguous.length,
    atlas_local_count: atlasLocalCount,
    sync_state: syncState,
    last_report: JSON.stringify(countReport(report)),
  };
}

// ---- Adapters ----
export function createBase44Adapter(client = base44) {
  return {
    name: "base44",
    async listAll(entity) { const res = await loadEntityComplete(client, entity); return res.records; },
    async create(entity, payload) { return await client.entities[entity].create(payload); },
    async update(entity, id, payload) { return await client.entities[entity].update(id, payload); },
    async bulkUpdate(entity, updates) { return await client.entities[entity].bulkUpdate(updates); },
    async upsertSync(payload) {
      const list = await client.entities.CanonicalSync.list();
      if (list && list.length) return await client.entities.CanonicalSync.update(list[0].id, payload);
      return await client.entities.CanonicalSync.create(payload);
    },
  };
}

export function createMemoryAdapter(initial = {}) {
  const store = {};
  ENTITY_KINDS.forEach((k) => { store[k] = new Map(); });
  store.CanonicalSync = new Map();
  Object.keys(initial || {}).forEach((k) => {
    (initial[k] || []).forEach((r) => { if (r && r.id) store[k].set(r.id, { ...r }); });
  });
  let counter = 0;
  const newId = () => `mem-${++counter}`;
  return {
    name: "memory",
    async listAll(entity) { return Array.from((store[entity] || new Map()).values()).map((r) => ({ ...r })); },
    async create(entity, payload) {
      const id = newId(); const now = new Date().toISOString();
      const rec = { ...payload, id, created_date: now, updated_date: now, created_by_id: "mem" };
      store[entity].set(id, rec); return { ...rec };
    },
    async update(entity, id, payload) {
      const ex = store[entity].get(id);
      if (!ex) throw new Error(`update: ${entity} ${id} not found`);
      const rec = { ...ex, ...payload, updated_date: new Date().toISOString() };
      store[entity].set(id, rec); return { ...rec };
    },
    async bulkUpdate(entity, updates) {
      updates.forEach((u) => {
        const ex = store[entity].get(u.id);
        if (!ex) throw new Error(`bulkUpdate: ${entity} ${u.id} not found`);
        const { id, ...rest } = u;
        store[entity].set(id, { ...ex, ...rest, updated_date: new Date().toISOString() });
      });
      return updates.length;
    },
    async upsertSync(payload) {
      const arr = Array.from(store.CanonicalSync.values());
      if (arr.length) { store.CanonicalSync.set(arr[0].id, { ...arr[0], ...payload }); return; }
      const id = newId(); store.CanonicalSync.set(id, { ...payload, id });
    },
    _store: store,
  };
}

export const SAMPLE_ENVELOPE = `{
  "schema_version": "adaptive-homelab-atlas/v1",
  "generated_at": "2026-08-30T00:00:00Z",
  "source": { "repository": "homelab-foundation", "commit": "abc1234" },
  "nodes": [
    { "canonical_id": "node:rig9", "hostname": "rig9", "node_type": "workstation", "lifecycle_state": "active" }
  ],
  "execution_environments": [
    { "canonical_id": "execution-provider:tools1", "name": "tools1", "type": "lxc", "current_host": "node:pve7", "lifecycle": "active" }
  ],
  "workloads": [
    { "canonical_id": "workload:ssd-intake", "name": "SSD Intake", "category": "storage", "current_environment": "execution-provider:tools1", "lifecycle": "active" }
  ],
  "decisions": [],
  "dependencies": []
}`;