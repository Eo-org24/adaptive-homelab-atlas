// Canonical one-way import engine: homelab-foundation -> Atlas.
// Idempotent: upserts by canonical_id. Never duplicates. Never deletes infrastructure.
// Stale canonical-owned relationships ARE reconciled (arrays replaced, canonical
// Dependency records not in the current snapshot are removed) — this is a targeted
// exception for canonical-owned relationship state only; Atlas-local data is never touched.
//
// Two producer contract shapes are accepted:
//  - UNIFIED (frozen V1 canonical contract): top-level `entities[]` + `relationships[]`.
//    Strict Zod validation (v1Schema.js) runs BEFORE normalization. Each entity carries
//    `kind` + `id`; its Atlas canonical_id is `<kind>:<id>`. Relationships are explicit
//    tuples applied in a dedicated phase. Four relationship types are supported:
//    hosted_on, placement_allowed_on_provider, placement_allowed_on_node, depends_on.
//  - SECTION (legacy / backup-restore): `nodes[]`, `workloads[]`, etc. with Atlas-shaped
//    records that already carry `canonical_id` and relationship fields. Kept for backup.
//
// Safety model:
//  - Strict V1 validation (Zod, recursive, .strict) blocks malformed input before writes.
//  - Relationship endpoint kinds are enforced (hosted_on must be execution-provider→node, etc.).
//  - The persistence adapter propagates completeness; a failed/truncated fetch blocks the import.
//  - Per-record provenance distinguishes "last canonical value change" (source_commit /
//    imported_at) from "last seen in canonical snapshot" (last_seen_*). Unchanged records
//    still get their last_seen_* refreshed. generated_at (producer artifact) is stored
//    separately as source_generated_at; imported_at is when Atlas actually processed the import.
//  - Fixture tagging is explicit (options.fixtureMode) or matches the known golden fixture
//    digest — a normal V1 import with commit "unknown" is NOT auto-tagged as fixture.
import { base44 } from "@/api/base44Client";
import { ENTITY_KINDS, REF_FIELDS, DEP_TYPE_MAP, refFieldNames, buildLookups, resolveRef, buildCanonicalIndex, canonicalMatches } from "@/lib/relationships";
import { loadEntityComplete } from "@/lib/datasetLoader";
import { FIXTURE_TAG } from "@/lib/provenance";
import { validateV1Strict } from "@/lib/v1Schema";

const V1 = "adaptive-homelab-atlas/v1";

// Known golden crossover fixture content digest — used for safe fixture detection.
const GOLDEN_FIXTURE_DIGEST = "sha256:8551fdac0fbfb523d14624dc6bf792923822deb2bc0130a65c23bb04c78611ef";

// ---- Frozen V1 unified contract ----
const UNIFIED_TOP_LEVEL = new Set(["schema_version", "generated_at", "producer", "source", "entities", "relationships"]);
const KIND_TO_ENTITY = {
  node: "Node",
  "execution-provider": "ExecutionEnvironment",
  workload: "Workload",
};

// Known relationship types and how they map onto Atlas relationship fields.
// hosted_on: execution-provider -> node  =>  ExecutionEnvironment.current_host (structural realization)
// placement_allowed_on_provider: workload -> execution-provider  =>  Workload.eligible_execution_providers (eligibility, NOT realization)
// placement_allowed_on_node: workload -> node  =>  Workload.placement_allowed_nodes (eligibility, NOT preferred, NOT realization)
// depends_on: workload -> workload  =>  Dependency record (deterministic relationship_key, kind=unknown)
const KNOWN_RELATIONSHIP_TYPES = {
  hosted_on: { sourceKind: "execution-provider", targetKind: "node", entity: "ExecutionEnvironment", field: "current_host", array: false, canonicalOwned: true },
  placement_allowed_on_provider: { sourceKind: "workload", targetKind: "execution-provider", entity: "Workload", field: "eligible_execution_providers", array: true, canonicalOwned: true },
  placement_allowed_on_node: { sourceKind: "workload", targetKind: "node", entity: "Workload", field: "placement_allowed_nodes", array: true, canonicalOwned: true },
  depends_on: { sourceKind: "workload", targetKind: "workload", entity: "Dependency", special: "depends_on", canonicalOwned: true },
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
  "source_commit", "imported_at", "source_generated_at", "last_seen_source_commit", "last_seen_import_at",
  "external_id", "import_source", "import_timestamp", "field_provenance",
]);

export function validateEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { valid: false, errors: ["Envelope is not a JSON object."] };
  if (!envelope.schema_version) errors.push("Missing schema_version.");
  else if (typeof envelope.schema_version !== "string") errors.push("schema_version must be a string.");
  else if (envelope.schema_version !== V1) errors.push(`Unsupported schema_version "${envelope.schema_version}" — expected exactly "${V1}".`);
  return { valid: errors.length === 0, errors };
}

export function detectFormat(envelope) {
  return envelope && Array.isArray(envelope.entities) ? "unified" : "section";
}

const emptyReport = () => ({ created: [], updated: [], unchanged: [], failed: [], unresolved: [], conflicts: [], warnings: [], ambiguous: [], relationships: [], capability_findings: [], dependencies_created: [], dependencies_updated: [], dependencies_deleted: [], blocked: false, blockedReasons: [], sync_state: "", partial: false });
const countReport = (r) => ({
  created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length,
  failed: r.failed.length, unresolved: r.unresolved.length, conflicts: r.conflicts.length,
  warnings: r.warnings.length, ambiguous: r.ambiguous.length,
  relationships: r.relationships.length, capability_findings: r.capability_findings.length,
  dependencies_created: r.dependencies_created.length, dependencies_updated: r.dependencies_updated.length,
  dependencies_deleted: r.dependencies_deleted.length,
});

// Compare incoming scalar (non-ref, non-canonical, non-provenance) fields to existing.
function changed(incoming, existing, entity) {
  const skip = new Set([...refFieldNames(entity), ...PROVENANCE_SKIP]);
  const keys = Object.keys(incoming).filter((k) => !skip.has(k) && incoming[k] !== undefined);
  const proj = (rec) => { const o = {}; keys.forEach((k) => { o[k] = rec[k]; }); return JSON.stringify(o); };
  return proj(incoming) !== proj(existing);
}

// ---- V1 unified entity -> Atlas-shaped record (nested V1 fields consumed explicitly) ----
// Exported so overrideConflicts() can reuse the SAME mapping (no second field mapper).
export function mapUnifiedEntity(e, entity, fixtureTag) {
  const cid = `${e.kind}:${e.id}`;
  const rec = { canonical_id: cid };
  const tags = Array.isArray(e.tags) ? [...e.tags] : [];
  if (fixtureTag && !tags.includes(fixtureTag)) tags.push(fixtureTag);
  if (tags.length) rec.tags = tags;

  if (entity === "Node") {
    // Display hostname: prefer identity.physical_name, fall back to canonical id.
    rec.hostname = (e.identity && e.identity.physical_name) || e.id;
    if (e.identity && e.identity.physical_name) rec.physical_name = e.identity.physical_name;
    if (e.identity && e.identity.fqdn) rec.fqdn = e.identity.fqdn;
    if (Array.isArray(e.purpose)) rec.purpose = e.purpose;
    if (e.lifecycle && e.lifecycle.state) rec.lifecycle_state = e.lifecycle.state;
    if (e.availability && e.availability.expected) rec.availability_expectation = e.availability.expected;
    if (Array.isArray(e.capabilities) && e.capabilities.length) rec.capabilities = e.capabilities;
    if (e.resources) {
      if (e.resources.memory_gib != null) rec.memory_gib = e.resources.memory_gib;
      if (e.resources.cpu && e.resources.cpu.model) rec.cpu_model = e.resources.cpu.model;
    }
  } else if (entity === "ExecutionEnvironment") {
    // No V1 name field; use canonical id as display fallback.
    rec.name = e.id;
    rec.type = "unknown"; // default: UNKNOWN, never invent VM
    if (e.runtime && e.runtime.kind) {
      rec.runtime_kind = e.runtime.kind;
      // Map runtime.kind to Atlas internal type enum if it matches; else "unknown".
      const validTypes = ["physical_host", "vm", "lxc", "docker", "podman", "kubernetes", "external_service", "unknown"];
      rec.type = validTypes.includes(e.runtime.kind) ? e.runtime.kind : "unknown";
    }
    if (e.runtime && e.runtime.autostart != null) rec.autostart = e.runtime.autostart;
    if (Array.isArray(e.purpose)) rec.purpose = e.purpose;
    if (Array.isArray(e.capabilities) && e.capabilities.length) rec.capabilities = e.capabilities;
  } else if (entity === "Workload") {
    // Display name: prefer display_name, fall back to canonical id.
    rec.name = e.display_name || e.id;
    if (e.display_name) rec.display_name = e.display_name;
    rec.category = "unknown"; // V1 does not declare category — UNKNOWN, never user_application
    if (e.maturity) rec.maturity = e.maturity;
    if (e.runtime && e.runtime.kind) rec.runtime_kind = e.runtime.kind;
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
function normalizeEnvelope(envelope, options = {}) {
  if (detectFormat(envelope) === "unified") return normalizeUnified(envelope, options);
  return normalizeSection(envelope);
}

function normalizeUnified(envelope, options = {}) {
  const items = [];
  const inputErrors = [];
  const conflicts = [];
  const relationships = [];

  // ---- Strict V1 validation (Zod, recursive, .strict) BEFORE any processing ----
  const strict = validateV1Strict(envelope);
  if (!strict.valid) {
    strict.errors.forEach((msg) => inputErrors.push({ entity: "(validation)", index: 0, reason: msg }));
    return { items, inputErrors, conflicts, relationships, format: "unified", fixtureTag: null };
  }

  // ---- Fixture detection: explicit mode OR exact golden fixture digest ----
  const fixtureMode = options.fixtureMode === true;
  const digest = envelope.source && envelope.source.content_digest;
  const isFixtureArtifact = fixtureMode || (digest === GOLDEN_FIXTURE_DIGEST);
  const fixtureTag = isFixtureArtifact ? FIXTURE_TAG : null;

  const seen = new Map();
  (envelope.entities || []).forEach((e, idx) => {
    const cid = `${e.kind}:${e.id}`;
    if (seen.has(cid)) { conflicts.push({ canonical_id: cid, first: seen.get(cid), duplicate: idx }); return; }
    seen.set(cid, idx);
    const entity = KIND_TO_ENTITY[e.kind];
    if (!entity) { inputErrors.push({ entity: "(entity)", index: idx, reason: `unknown entity kind "${e.kind}"` }); return; }
    items.push({ entity, section: "entities", index: idx, canonical_id: cid, incoming: mapUnifiedEntity(e, entity, fixtureTag), kind: e.kind });
  });

  const relSeen = new Set();
  (envelope.relationships || []).forEach((r, idx) => {
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

// Plan the import: match incoming canonical_ids against existing Atlas records.
export function planImport(envelope, data, options = {}) {
  const v = validateEnvelope(envelope);
  if (!v.valid) return { valid: false, errors: v.errors, items: [], inputErrors: [], conflicts: [], ambiguous: [], plans: [], relationships: [], capability_findings: [], lookups: buildLookups(data || {}), index: buildCanonicalIndex(data || {}), format: detectFormat(envelope) };
  const norm = normalizeEnvelope(envelope, options);
  const { items, inputErrors, conflicts, relationships, format } = norm;
  const index = buildCanonicalIndex(data || {});
  const lookups = buildLookups(data || {});
  const ambiguous = [];
  const plans = [];
  items.forEach((it) => {
    const matches = canonicalMatches(it.entity, it.canonical_id, index);
    if (matches.length > 1) {
      ambiguous.push({ canonical_id: it.canonical_id, entity: it.entity, matches: matches.map((m) => ({ id: m.id, name: m.hostname || m.name || m.title || m.model || m.id })) });
      return;
    }
    const existing = matches.length === 1 ? matches[0] : null;
    const action = !existing ? "create" : changed(it.incoming, existing, it.entity) ? "update" : "unchanged";
    plans.push({ ...it, existing, action });
  });
  const capability_findings = collectCapabilityFindings(items);
  return { valid: true, errors: [], items, inputErrors, conflicts, ambiguous, plans, relationships, capability_findings, lookups, index, format };
}

// Preflight: decide whether writes are blocked.
export function preflightImport(envelope, data, options = {}) {
  const complete = options.complete !== false;
  const allowPartialRefs = !!options.allowPartialRefs;
  const plan = planImport(envelope, data, options);
  if (!plan.valid) return { blocked: true, reasons: plan.errors, plan };
  const reasons = [];
  if (!complete) reasons.push("incomplete existing-dataset load");
  if (plan.inputErrors.length) reasons.push("malformed records (strict V1 validation failed)");
  if (plan.conflicts.length) reasons.push("duplicate canonical IDs in incoming snapshot");
  if (plan.ambiguous.length) reasons.push("ambiguous existing canonical identity");
  if (!allowPartialRefs) {
    const plannedCids = new Set(plan.plans.map((p) => p.canonical_id));
    let unresolved = 0;
    if (plan.format === "unified") {
      plan.relationships.forEach((r) => {
        const s = parseTypedId(r.source), t = parseTypedId(r.target);
        if (!s || !t || !KIND_TO_ENTITY[s.kind] || !KIND_TO_ENTITY[t.kind]) { unresolved++; return; }
        if (!plannedCids.has(r.source) && !resolveRef(KIND_TO_ENTITY[s.kind], r.source, plan.lookups)) unresolved++;
        if (!plannedCids.has(r.target) && !resolveRef(KIND_TO_ENTITY[t.kind], r.target, plan.lookups)) unresolved++;
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
          values.forEach((v) => { if (!v) return; if (resolveRef(target, v, plan.lookups)) return; if (canonicalPlan.has(v)) return; unresolved++; });
        });
      });
    }
    if (unresolved > 0) reasons.push("unresolved canonical references");
  }
  return { blocked: reasons.length > 0, reasons, plan };
}

// Pure planning: no writes.
export function previewImport(envelope, data, options = {}) {
  const report = emptyReport();
  const plan = planImport(envelope, data, options);
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
  const preflight = preflightImport(envelope, data, { ...options, complete: true, allowPartialRefs: false });
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
    source_commit: commit, // "unknown" preserved verbatim — never fabricated
    schema_version: envelope.schema_version, // projection schema version (adaptive-homelab-atlas/v1)
    source_version: envelope.schema_version, // source_version = schema version, NOT producer version
    producer_version: producer.version || "",
    // imported_at = when Atlas actually processed the import (NOW), not generated_at
    imported_at: new Date().toISOString(),
    // source_generated_at = producer artifact generation time (separate from import time)
    source_generated_at: envelope.generated_at || "",
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
    source_generated_at: meta.source_generated_at,
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

// Build a deterministic relationship key for V1 depends_on tuples.
function dependencyRelationshipKey(source, target) {
  return `${source}|depends_on|${target}`;
}

// Apply V1 unified relationships. Returns { updatesByEntity, dependenciesToUpsert, staleDependencyKeys }.
// For canonical-owned arrays: group by (source object, field) and accumulate targets into
// a single set — multiple relationships of the same type do NOT overwrite each other.
// For canonical-owned scalars (hosted_on): set directly (last wins; only one per source).
// For depends_on: collect Dependency upserts keyed by relationship_key.
//
// Empty-set reconciliation: for every canonical V1 source entity in the current import,
// if the snapshot contains NO relationship of a canonical-owned type for that entity,
// clear the corresponding field to [] (arrays) or "" (scalar). This removes stale
// canonical relationship state from previous snapshots. Atlas-local overlays
// (preferred_node, eligible_alternative_nodes, field_provenance) are NOT touched.
function applyUnifiedRelationships(relationships, plans, lookups, report, allowPartialRefs, existingDeps) {
  // Accumulation: Map<id, { id, [field]: value }> per entity.
  // Array fields are accumulated (deduplicated). Scalar fields are set (last wins).
  const accumByEntity = {};
  const dependenciesToUpsert = [];
  const snapshotDepKeys = new Set();

  // Index existing canonical dependencies by relationship_key.
  const existingByKey = new Map();
  (existingDeps || []).forEach((d) => {
    if (d.source_kind === "canonical" && d.relationship_key) existingByKey.set(d.relationship_key, d);
  });

  // Track which relationship types appear in the snapshot per source canonical_id.
  const snapshotRelBySource = {};
  relationships.forEach((r) => {
    if (!snapshotRelBySource[r.source]) snapshotRelBySource[r.source] = new Set();
    snapshotRelBySource[r.source].add(r.type);
  });

  const getAccum = (entity, id) => {
    if (!accumByEntity[entity]) accumByEntity[entity] = new Map();
    if (!accumByEntity[entity].has(id)) accumByEntity[entity].set(id, { id });
    return accumByEntity[entity].get(id);
  };

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

    if (def.special === "depends_on") {
      const relKey = dependencyRelationshipKey(r.source, r.target);
      snapshotDepKeys.add(relKey);
      dependenciesToUpsert.push({ relationship_key: relKey, source_id: srcRec.id, target_id: tgtRec.id, existing: existingByKey.get(relKey) || null });
      report.relationships.push({ source: r.source, type: r.type, target: r.target, resolvable: true });
    } else if (def.array) {
      // Canonical-owned array: ACCUMULATE targets into a single set (deduplicated).
      const entry = getAccum(srcEntity, srcRec.id);
      const cur = entry[def.field] || [];
      if (!cur.includes(tgtRec.id)) cur.push(tgtRec.id);
      entry[def.field] = cur;
      report.relationships.push({ source: r.source, type: r.type, target: r.target, resolvable: true });
    } else {
      // Canonical-owned scalar: set directly.
      const entry = getAccum(srcEntity, srcRec.id);
      entry[def.field] = tgtRec.id;
      report.relationships.push({ source: r.source, type: r.type, target: r.target, resolvable: true });
    }
  });

  // ---- Empty-set reconciliation ----
  // For each canonical V1 source entity in the current import, clear canonical-owned
  // fields that have NO relationships in the snapshot. This removes stale canonical
  // relationship state from previous imports. Atlas-local overlays are NOT touched.
  const CANONICAL_OWNED_FIELDS = {
    ExecutionEnvironment: [{ relType: "hosted_on", field: "current_host", clearValue: "" }],
    Workload: [
      { relType: "placement_allowed_on_provider", field: "eligible_execution_providers", clearValue: [] },
      { relType: "placement_allowed_on_node", field: "placement_allowed_nodes", clearValue: [] },
    ],
  };
  (plans || []).forEach((p) => {
    const fields = CANONICAL_OWNED_FIELDS[p.entity];
    if (!fields) return;
    const rec = resolveRef(p.entity, p.canonical_id, lookups);
    if (!rec) return;
    const relTypes = snapshotRelBySource[p.canonical_id] || new Set();
    fields.forEach(({ relType, field, clearValue }) => {
      if (!relTypes.has(relType)) {
        const entry = getAccum(p.entity, rec.id);
        entry[field] = clearValue;
      }
    });
  });

  // Stale canonical dependencies: keys in existing but NOT in current snapshot.
  const staleDependencyKeys = [];
  existingByKey.forEach((dep, key) => {
    if (!snapshotDepKeys.has(key)) staleDependencyKeys.push(dep);
  });

  // Convert Maps to arrays for the caller.
  const updatesByEntity = {};
  for (const entity of Object.keys(accumByEntity)) {
    updatesByEntity[entity] = Array.from(accumByEntity[entity].values());
  }

  return { updatesByEntity, dependenciesToUpsert, staleDependencyKeys };
}

// Perform the import (writes). Idempotent. Adapter is injectable.
// options: { adapter, complete, allowPartialRefs, fixtureMode }
export async function runImport(envelope, data, options = {}) {
  const adapter = options.adapter || createBase44Adapter();
  const allowPartialRefs = !!options.allowPartialRefs;
  const report = emptyReport();

  // ---- FRESH READ: load complete live dataset before mutation planning ----
  // Caller-supplied data may be stale (e.g. after a prior import on the same page
  // mutated the database but the page dataset was not yet refreshed). Mutation
  // planning MUST use a fresh, complete live dataset — never trust caller data
  // as the authority for create/update/unchanged decisions. If any required
  // fresh read fails or completeness cannot be proven, block before writes.
  let liveData = {};
  try {
    const loaded = await Promise.all(
      ENTITY_KINDS.map(async (k) => [k, await adapter.listAll(k)])
    );
    liveData = Object.fromEntries(loaded);
  } catch (e) {
    report.blocked = true;
    report.blockedReasons = [`incomplete existing-dataset load: ${e.message}`];
    report.sync_state = "import_blocked";
    report.counts = countReport(report);
    return report;
  }

  // Use liveData (NOT caller data) as the authority for planning.
  const plan = planImport(envelope, liveData, options);
  if (!plan.valid) {
    report.failed.push({ reason: plan.errors.join(" ") });
    report.blocked = true; report.blockedReasons = plan.errors; report.sync_state = "import_blocked";
    report.counts = countReport(report); return report;
  }
  plan.inputErrors.forEach((e) => report.failed.push({ entity: e.entity, index: e.index, reason: e.reason }));
  plan.conflicts.forEach((c) => report.conflicts.push(c));
  plan.ambiguous.forEach((a) => report.ambiguous.push(a));
  plan.capability_findings.forEach((c) => report.capability_findings.push(c));

  // ---- Preflight: block before any write (using fresh live data) ----
  const preflight = preflightImport(envelope, liveData, { ...options, complete: true, allowPartialRefs });
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

  // ---- Phase 2: refresh lookups with fresh data (fail closed on incomplete) ----
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
  ENTITY_KINDS.forEach((k) => { if (!fresh[k]) fresh[k] = (liveData[k] || []).map((r) => ({ ...r })); });
  involved.forEach((e) => {
    const recs = new Map((fresh[e] || []).map((r) => [r.id, r]));
    items.filter((i) => i.entity === e && recordByItem.has(i)).forEach((i) => {
      const rec = recordByItem.get(i);
      if (rec && rec.id) recs.set(rec.id, rec);
    });
    fresh[e] = Array.from(recs.values());
  });
  // Also load existing Dependencies for depends_on reconciliation.
  if (!partialFailure && plan.format === "unified") {
    try {
      if (!fresh.Dependency) fresh.Dependency = await adapter.listAll("Dependency");
    } catch (e) {
      report.warnings.push({ note: `Dependency refresh failed: ${e.message}` });
      partialFailure = true;
    }
  }
  const lookups = buildLookups(fresh);

  // ---- Phase 3: apply relationships ----
  if (!partialFailure) {
    const updatesByEntity = {};
    let dependenciesToUpsert = [];
    let staleDependencyKeys = [];

    if (plan.format === "unified") {
      const relResult = applyUnifiedRelationships(plan.relationships, plan.plans, lookups, report, allowPartialRefs, fresh.Dependency || []);
      Object.assign(updatesByEntity, relResult.updatesByEntity);
      dependenciesToUpsert = relResult.dependenciesToUpsert;
      staleDependencyKeys = relResult.staleDependencyKeys;
    } else {
      items.forEach((item) => {
        if (!recordByItem.has(item)) return;
        const record = recordByItem.get(item);
        const fields = resolveRelationshipFields(item, lookups, report, allowPartialRefs);
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

    // Apply entity field updates (hosted_on, placement arrays).
    // C7: Advance value-change provenance (source_commit/imported_at) only when the
    // canonical relationship value ACTUALLY changes. Unchanged relationships only
    // advance last_seen_* — never falsely advance value-change provenance.
    for (const entity of Object.keys(updatesByEntity)) {
      const byId = new Map();
      updatesByEntity[entity].forEach((u) => {
        // For canonical-owned arrays: REPLACE (not merge) — stale entries removed.
        byId.set(u.id, { ...byId.get(u.id) || {}, ...u });
      });
      const updates = Array.from(byId.values());
      // C7: Augment each update with provenance based on whether the value actually changed
      const augmentedUpdates = updates.map((u) => {
        const existing = (fresh[entity] || []).find((r) => r.id === u.id);
        if (!existing) {
          // Record was just created — provenance already set in Phase 1
          return { ...u, last_seen_source_commit: meta.source_commit, last_seen_import_at: meta.imported_at };
        }
        let relChanged = false;
        for (const [field, newVal] of Object.entries(u)) {
          if (field === "id") continue;
          const oldVal = existing[field];
          if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) { relChanged = true; break; }
        }
        if (relChanged) {
          return { ...u, source_commit: meta.source_commit, imported_at: meta.imported_at, last_seen_source_commit: meta.source_commit, last_seen_import_at: meta.imported_at };
        }
        // Relationship unchanged — only advance last_seen_*, NOT source_commit/imported_at
        return { ...u, last_seen_source_commit: meta.source_commit, last_seen_import_at: meta.imported_at };
      });
      try { await adapter.bulkUpdate(entity, augmentedUpdates); }
      catch (e) { report.warnings.push({ entity, note: `relationship update failed: ${e.message}` }); partialFailure = true; }
    }

    // Upsert Dependency records for depends_on (deterministic relationship_key).
    // C7: Advance value-change provenance (source_commit/imported_at) only when the
    // dependency value ACTUALLY changes. An existing depends_on with the same
    // deterministic identity and same source_id/target_id must NOT receive a new
    // value-change source_commit/imported_at — only last_seen_* advances.
    if (dependenciesToUpsert.length) {
      for (const dep of dependenciesToUpsert) {
        const depExisting = dep.existing;
        const depValueChanged = !depExisting || depExisting.source_id !== dep.source_id || depExisting.target_id !== dep.target_id;
        const depPayload = {
          source_type: "workload", source_id: dep.source_id,
          target_type: "workload", target_id: dep.target_id,
          kind: "unknown", // V1 does not declare strength — never invent "hard"
          relationship_key: dep.relationship_key,
          canonical_id: dep.relationship_key,
          source_kind: "canonical",
          source_repository: meta.source_repository,
          source_version: meta.source_version,
          last_seen_source_commit: meta.source_commit,
          last_seen_import_at: meta.imported_at,
        };
        if (depValueChanged) {
          depPayload.source_commit = meta.source_commit;
          depPayload.imported_at = meta.imported_at;
        } else {
          // Keep existing value-change provenance — do not advance
          depPayload.source_commit = depExisting.source_commit || meta.source_commit;
          depPayload.imported_at = depExisting.imported_at || meta.imported_at;
        }
        try {
          if (depExisting) {
            await adapter.update("Dependency", depExisting.id, depPayload);
            report.dependencies_updated.push({ relationship_key: dep.relationship_key });
          } else {
            await adapter.create("Dependency", depPayload);
            report.dependencies_created.push({ relationship_key: dep.relationship_key });
          }
        } catch (e) {
          report.failed.push({ entity: "Dependency", canonical_id: dep.relationship_key, reason: e.message });
          partialFailure = true;
        }
      }
    }

    // Stale canonical dependency removal: delete canonical deps not in current snapshot.
    // C6: A failure deleting a stale canonical Dependency is a PARTIAL import —
    // the stale record remains, the failure must be visible, and the import must
    // not claim synchronized/local_additions for that run.
    if (staleDependencyKeys.length) {
      for (const dep of staleDependencyKeys) {
        try {
          await adapter.delete("Dependency", dep.id);
          report.dependencies_deleted.push({ relationship_key: dep.relationship_key });
        } catch (e) {
          report.warnings.push({ entity: "Dependency", note: `stale dependency deletion failed: ${e.message}` });
          partialFailure = true;
        }
      }
    }
  }

  // ---- Phase 4: refresh last_seen_* provenance for unchanged records ----
  if (!partialFailure) {
    const provByEntity = {};
    items.forEach((item) => {
      if (item.action !== "unchanged") return;
      const rec = recordByItem.get(item);
      if (!rec || !rec.id) return;
      (provByEntity[item.entity] ||= []).push({ id: rec.id, last_seen_source_commit: meta.source_commit, last_seen_import_at: meta.imported_at, source_generated_at: meta.source_generated_at });
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
  if (report.blocked) return "import_blocked";
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
    source_generated_at: meta.source_generated_at,
    source_commit: meta.source_commit,
    schema_version: meta.schema_version,
    producer_version: meta.producer_version || "",
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
    // Fail closed: throw when the dataset is incomplete. A failed/truncated fetch
    // must NEVER be interpreted as 0 existing records.
    async listAll(entity) {
      const res = await loadEntityComplete(client, entity);
      if (!res.complete) {
        const reason = res.error ? res.error.message : "truncated/paginated — completeness not confirmed";
        throw new Error(`Dataset incomplete for ${entity}: ${reason}`);
      }
      return res.records;
    },
    async create(entity, payload) { return await client.entities[entity].create(payload); },
    async update(entity, id, payload) { return await client.entities[entity].update(id, payload); },
    async bulkUpdate(entity, updates) { return await client.entities[entity].bulkUpdate(updates); },
    async delete(entity, id) { return await client.entities[entity].delete(id); },
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
    async delete(entity, id) {
      if (!store[entity] || !store[entity].has(id)) throw new Error(`delete: ${entity} ${id} not found`);
      store[entity].delete(id);
    },
    async upsertSync(payload) {
      const arr = Array.from(store.CanonicalSync.values());
      if (arr.length) { store.CanonicalSync.set(arr[0].id, { ...arr[0], ...payload }); return; }
      const id = newId(); store.CanonicalSync.set(id, { ...payload, id });
    },
    _store: store,
  };
}

// The REAL crossover artifact that exposed the persistence/idempotence defect.
// source: homelab-foundation, commit a1f33a877db26ed0d351113ca064791eb7f4792d
// content_digest: sha256:8b319e237e926cb014b963107348f02f12f065e298522ebfa2ee85be4558b6e7
// 4 Nodes, 2 Execution Environments, 1 Workload, 3 relationships.
export const REAL_CROSSOVER_ARTIFACT = `{
  "schema_version": "adaptive-homelab-atlas/v1",
  "generated_at": "2026-08-31T00:00:00Z",
  "producer": { "name": "hlctl", "version": "1.0.0" },
  "source": { "repository": "homelab-foundation", "commit": "a1f33a877db26ed0d351113ca064791eb7f4792d", "is_dirty": false, "content_digest": "sha256:8b319e237e926cb014b963107348f02f12f065e298522ebfa2ee85be4558b6e7" },
  "entities": [
    { "schema": "homelab.node/v1", "kind": "node", "id": "futro", "provenance": { "source_class": "canonical" }, "identity": { "physical_name": "futro" } },
    { "schema": "homelab.node/v1", "kind": "node", "id": "pve7", "provenance": { "source_class": "canonical" }, "identity": { "physical_name": "pve7" } },
    { "schema": "homelab.node/v1", "kind": "node", "id": "rack1", "provenance": { "source_class": "canonical" }, "identity": { "physical_name": "rack1" } },
    { "schema": "homelab.node/v1", "kind": "node", "id": "rig9", "provenance": { "source_class": "canonical" }, "identity": { "physical_name": "rig9" } },
    { "schema": "homelab.execution-provider/v1", "kind": "execution-provider", "id": "files1", "provenance": { "source_class": "canonical" }, "runtime": { "kind": "lxc" } },
    { "schema": "homelab.execution-provider/v1", "kind": "execution-provider", "id": "tools1", "provenance": { "source_class": "canonical" }, "runtime": { "kind": "lxc" } },
    { "schema": "homelab.workload/v1", "kind": "workload", "id": "ssd-intake", "provenance": { "source_class": "canonical" }, "display_name": "SSD Intake", "requirements": { "capabilities": [ { "type": "block-device-intake", "instance": "intake0" } ] } }
  ],
  "relationships": [
    { "source": "execution-provider:files1", "type": "hosted_on", "target": "node:pve7" },
    { "source": "execution-provider:tools1", "type": "hosted_on", "target": "node:pve7" },
    { "source": "workload:ssd-intake", "type": "placement_allowed_on_provider", "target": "execution-provider:tools1" }
  ]
}`;

export const SAMPLE_ENVELOPE = `{
  "schema_version": "adaptive-homelab-atlas/v1",
  "generated_at": "2026-08-30T00:00:00Z",
  "producer": { "name": "hlctl", "version": "1.0.0" },
  "source": { "repository": "homelab-foundation", "commit": "abc1234", "is_dirty": false, "content_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
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

// The frozen V1 golden crossover artifact (minimal — homelab-foundation / hlctl producer).
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

// Comprehensive V1 fixture exercising EVERY frozen V1 field and all four relationship types.
export const COMPREHENSIVE_V1_FIXTURE = `{
  "schema_version": "adaptive-homelab-atlas/v1",
  "generated_at": "2026-09-01T00:00:00Z",
  "producer": { "name": "hlctl", "version": "2.0.0" },
  "source": { "repository": "homelab-foundation", "commit": "comp1234", "is_dirty": false, "content_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  "entities": [
    {
      "schema": "homelab.node/v1",
      "kind": "node",
      "id": "comp-node-1",
      "provenance": { "source_class": "canonical" },
      "identity": { "physical_name": "storage-rig", "fqdn": "storage-rig.lan" },
      "purpose": ["storage", "backup"],
      "lifecycle": { "state": "active" },
      "availability": { "expected": "always_on" },
      "capabilities": [ { "type": "hw-accel", "id": "accel1" } ],
      "resources": { "memory_gib": 128, "cpu": { "model": "AMD Ryzen 9 5950X" } }
    },
    {
      "schema": "homelab.execution-provider/v1",
      "kind": "execution-provider",
      "id": "comp-ep-1",
      "provenance": { "source_class": "canonical" },
      "purpose": ["container-runtime"],
      "runtime": { "kind": "lxc", "autostart": true },
      "capabilities": [ { "type": "hw-accel", "id": "accel1" } ]
    },
    {
      "schema": "homelab.workload/v1",
      "kind": "workload",
      "id": "comp-wl-1",
      "provenance": { "source_class": "canonical" },
      "display_name": "Media Server",
      "maturity": "production",
      "runtime": { "kind": "container" },
      "requirements": { "capabilities": [ { "type": "hw-accel", "instance": "accel1" } ] }
    },
    {
      "schema": "homelab.workload/v1",
      "kind": "workload",
      "id": "comp-wl-2",
      "provenance": { "source_class": "canonical" },
      "display_name": "Indexer",
      "maturity": "stable",
      "runtime": { "kind": "container" }
    }
  ],
  "relationships": [
    { "source": "execution-provider:comp-ep-1", "type": "hosted_on", "target": "node:comp-node-1" },
    { "source": "workload:comp-wl-1", "type": "placement_allowed_on_provider", "target": "execution-provider:comp-ep-1" },
    { "source": "workload:comp-wl-1", "type": "placement_allowed_on_node", "target": "node:comp-node-1" },
    { "source": "workload:comp-wl-1", "type": "depends_on", "target": "workload:comp-wl-2" }
  ]
}`;