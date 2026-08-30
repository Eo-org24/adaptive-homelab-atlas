// Canonical one-way import engine: homelab-foundation -> Atlas.
// Idempotent: upserts by canonical_id. Never duplicates. Never deletes. Never mutates infrastructure.
import { base44 } from "@/api/base44Client";
import { ENTITY_KINDS, REF_FIELDS, DEP_TYPE_MAP, refFieldNames, buildLookups, resolveRef } from "@/lib/relationships";

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

const emptyReport = () => ({ created: [], updated: [], unchanged: [], failed: [], unresolved: [], conflicts: [], warnings: [], counts: {} });
const countReport = (r) => ({
  created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length,
  failed: r.failed.length, unresolved: r.unresolved.length, conflicts: r.conflicts.length, warnings: r.warnings.length,
});

// Compare incoming scalar (non-ref, non-canonical) fields to existing record.
function changed(incoming, existing, entity) {
  const skip = new Set([...refFieldNames(entity), "canonical_id"]);
  const keys = Object.keys(incoming).filter((k) => !skip.has(k) && incoming[k] !== undefined);
  const proj = (rec) => { const o = {}; keys.forEach((k) => { o[k] = rec[k]; }); return JSON.stringify(o); };
  return proj(incoming) !== proj(existing);
}

// Pure planning: no writes. Returns a report of what WOULD happen.
export function previewImport(envelope, data) {
  const report = emptyReport();
  const v = validateEnvelope(envelope);
  if (!v.valid) { report.failed.push({ reason: v.errors.join(" ") }); report.counts = countReport(report); return report; }

  const lookups = buildLookups(data);
  const seen = new Map(); // canonical_id -> [section, idx]
  const plans = {}; // entity -> [{canonical_id, incoming, existing, action}]
  Object.entries(ENVELOPE_SECTIONS).forEach(([section, entity]) => {
    const list = envelope[section];
    if (!Array.isArray(list)) return;
    plans[entity] = [];
    list.forEach((rec, idx) => {
      if (!rec || typeof rec !== "object") { report.failed.push({ entity, index: idx, reason: "null or non-object record" }); return; }
      const cid = rec.canonical_id;
      if (!cid) { report.failed.push({ entity, index: idx, reason: "missing canonical_id" }); return; }
      if (seen.has(cid)) { report.conflicts.push({ canonical_id: cid, first: seen.get(cid), duplicate: [section, idx] }); return; }
      seen.set(cid, [section, idx]);
      const existing = lookups.byCanonical[entity]?.get(cid) || null;
      const action = !existing ? "create" : changed(rec, existing, entity) ? "update" : "unchanged";
      plans[entity].push({ canonical_id: cid, incoming: rec, existing, action });
      if (action === "create") report.created.push({ entity, canonical_id: cid });
      else if (action === "update") report.updated.push({ entity, canonical_id: cid });
      else report.unchanged.push({ entity, canonical_id: cid });
    });
  });

  // Phase 3 (dry): resolve relationships against existing data + planned creates
  const canonicalPlan = new Map();
  Object.entries(plans).forEach(([entity, ps]) => ps.forEach((p) => canonicalPlan.set(p.canonical_id, { entity, action: p.action })));
  Object.entries(plans).forEach(([entity, ps]) => ps.forEach((p) => {
    REF_FIELDS.filter((f) => f.entity === entity).forEach((f) => {
      const val = p.incoming[f.field];
      if (val == null || val === "") return;
      let target = f.target;
      if (target === "_source_type") target = DEP_TYPE_MAP[p.incoming.source_type];
      else if (target === "_target_type") target = DEP_TYPE_MAP[p.incoming.target_type];
      if (!target) return;
      const values = f.array ? val : [val];
      values.forEach((v) => {
        if (!v) return;
        const resolved = resolveRef(target, v, lookups);
        if (resolved) return;
        if (canonicalPlan.has(v) && canonicalPlan.get(v).action === "create")
          report.warnings.push({ entity, canonical_id: p.canonical_id, field: f.field, ref: v, note: "references a record being created in this import (will resolve on run)" });
        else
          report.unresolved.push({ entity, canonical_id: p.canonical_id, field: f.field, ref: v, target: target });
      });
    });
  }));

  report.counts = countReport(report);
  return report;
}

// Perform the import (writes). Idempotent.
export async function runImport(envelope, data) {
  const report = emptyReport();
  const v = validateEnvelope(envelope);
  if (!v.valid) { report.failed.push({ reason: v.errors.join(" ") }); report.counts = countReport(report); return report; }

  const meta = {
    source_repository: envelope.source?.repository || "",
    source_commit: envelope.source?.commit || "",
    schema_version: envelope.schema_version,
    imported_at: new Date().toISOString(),
  };

  let lookups = buildLookups(data);
  const seen = new Map();
  const items = []; // {entity, rec, canonical_id, existing, record?}
  Object.entries(ENVELOPE_SECTIONS).forEach(([section, entity]) => {
    const list = envelope[section];
    if (!Array.isArray(list)) return;
    list.forEach((rec, idx) => {
      const cid = rec.canonical_id;
      if (!cid) { report.failed.push({ entity, index: idx, reason: "missing canonical_id" }); return; }
      if (seen.has(cid)) { report.conflicts.push({ canonical_id: cid, first: seen.get(cid), duplicate: [section, idx] }); return; }
      seen.set(cid, [section, idx]);
      const existing = lookups.byCanonical[entity]?.get(cid) || null;
      items.push({ entity, rec, canonical_id: cid, existing });
    });
  });

  // Phase 1: upsert scalar (non-relationship) fields by canonical_id
  for (const item of items) {
    const { entity, rec, canonical_id, existing } = item;
    const skip = new Set([...refFieldNames(entity), "canonical_id"]);
    const payload = {
      canonical_id,
      source_kind: "canonical",
      source_repository: meta.source_repository,
      source_version: meta.schema_version,
      source_commit: meta.source_commit,
      imported_at: meta.imported_at,
    };
    Object.keys(rec).forEach((k) => { if (!skip.has(k) && rec[k] !== undefined) payload[k] = rec[k]; });
    try {
      if (existing) {
        if (changed(rec, existing, entity)) { await base44.entities[entity].update(existing.id, payload); report.updated.push({ entity, canonical_id }); }
        else report.unchanged.push({ entity, canonical_id });
        item.record = existing;
      } else {
        const created = await base44.entities[entity].create(payload);
        report.created.push({ entity, canonical_id });
        item.record = created;
      }
    } catch (e) { report.failed.push({ entity, canonical_id, reason: e.message }); }
  }

  // Phase 2: rebuild lookups with fresh data (so new creates get ids)
  const involved = Array.from(new Set(items.map((i) => i.entity)));
  const fresh = {};
  await Promise.all(involved.map(async (entity) => { fresh[entity] = await base44.entities[entity].list(); }));
  ENTITY_KINDS.forEach((k) => { if (!fresh[k]) fresh[k] = data[k] || []; });
  lookups = buildLookups(fresh);

  // Phase 3: resolve relationships -> internal ids; derive workload.current_host from environment (§7)
  const updatesByEntity = {};
  items.forEach((item) => {
    const { entity, rec, canonical_id, record } = item;
    if (!record) return;
    const fields = {};
    let hasUpdate = false;
    REF_FIELDS.filter((f) => f.entity === entity).forEach((f) => {
      const val = rec[f.field];
      if (val == null || val === "") return;
      let target = f.target;
      if (target === "_source_type") target = DEP_TYPE_MAP[rec.source_type];
      else if (target === "_target_type") target = DEP_TYPE_MAP[rec.target_type];
      if (f.array) {
        const resolved = []; const missing = [];
        (val || []).forEach((v) => { if (!v) return; const r = target ? resolveRef(target, v, lookups) : null; if (r) resolved.push(r.id); else missing.push(v); });
        if (missing.length) report.unresolved.push({ entity, canonical_id, field: f.field, refs: missing, target: target });
        fields[f.field] = resolved; hasUpdate = true;
      } else {
        const r = target ? resolveRef(target, val, lookups) : null;
        if (r) { fields[f.field] = r.id; hasUpdate = true; }
        else report.unresolved.push({ entity, canonical_id, field: f.field, ref: val, target: target });
      }
    });
    // §7: workload physical node derives from its environment (do not store a contradictory current_host)
    if (entity === "Workload" && rec.current_environment) {
      const env = resolveRef("ExecutionEnvironment", rec.current_environment, lookups);
      if (env && env.current_host) {
        if (rec.current_host && rec.current_host !== env.current_host)
          report.warnings.push({ entity, canonical_id, field: "current_host", note: "envelope current_host conflicts with environment host; using environment host" });
        fields.current_host = env.current_host; hasUpdate = true;
      }
    }
    if (hasUpdate) (updatesByEntity[entity] ||= []).push({ id: record.id, ...fields });
  });

  // Apply relationship updates in bulk
  for (const entity of Object.keys(updatesByEntity)) {
    try { await base44.entities[entity].bulkUpdate(updatesByEntity[entity]); }
    catch (e) { report.warnings.push({ entity, note: `relationship update failed: ${e.message}` }); }
  }

  // Phase 5: persist sync metadata
  await persistSyncState(meta, report, fresh);

  report.counts = countReport(report);
  return report;
}

async function persistSyncState(meta, report, data) {
  const importedCount = report.created.length + report.updated.length;
  const atlasLocalCount = ENTITY_KINDS.reduce((s, k) => s + (data[k] || []).filter((r) => !r.canonical_id).length, 0);
  const syncState = (report.unresolved.length || report.conflicts.length || report.failed.length)
    ? "import_warnings"
    : atlasLocalCount ? "local_additions" : "synchronized";
  const payload = {
    source_repository: meta.source_repository,
    last_import_at: meta.imported_at,
    source_commit: meta.source_commit,
    schema_version: meta.schema_version,
    imported_count: importedCount,
    warning_count: report.unresolved.length + report.conflicts.length + report.failed.length,
    atlas_local_count: atlasLocalCount,
    sync_state: syncState,
    last_report: JSON.stringify(countReport(report)),
  };
  try {
    const list = await base44.entities.CanonicalSync.list();
    if (list.length) await base44.entities.CanonicalSync.update(list[0].id, payload);
    else await base44.entities.CanonicalSync.create(payload);
  } catch (e) { /* sync metadata is best-effort */ }
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