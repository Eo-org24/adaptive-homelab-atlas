// Shared relationship-resolution layer.
// Understands Base44 internal ids AND canonical_id across all entity kinds.
// UI navigation may use internal ids; external sync logic MUST use canonical_id.

export const ENTITY_KINDS = [
  "Node", "ExecutionEnvironment", "Workload", "Decision", "Dependency",
  "StorageDevice", "NetworkDevice", "StoragePool", "SwitchPort", "Task",
  "Maintenance", "PlannedChange",
];

// Dependency / maintenance / task "type" vocab -> entity kind.
export const DEP_TYPE_MAP = {
  workload: "Workload",
  environment: "ExecutionEnvironment",
  node: "Node",
  network_service: "NetworkDevice",
  network_device: "NetworkDevice",
  storage: "StorageDevice",
  external: null,
};
export const depKind = (t) => DEP_TYPE_MAP[t] || null;

// Relationship fields per entity that hold canonical_ids (or arrays of them) needing resolution.
// target "_source_type"/"_target_type" => resolve via the record's source_type/target_type.
export const REF_FIELDS = [
  { entity: "ExecutionEnvironment", field: "current_host", target: "Node" },
  { entity: "Workload", field: "current_environment", target: "ExecutionEnvironment" },
  { entity: "Workload", field: "current_host", target: "Node" },
  { entity: "Workload", field: "preferred_node", target: "Node" },
  { entity: "Workload", field: "eligible_alternative_nodes", target: "Node", array: true },
  { entity: "Decision", field: "supersedes", target: "Decision" },
  { entity: "Decision", field: "superseded_by", target: "Decision" },
  { entity: "Decision", field: "related_nodes", target: "Node", array: true },
  { entity: "Decision", field: "related_workloads", target: "Workload", array: true },
  { entity: "Dependency", field: "source_id", target: "_source_type" },
  { entity: "Dependency", field: "target_id", target: "_target_type" },
  { entity: "StorageDevice", field: "current_node", target: "Node" },
  { entity: "StoragePool", field: "node", target: "Node" },
  { entity: "StoragePool", field: "device_ids", target: "StorageDevice", array: true },
  { entity: "Task", field: "dependency_task", target: "Task" },
];

export const refFieldNames = (entity) => REF_FIELDS.filter((f) => f.entity === entity).map((f) => f.field);

// Build id + canonical_id lookup maps from an aggregated data map.
export function buildLookups(data) {
  const byId = {};
  const byCanonical = {};
  ENTITY_KINDS.forEach((k) => {
    byId[k] = new Map();
    byCanonical[k] = new Map();
    (data[k] || []).forEach((r) => {
      byId[k].set(r.id, r);
      if (r.canonical_id) byCanonical[k].set(r.canonical_id, r);
    });
  });
  return { byId, byCanonical };
}

// Resolve a reference value to a record. Tries canonical_id first, then internal id.
export function resolveRef(targetKind, value, lookups) {
  if (!value || !targetKind) return null;
  if (lookups.byCanonical[targetKind]?.has(value)) return lookups.byCanonical[targetKind].get(value);
  if (lookups.byId[targetKind]?.has(value)) return lookups.byId[targetKind].get(value);
  return null;
}

// ---- Workload -> Environment -> Node authority (§7/§8) ----
// A workload's physical node is DERIVED from its execution environment.
// Legacy workload.current_host is only a fallback for records without an environment.
export function workloadPhysicalNode(workload, envs, nodes) {
  if (!workload) return null;
  const env = workload.current_environment ? (envs || []).find((e) => e.id === workload.current_environment) : null;
  if (env && env.current_host) {
    return (nodes || []).find((n) => n.id === env.current_host) || null;
  }
  if (workload.current_host) return (nodes || []).find((n) => n.id === workload.current_host) || null;
  return null;
}

// Workloads hosted on a node, resolved through their execution environment (with legacy fallback).
export function nodeHostedWorkloads(node, workloads, envs) {
  if (!node) return [];
  const envIdsOnNode = new Set((envs || []).filter((e) => e.current_host === node.id).map((e) => e.id));
  return (workloads || []).filter((w) =>
    (w.current_environment && envIdsOnNode.has(w.current_environment)) ||
    (!w.current_environment && w.current_host === node.id)
  );
}

// ---- Delete safety (§9): find everything that references a target record ----
export function findReferences(targetType, targetId, data) {
  const refs = [];
  const name = (r) => r.name || r.hostname || r.title || r.task || r.decision_id || r.model || r.id;
  const push = (from_type, rec, field) => refs.push({ from_type, from_id: rec.id, from_name: name(rec), field });

  (data.Workload || []).forEach((w) => {
    if (w.current_environment === targetId && targetType === "ExecutionEnvironment") push("Workload", w, "current_environment");
    if (w.current_host === targetId && targetType === "Node") push("Workload", w, "current_host");
    if (w.preferred_node === targetId && targetType === "Node") push("Workload", w, "preferred_node");
    if ((w.eligible_alternative_nodes || []).includes(targetId) && targetType === "Node") push("Workload", w, "eligible_alternative_nodes");
  });
  (data.ExecutionEnvironment || []).forEach((e) => { if (e.current_host === targetId && targetType === "Node") push("ExecutionEnvironment", e, "current_host"); });
  (data.Dependency || []).forEach((d) => {
    if (d.source_id === targetId && depKind(d.source_type) === targetType) push("Dependency", d, "source_id");
    if (d.target_id === targetId && depKind(d.target_type) === targetType) push("Dependency", d, "target_id");
  });
  (data.StorageDevice || []).forEach((s) => { if (s.current_node === targetId && targetType === "Node") push("StorageDevice", s, "current_node"); });
  (data.StoragePool || []).forEach((p) => {
    if (p.node === targetId && targetType === "Node") push("StoragePool", p, "node");
    if ((p.device_ids || []).includes(targetId) && targetType === "StorageDevice") push("StoragePool", p, "device_ids");
  });
  (data.Decision || []).forEach((d) => {
    if ((d.related_nodes || []).includes(targetId) && targetType === "Node") push("Decision", d, "related_nodes");
    if ((d.related_workloads || []).includes(targetId) && targetType === "Workload") push("Decision", d, "related_workloads");
    if (d.supersedes === targetId && targetType === "Decision") push("Decision", d, "supersedes");
    if (d.superseded_by === targetId && targetType === "Decision") push("Decision", d, "superseded_by");
  });
  (data.Task || []).forEach((t) => {
    if (t.dependency_task === targetId && targetType === "Task") push("Task", t, "dependency_task");
    if (t.related_object_id === targetId && depKind(t.related_object_type) === targetType) push("Task", t, "related_object_id");
  });
  (data.Maintenance || []).forEach((m) => { if (m.target_id === targetId && depKind(m.target_type) === targetType) push("Maintenance", m, "target_id"); });
  return refs;
}