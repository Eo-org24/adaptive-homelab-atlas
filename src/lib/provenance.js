// Provenance / truth-state normalization and field-level overlay (backwards-compatible).
// Standard vocabulary: canonical, observed, planned, inferred, local, sample, unknown.
// Legacy "manual" -> local; "imported"/"documented" -> canonical (display only; data unchanged).

const KIND_MAP = {
  canonical: "canonical", observed: "observed", planned: "planned",
  inferred: "inferred", local: "local", sample: "sample",
  manual: "local", imported: "canonical", documented: "canonical",
};

export function normalizeSourceKind(k) {
  if (!k) return "unknown";
  return KIND_MAP[k] || "unknown";
}

// A record is "sample" if its truth state (source_kind or state_classification)
// normalizes to "sample". Sample data must NOT participate in real-infrastructure
// calculations unless the operator explicitly enables INCLUDE SAMPLE DATA.
export function isSample(rec) {
  if (!rec) return false;
  return normalizeSourceKind(rec.source_kind || rec.state_classification) === "sample";
}

// A record is a synthetic crossover fixture when it carries the
// `atlas-crossover-fixture` tag. Fixtures are canonical (source_kind unchanged)
// but must be excluded from real-infrastructure operational calculations so the
// crossover test data never pollutes live homelab totals or placement candidates.
export const FIXTURE_TAG = "atlas-crossover-fixture";
export function isFixture(rec) {
  if (!rec) return false;
  return Array.isArray(rec.tags) && rec.tags.includes(FIXTURE_TAG);
}

// A record participates in real operational calculations only when it is neither
// sample data nor a synthetic crossover fixture. Provenance/identity/data-quality
// checks still run on the full set; this gate is for capacity/placement/health
// aggregates only.
export function isOperational(rec) {
  return !isSample(rec) && !isFixture(rec);
}

// Return a dataset copy with sample records removed from every entity array.
// When includeSample is true (or no data), returns the input unchanged.
export function realDataset(data, { includeSample = false } = {}) {
  if (includeSample || !data) return data;
  const out = {};
  Object.keys(data).forEach((k) => {
    out[k] = Array.isArray(data[k]) ? data[k].filter((r) => !isSample(r)) : data[k];
  });
  return out;
}

// Category-aware staleness configuration (§12). Operator-configurable; sensible defaults.
export const STALE_CONFIG = {
  hardware: { freshDays: 180, agingDays: 365, label: "Hardware inventory" },
  network: { freshDays: 30, agingDays: 90, label: "Network state" },
  service: { freshDays: 7, agingDays: 30, label: "Service state" },
  storage: { freshDays: 30, agingDays: 90, label: "Storage health" },
  default: { freshDays: 90, agingDays: 180, label: "General" },
};

export function staleStatus(observedAt, category = "default") {
  if (!observedAt) return "NO_OBSERVATION";
  const t = new Date(observedAt).getTime();
  if (isNaN(t)) return "UNKNOWN";
  const cfg = STALE_CONFIG[category] || STALE_CONFIG.default;
  const ageDays = (Date.now() - t) / 86400000;
  if (ageDays < cfg.freshDays) return "FRESH";
  if (ageDays < cfg.agingDays) return "AGING";
  return "STALE";
}

export function observationCategory(objectType) {
  return { node: "hardware", workload: "service", environment: "service", storage: "storage", network_device: "network" }[objectType] || "default";
}

// Field-level provenance overlay. Stored as a JSON string in `field_provenance`:
// { field: { observed, observed_at, planned, local, inferred, confidence, source_commit } }
// Flat fields remain the canonical current value; overlays add parallel truth layers.
export function readFieldProvenance(rec) {
  if (!rec || !rec.field_provenance) return {};
  if (typeof rec.field_provenance === "string") { try { return JSON.parse(rec.field_provenance) || {}; } catch { return {}; } }
  if (typeof rec.field_provenance === "object") return rec.field_provenance;
  return {};
}

export function hasLocalOverride(rec, field) {
  const fp = readFieldProvenance(rec);
  return !!(fp[field] && fp[field].local != null);
}

// Truth layers for a field: canonical (flat) + observed/planned/local/inferred overlays.
export function truthLayers(rec, field, flatValue) {
  const layers = [];
  const fp = readFieldProvenance(rec);
  const ov = fp[field] || {};
  const baseKind = rec.source_kind === "canonical" ? "canonical" : normalizeSourceKind(rec.source_kind || rec.state_classification);
  layers.push({ kind: ov.canonical != null ? "canonical" : baseKind, value: flatValue, meta: {} });
  if (ov.observed != null) layers.push({ kind: "observed", value: ov.observed, meta: { observed_at: ov.observed_at, confidence: ov.confidence } });
  if (ov.planned != null) layers.push({ kind: "planned", value: ov.planned, meta: {} });
  if (ov.local != null) layers.push({ kind: "local", value: ov.local, meta: {} });
  if (ov.inferred != null) layers.push({ kind: "inferred", value: ov.inferred, meta: { confidence: ov.confidence } });
  return layers;
}

// Canonical import conflict detection (§14): incoming canonical change vs existing local override.
export function overrideConflicts(envelope, data) {
  const conflicts = [];
  if (!envelope) return conflicts;
  const byCid = {};
  ["nodes", "execution_environments", "workloads", "storage_devices", "network_devices"].forEach((sec) => {
    const kindMap = { nodes: "Node", execution_environments: "ExecutionEnvironment", workloads: "Workload", storage_devices: "StorageDevice", network_devices: "NetworkDevice" };
    (envelope[sec] || []).forEach((rec) => {
      if (!rec.canonical_id) return;
      const entity = kindMap[sec];
      const existing = (data[entity] || []).find((r) => r.canonical_id === rec.canonical_id);
      if (!existing) return;
      const fp = readFieldProvenance(existing);
      Object.keys(fp).forEach((field) => {
        if (fp[field].local == null) return;
        if (rec[field] != null && rec[field] !== existing[field]) {
          conflicts.push({ canonical_id: rec.canonical_id, entity, field, canonicalValue: rec[field], localValue: fp[field].local, currentValue: existing[field] });
        }
      });
    });
  });
  return conflicts;
}