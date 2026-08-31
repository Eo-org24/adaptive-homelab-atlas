// Canonical one-way import engine: homelab-foundation -> Atlas.
// Idempotent: upserts by canonical_id. Never duplicates. Never deletes. Never mutates infrastructure.
//
// Two producer contract shapes are accepted:
//  - UNIFIED (frozen V1 canonical contract): top-level `entities[]` + `relationships[]`.
//    Each entity carries `kind` + `id`; its Atlas canonical_id is derived verbatim as
//    `<kind>:<id>`. Relationships are explicit tuples applied in a dedicated phase.
//  - SECTION (legacy / backup-restore): `nodes[]`, `workloads[]`, etc. with Atlas-shaped
//    records that already carry `canonical_id` and relationship fields. Kept for backup.
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
import { FIXTURE_TAG } from "@/lib/provenance";

const SUPPORTED_PREFIX = "adaptive-homelab-atlas/v";
const SUPPORTED_MAJOR = 1;
const SCHEMA_RE = /^adaptive-homelab-atlas\/v(\d+)/;

// ---- Frozen V1 unified contract ----
const UNIFIED_TOP_LEVEL = new Set(["schema_version", "generated_at", "producer", "source", "entities", "relationships"]);
// producer `kind` -> Atlas internal entity. `execution-provider` is the canonical external
// identity; Atlas models it internally as ExecutionEnvironment but never rewrites the id.
const KIND_TO_ENTITY = {
  node: "Node",
  "execution-provider": "ExecutionEnvironment",
  workload: "Workload",
};
// Known relationship types and how they map onto Atlas relationship fields.
// hosted_on: execution-provider -> node  =>  ExecutionEnvironment.current_host
// placement_allowed_on_provider: workload -> execution-provider  =>  Workload.eligible_execution_providers
//   (placement eligibility is NEVER current realization: not current_environment, not current_host)
const KNOWN_RELATIONSHIP_TYPES = {
  hosted_on: { sourceKind: "execution-provider", targetKind: "node", field: "current_host", array: false },
  placement_allowed_on_provider: { sourceKind: "workload", targetKind: "execution-provider", field: "eligible_execution_providers", array: true },
};

// envelope section name -> entity kind (legacy / backup-restore shape)
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

export function detectFormat(envelope) {
  return envelope && Array.isArray(envelope.entities) ? "unified" : "section";
}

const emptyReport = () => ({ created: [], updated: [], unchanged: [], failed: [], unresolved: [], conflicts: [], warnings: [], ambiguous: [], relationships: [], capability_findings: [], blocked: false, blockedReasons: [], sync_state: "", partial: false });
const countReport = (r) => ({
  created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length,
  failed: r.failed.length, unresolved: r.unresolved.length, conflicts: r.conflicts.length,
  warnings: r.warnings.length, ambiguous: r.ambiguous.length,
  relationships: r.relationships.length, capability_findings: r.capability_findings.length,
});

// Compare incoming scalar (non-ref, non-canonical, non-provenance) fields to existing.
function changed(incoming, existing, entity) {
  const skip = new Set([...refFieldNames(entity), ...PROVENANCE_SKIP]);
  const keys = Object.keys(incoming).filter((k) => !skip.has(k) && incoming[k] !== undefined);
  const proj = (rec) => { const o = {}; keys.forEach((k) => { o[k] = rec[k]; }); return JSON.stringify(o); };
  return proj(incoming) !== proj(existing);
}

// ---- V1 unified entity -> Atlas-shaped record ----
const NODE_SCALARS = ["description", "manufacturer", "model", "motherboard", "cpu_model", "socket_count", "physical_cores", "logical_cpus", "ram_capacity_gb", "ram_configuration", "gpu_vram_gb", "idle_power_w", "max_power_w", "os_hypervisor", "management_address", "availability_expectation", "physical_location", "lifecycle_state", "node_type", "notes"];
const ENV_SCALARS = ["type", "lifecycle", "cpu_allocation", "ram_allocation_gb", "storage_allocation_gb", "reconstructable", "persistent_state", "notes"];
const WL_SCALARS = ["category", "lifecycle", "criticality", "availability_requirement", "cpu_requirement", "ram_requirement_gb", "gpu_requirement", "gpu_vram_requirement_gb", "required_gpu_class", "storage_requirement_gb", "network_requirement", "minimum_network_mbps", "reconstructable", "backup_requirement", "description", "notes"];

function mapUnifiedEntity(e, entity, fixtureTag) {
  const cid = `${e.kind}:${e.id}`;
  const rec = { canonical_id: cid };
  const tags = Array.isArray(e.tags) ? [...e.tags] : [];
  if (fixtureTag && !tags.includes(fixtureTag)) tags.push(fixtureTag);
  if (tags.length) rec.tags = tags;

  if (entity === "Node") {
    rec.hostname = e.hostname || e.id;
    NODE_SCALARS.forEach((f) => { if (e[f] != null) rec[f] = e[f]; });
    if (Array.isArray(e.gpus)) rec.gpus = e.gpus;
    if (Array.isArray(e.nics)) rec.nics = e.nics;
    if (Array.isArray(e.capabilities) && e.capabilities.length) rec.capabilities = e.capabilities;
  } else if (entity === "ExecutionEnvironment") {
    rec.name = e.name || e.id;
    rec.type = e.type || "vm";
    ENV_SCALARS.forEach((f) => { if (e[f] != null) rec[f] = e[f]; });
  } else if (entity === "Workload") {
    rec.name = e.name || e.id;
    rec.category = e.category || "user_application";
    WL_SCALARS.forEach((f) => { if (e[f] != null) rec[f] = e[f]; });
    if (Array.isArray(e.required_capabilities)) rec.required_capabilities = e.required_capabilities;
    if (e.requirements && Array.isArray(e.requirements.capabilities) && e.requirements.capabilities.length) rec.capability_requirements = e.requirements.capabilities;
  }
  return rec;
}

function parseTypedId(s) {
  if (typeof s !== "string") return null;
  const i = s.indexOf(":");
  if (i < 0) return null;
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
}

// ---- Shared normalization/validation phase (consumed by preview AND run) ----
function normalizeEnvelope(envelope) {
  if (detectFormat(envelope) === "unified") return normalizeUnified(envelope);
  return normalizeSection(envelope);
}

function normalizeUnified(envelope) {
  const items = [];
  const inputErrors = [];
  const conflicts = [];
  const relationships = [];
  // Strict top-level field set — reject unknown producer fields.
  Object.keys(envelope).forEach((k) => {
    if (!UNIFIED_TOP_LEVEL.has(k)) inputErrors.push({ entity: "(envelope)", index: 0, reason: `unknown top-level field "${k}"` });
  });
  if (!Array.isArray(envelope.entities)) inputErrors.push({ entity: "(envelope)", index: 0, reason: "entities must be an array" });
  if (envelope.relationships != null && !Array.isArray(envelope.relationships)) inputErrors.push({ entity: "(envelope)", index: 0, reason: "relationships must be an array if present" });

  // Synthetic-fixture marker: a canonical snapshot with no resolvable commit (COMMIT UNKNOWN)
  // is a synthetic crossover fixture. Provenance stays canonical; the tag lets operational
  // calculations exclude it without weakening canonical source classification.
  const commit = envelope.source && envelope.source.commit;
  const fixtureTag = (!commit || commit === "unknown") ? FIXTURE_TAG : null;

  const seen = new Map();
  (envelope.entities || []).forEach((e, idx) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) { inputErrors.push({ entity: "(entity)", index: idx, reason: "null or non-object entity" }); return; }
    if (typeof e.kind !== "string" || !KIND_TO_ENTITY[e.kind]) { inputErrors.push({ entity: "(entity)", index: idx, reason: `unknown entity kind "${e.kind}"` }); return; }
    if (typeof e.id !== "string" || !e.id) { inputErrors.push({ entity: "(entity)", index: idx, reason: "missing or non-string entity id" }); return; }
    const cid = `${e.kind}:${e.id}`;
    if (seen.has(cid)) { conflicts.push({ canonical_id: cid, first: seen.get(cid), duplicate: idx }); return; }
    seen.set(cid, idx);
    const entity = KIND_TO_ENTITY[e.kind];
    items.push({ entity, section: "entities", index: idx, canonical_id: cid, incoming: mapUnifiedEntity(e, entity, fixtureTag), kind: e.kind });
  });

  const relSeen = new Set();
  (envelope.relationships || []).forEach((r, idx) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) { inputErrors.push({ entity: "(relationship)", index: idx, reason: "null or non-object relationship" }); return; }
    if (typeof r.source !== "string" || typeof r.target !== "string" || typeof r.type !== "string") { inputErrors.push({ entity: "(relationship)", index: idx, reason: "relationship must have string source, type, target" }); return; }
    if (!KNOWN_RELATIONSHIP_TYPES[r.type]) { inputErrors.push({ entity: "(relationship)", index: idx, reason: `unknown relationship type "${r.type}"` }); return; }
    const key = `${r.source}|${r.type}|${r.target}`;
    if (relSeen.has(key)) { conflicts.push({ canonical_id: key, first: null, duplicate: idx, kind: "relationship" }); return; }
    relSeen.add(key);
    relationships.push({ source: r.source, type: r.type, target: r.target, index: idx });
  });

  return { items, inputErrors, conflicts, relationships, format: "unified", fixtureTag };
}

function normalizeSection(envelope) {
  const items = [];
  const inputErrors = [];
  const conflicts = [];
  const seen = new Map();
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
  return { items, inputErrors, conflicts, relationships: [], format: "section", fixtureTag: null };
}

// Detect capability-requirement ambiguity (named instance) — preserved, NOT resolved.
function collectCapabilityFindings(items) {
  const out = [];
  items.forEach((it) => {
    if (it.entity !== "Workload") return;
    const reqs = it.incoming.capability_requirements;
    if (!Array.isArray(reqs)) return;
    reqs.forEach((req) => {
      if (req && typeof req === "object" && req.instance) {
        out.push({ canonical_id: it.canonical_id, type: req.type || "", instance: req.instance, resolution: "unresolved", note: "named capability instance scope is not canonically defined — not bound to any node capability" });
      }
    });
  });
  return out;
}

// Plan the import: match incoming canonical_ids against existing Atlas records,
// distinguishing ZERO / ONE / MULTIPLE existing matches. Multiple = ambiguous = blocked.
export function planImport(envelope, data) {
  const v = validateEnvelope(envelope);
  if (!v.valid) return { valid: false, errors: v.errors, items: [], inputErrors: [], conflicts: [], ambiguous: [], plans: [], relationships: [], capability_findings: [], lookups: buildLookups(data || {}), index: buildCanonicalIndex(data || {}), format: detectFormat(envelope) };
  const norm = normalizeEnvelope(envelope);
  const { items, inputErrors, conflicts, relationships, format } = norm;
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
      return;
    }
    const existing = matches.length === 1 ? matches[0] : null;
    const action = !existing ? "create" : changed(it.incoming, existing, it.entity) ? "update" : "unchanged";
    plans.push({ ...it, existing, action });
  });
  const capability_findings = collectCapabilityFindings(items);
  return { valid: true, errors: [], items, inputErrors, conflicts, ambiguous, plans, relationships, capability_findings, lookups, index, format };
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
    if (plan.format === "unified") {
      const plannedCids = new Set(plan.plans.map((p) => p.canonical_id));
      plan.relationships.forEach((r) => {
        const s = parseTypedId(r.source), t = parseTypedId(r.target);
        if (!s || !t || !KIND_TO_ENTITY[s.kind] || !KIND_TO_ENTITY[t.kind]) { unresolved++; return; }
        if (!plannedCids.has(r.source) && !resolveRef(KIND_TO_ENTITY[s.kind], r.source, plan.lookups)) unresolved++;
        if (!plannedCids.has(r.target) && !resolveRef(KIND_TO_ENTITY[t.kind], r.target, plan.lookups)) unresolved++;
      });
    } else {
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
            if (canonicalPlan.has(v)) return;
            unresolved++;
          });
        });
      });
    }
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
  plan.capability_findings.forEach((c) => report.capability_findings.push(c));
  plan.plans.forEach((p) => {
    if (p.action === "create") report.created.push({ entity: p.entity, canonical_id: p.canonical_id });
    else if (p.action === "update") report.updated.push({ entity: p.entity, canonical_id: p.canonical_id });
    else report.unchanged.push({ entity: p.entity, canonical_id: p.canonical_id });
  });
  const plannedCids = new Set(plan.plans.map((p) => p.canonical_id));
  if (plan.format === "unified") {
    plan.relationships.forEach((r) => {
      const s = parseTypedId(r.source), t = parseTypedId(r.target);
      if (!s || !t || !KIND_TO_ENTITY[s.kind] || !KIND_TO_ENTITY[t.kind]) { report.unresolved.push({ entity: "(relationship)", canonical_id: r.source, field: r.type, ref: r.target, target: "unknown" }); return; }
      const sExisting = resolveRef(KIND_TO_ENTITY[s.kind], r.source, plan.lookups);
      const tExisting = resolveRef(KIND_TO_ENTITY[t.kind], r.target, plan.lookups);
      const sPlanned = plannedCids.has(r.source);
      const tPlanned = plannedCids.has(r.target);
      if ((sExisting || sPlanned) && (tExisting || tPlanned)) {
        report.relationships.push({ source: r.source, type: r.type, target: r.target, resolvable: true });
        if (!sExisting || !tExisting) report.warnings.push({ entity: "(relationship)", canonical_id: r.source, field: r.type, note: `references a record being created in this import (will resolve on run)` });
      } else {
        report.unresolved.push({ entity: KIND_TO_ENTITY[s.kind], canonical_id: r.source, field: r.type, ref: r.target, target: KIND_TO_ENTITY[t.kind] || "unknown" });
      }
    });
  } else {
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
  }
  const preflight = preflightImport(envelope, data, { complete: true, allowPartialRefs: false });
  report.blocked = preflight.blocked;
  report.blockedReasons = preflight.reasons;
  report.sync_state = preflight.blocked ? "import_blocked"
    : (report.unresolved.length || report.conflicts.length || report.failed.length || report.ambiguous.length ? "import_warnings" : "synchronized");
  report.counts = countReport(report);
  return report;
}

function buildMeta(envelope) {
  const src = envelope.source || {};
  const producer = envelope.producer || {};
  const commit = src.commit || "";
  const noteParts = [];
  if (src.content_digest) noteParts.push(`content_digest=${src.content_digest}`);
  if (src.is_dirty != null) noteParts.push(`is_dirty=${src.is_dirty}`);
  if (producer.name) noteParts.push(`producer=${producer.name}`);
  if (producer.version) noteParts.push(`producer_version=${producer.version}`);
  return {
    source_repository: src.repository || "",
    source_commit: commit, // "unknown" preserved verbatim — COMMIT UNKNOWN, never fabricated
    schema_version: envelope.schema_version,
    source_version: producer.version || envelope.schema_version,
    imported_at: (envelope.generated_at ? new Date(envelope.generated_at).toISOString() : new Date().toISOString()),
    source_note: noteParts.join("; "),
  };
}

function buildScalarPayload(item, meta) {
  const { entity, incoming } = item;
  const skip = new Set([...refFieldNames(entity), ...PROVENANCE_SKIP]);
  const payload = {
    canonical_id: incoming.canonical_id,
    source_kind: "canonical",
    source_repository: meta.source_repository,
    source_version: meta.source_version,
    source_commit: meta.source_commit,
    imported_at: meta.imported_at,
    last_seen_source_commit: meta.source_commit,
    last_seen_import_at: meta.imported_at,
  };
  if (meta.source_note) payload.source_note = meta.source_note;
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

// Apply V1 unified relationship tuples to Atlas relationship fields (after all entities
// are upserted and the canonical_id -> internal id map is rebuilt). Placement eligibility
// is NEVER current realization.
function applyUnifiedRelationships(relationships, lookups, report, allowPartialRefs) {
  const updatesByEntity = {};
  relationships.forEach((r) => {
    const s = parseTypedId(r.source), t = parseTypedId(r.target);
    const def = KNOWN_RELATIONSHIP_TYPES[r.type];
    if (!s || !t || !def) { report.unresolved.push({ entity: "(relationship)", canonical_id: r.source, field: r.type, ref: r.target, target: "unknown" }); return; }
    const srcEntity = KIND_TO_ENTITY[s.kind];
    const tgtEntity = KIND_TO_ENTITY[t.kind];
    if (!srcEntity || !tgtEntity) { report.unresolved.push({ entity: "(relationship)", canonical_id: r.source, field: r.type, ref: r.target, target: "unknown" }); return; }
    const srcRec = resolveRef(srcEntity, r.source, lookups);
    const tgtRec = resolveRef(tgtEntity, r.target, lookups);
    if (!srcRec) { (allowPartialRefs ? report.warnings : report.unresolved).push({ entity: srcEntity, canonical_id: r.source, field: r.type, ref: r.source, target: srcEntity, note: allowPartialRefs ? "partial import: unresolved source omitted" : undefined }); return; }
    if (!tgtRec) { (allowPartialRefs ? report.warnings : report.unresolved).push({ entity: srcEntity, canonical_id: r.source, field: r.type, ref: r.target, target: tgtEntity, note: allowPartialRefs ? "partial import: unresolved target omitted" : undefined }); return; }
    if (def.array) {
      const existing = Array.isArray(srcRec[def.field]) ? srcRec[def.field] : [];
      const next = existing.includes(tgtRec.id) ? existing : [...existing, tgtRec.id];
      (updatesByEntity[srcEntity] ||= []).push({ id: srcRec.id, [def.field]: next });
    } else {
      (updatesByEntity[srcEntity] ||= []).push({ id: srcRec.id, [def.field]: tgtRec.id });
    }
    report.relationships.push({ source: r.source, type: r.type, target: r.target, resolvable: true });
  });
  return updatesByEntity;
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
  plan.capability_findings.forEach((c) => report.capability_findings.push(c));

  // ---- Preflight: block before any write ----
  const preflight = preflightImport(envelope, data, { complete, allowPartialRefs });
  report.blocked = preflight.blocked;
  report.blockedReasons = preflight.reasons;
  if (preflight.blocked) {
    plan.plans.forEach((p) => {
      if (p.action === "create") report.created.push({ entity: p.entity, canonical_id: p.canonical_id });
      else if (p.action === "update") report.updated.push({ entity: p.entity, canonical_id: p.canonical_id });
      else report.unchanged.push({ entity: p.entity, canonical_id: p.canonical_id });
    });
    report.sync_state = "import_blocked";
    report.counts = countReport(report);
    return report;
  }

  const meta = buildMeta(envelope);

  // ---- Phase 1: upsert scalar fields by canonical_id ----
  const items = plan.plans;
  const recordByItem = new Map();
  let partialFailure = false;
  for (const item of items) {
    const { entity, incoming, canonical_id, existing, action } = item;
    if (action === "unchanged") { recordByItem.set(item, existing); report.unchanged.push({ entity, canonical_id }); continue; }
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
  involved.forEach((e) => {
    const recs = new Map((fresh[e] || []).map((r) => [r.id, r]));
    items.filter((i) => i.entity === e && recordByItem.has(i)).forEach((i) => {
      const rec = recordByItem.get(i);
      if (rec && rec.id) recs.set(rec.id, rec);
    });
    fresh[e] = Array.from(recs.values());
  });
  const lookups = buildLookups(fresh);

  // ---- Phase 3: apply relationships ----
  if (!partialFailure) {
    const updatesByEntity = {};
    if (plan.format === "unified") {
      Object.assign(updatesByEntity, applyUnifiedRelationships(plan.relationships, lookups, report, allowPartialRefs));
    } else {
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
    }
    for (const entity of Object.keys(updatesByEntity)) {
      // Dedupe updates by record id (a record may be touched by multiple relationships).
      const byId = new Map();
      updatesByEntity[entity].forEach((u) => { byId.set(u.id, { ...byId.get(u.id) || {}, ...u }); });
      try { await adapter.bulkUpdate(entity, Array.from(byId.values())); }
      catch (e) { report.warnings.push({ entity, note: `relationship update failed: ${e.message}` }); partialFailure = true; }
    }
  }

  // ---- Phase 4: refresh last_seen_* provenance for unchanged records ----
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

// The frozen V1 golden crossover artifact (homelab-foundation / hlctl producer).
export const GOLDEN_CROSSOVER = `{
  "schema_version": "adaptive-homelab-atlas/v1",
  "generated_at": "2026-08-31T00:00:00Z",
  "producer": { "name": "hlctl", "version": "1.0.0" },
  "source": { "repository": "homelab-foundation", "commit": "unknown", "is_dirty": false, "content_digest": "sha256:8551fdac0fbfb523d14624dc6bf792923822deb2bc0130a65c23bb04c78611ef" },
  "entities": [
    { "schema": "homelab.execution-provider/v1", "kind": "execution-provider", "id": "test-ep-1", "provenance": { "source_class": "canonical" } },
    { "schema": "homelab.node/v1", "kind": "node", "id": "test-node-1", "provenance": { "source_class": "canonical" }, "capabilities": [ { "type": "hw-accel", "id": "accel0" } ] },
    { "schema": "homelab.workload/v1", "kind": "workload", "id": "test-wl-1", "provenance": { "source_class": "canonical" }, "requirements": { "capabilities": [ { "type": "hw-accel", "instance": "accel0" } ] } }
  ],
  "relationships": [
    { "source": "execution-provider:test-ep-1", "type": "hosted_on", "target": "node:test-node-1" },
    { "source": "workload:test-wl-1", "type": "placement_allowed_on_provider", "target": "execution-provider:test-ep-1" }
  ]
}`;