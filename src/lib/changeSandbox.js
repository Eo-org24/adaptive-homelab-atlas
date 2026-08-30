// Change sandbox: apply structured planned operations to an in-memory clone of current
// data, then re-run integrity checks and compare before/after. Simulation only — never writes.

import { runHealthChecks } from "@/lib/healthEngine";
import { nodeAllocations } from "@/lib/homelab";
import { resolveRef } from "@/lib/relationships";

export const OP_TYPES = [
  "MOVE_WORKLOAD", "CHANGE_EXECUTION_HOST", "CHANGE_RESOURCE_ALLOCATION",
  "ADD_EXECUTION_ENVIRONMENT", "RETIRE_NODE", "CHANGE_LIFECYCLE",
  "ADD_STORAGE", "REMOVE_STORAGE", "NETWORK_RELATIONSHIP_CHANGE", "GENERIC_PROPERTY_CHANGE",
];

function cloneData(data) {
  const out = {};
  Object.keys(data).forEach((k) => { out[k] = (data[k] || []).map((r) => ({ ...r })); });
  return out;
}

const ENTITY_BY_OBJTYPE = { node: "Node", workload: "Workload", environment: "ExecutionEnvironment", storage: "StorageDevice", network_device: "NetworkDevice" };

export function applyOperations(data, operations) {
  const proposed = cloneData(data);
  (operations || []).forEach((op) => {
    if (!op || !op.type) return;
    switch (op.type) {
      case "MOVE_WORKLOAD": {
        const wl = (proposed.Workload || []).find((w) => w.id === op.workload_id || (op.workload_canonical_id && w.canonical_id === op.workload_canonical_id));
        if (!wl) return;
        if (op.to_environment_id) wl.current_environment = op.to_environment_id;
        else if (op.to_environment_canonical_id) { const e = resolveRef("ExecutionEnvironment", op.to_environment_canonical_id, { byId: {}, byCanonical: byCanonicalMap(proposed.ExecutionEnvironment) }); if (e) wl.current_environment = e.id; }
        if (op.to_node_id) wl.current_host = op.to_node_id;
        else if (op.to_node_canonical_id) { const n = resolveRef("Node", op.to_node_canonical_id, { byId: {}, byCanonical: byCanonicalMap(proposed.Node) }); if (n) wl.current_host = n.id; }
        if (wl.current_environment) { const e = (proposed.ExecutionEnvironment || []).find((x) => x.id === wl.current_environment); if (e && e.current_host) wl.current_host = e.current_host; }
        break;
      }
      case "CHANGE_EXECUTION_HOST": {
        const e = (proposed.ExecutionEnvironment || []).find((x) => x.id === op.environment_id || (op.environment_canonical_id && x.canonical_id === op.environment_canonical_id));
        if (!e) return;
        if (op.to_node_id) e.current_host = op.to_node_id;
        else if (op.to_node_canonical_id) { const n = resolveRef("Node", op.to_node_canonical_id, { byId: {}, byCanonical: byCanonicalMap(proposed.Node) }); if (n) e.current_host = n.id; }
        break;
      }
      case "CHANGE_RESOURCE_ALLOCATION": {
        const e = (proposed.ExecutionEnvironment || []).find((x) => x.id === op.environment_id || (op.environment_canonical_id && x.canonical_id === op.environment_canonical_id));
        if (!e) return;
        if (op.cpu != null) e.cpu_allocation = op.cpu;
        if (op.ram_gb != null) e.ram_allocation_gb = op.ram_gb;
        if (op.storage_gb != null) e.storage_allocation_gb = op.storage_gb;
        break;
      }
      case "ADD_EXECUTION_ENVIRONMENT": {
        const id = `new-env-${Math.random().toString(36).slice(2, 8)}`;
        (proposed.ExecutionEnvironment = proposed.ExecutionEnvironment || []).push({ id, name: op.name || "New environment", type: op.env_type || "lxc", current_host: op.current_host_id || null, cpu_allocation: op.cpu, ram_allocation_gb: op.ram_gb, storage_allocation_gb: op.storage_gb, lifecycle: "planned" });
        break;
      }
      case "RETIRE_NODE": {
        const n = (proposed.Node || []).find((x) => x.id === op.node_id || (op.node_canonical_id && x.canonical_id === op.node_canonical_id));
        if (n) n.lifecycle_state = "retired";
        break;
      }
      case "CHANGE_LIFECYCLE": {
        const entity = ENTITY_BY_OBJTYPE[op.object_type];
        if (!entity) return;
        const r = (proposed[entity] || []).find((x) => x.id === op.object_id);
        // Workload/Environment use `lifecycle`; Node/NetworkDevice/Storage use `lifecycle_state`.
        if (r) r[(op.object_type === "workload" || op.object_type === "environment") ? "lifecycle" : "lifecycle_state"] = op.lifecycle;
        break;
      }
      case "ADD_STORAGE": {
        (proposed.StoragePool = proposed.StoragePool || []).push({ id: `new-pool-${Math.random().toString(36).slice(2, 8)}`, name: op.name || "New pool", node: op.node_id, usable_capacity_gb: op.usable_capacity_gb || 0, raid_level: "single", state: "planned" });
        break;
      }
      case "REMOVE_STORAGE": {
        const p = (proposed.StoragePool || []).find((x) => x.id === op.pool_id);
        if (p) { if (op.reduce_gb != null) p.usable_capacity_gb = Math.max(0, (p.usable_capacity_gb || 0) - op.reduce_gb); else p.state = "retired"; }
        break;
      }
      case "NETWORK_RELATIONSHIP_CHANGE": break; // not deterministically modelable
      case "GENERIC_PROPERTY_CHANGE": {
        const entity = ENTITY_BY_OBJTYPE[op.object_type];
        if (!entity) return;
        const r = (proposed[entity] || []).find((x) => x.id === op.object_id);
        if (r && op.field) r[op.field] = op.value;
        break;
      }
    }
  });
  return proposed;
}

function byCanonicalMap(list) {
  const m = new Map();
  (list || []).forEach((r) => { if (r.canonical_id) m.set(r.canonical_id, r); });
  return m;
}

function findingKey(f) { return `${f.code}|${f.affected_type || ""}|${f.affected_id || ""}`; }

export function analyzeChange(data, change) {
  const operations = change.operations || [];
  const before = runHealthChecks(data);
  let proposed = null;
  let after = [];
  let applyError = null;
  try { proposed = applyOperations(data, operations); after = runHealthChecks(proposed); }
  catch (e) { applyError = e.message; }
  if (applyError) return { error: applyError, before, after: [], operations, newFindings: [], resolvedFindings: [], unchanged: [], resourceDelta: [], unknownImpacts: [], rollbackTarget: change.rollback_strategy || null };

  const beforeKeys = new Set(before.map(findingKey));
  const afterKeys = new Set(after.map(findingKey));
  const newFindings = after.filter((f) => !beforeKeys.has(findingKey(f)));
  const resolvedFindings = before.filter((f) => !afterKeys.has(findingKey(f)));
  const unchanged = after.filter((f) => beforeKeys.has(findingKey(f)));

  const affectedNodeIds = new Set([
    ...(change.affected_nodes || []),
    ...operations.filter((o) => o.node_id).map((o) => o.node_id),
    ...operations.filter((o) => o.to_node_id).map((o) => o.to_node_id),
    ...operations.filter((o) => o.current_host_id).map((o) => o.current_host_id),
  ]);
  const resourceDelta = [];
  affectedNodeIds.forEach((nid) => {
    const n = (data.Node || []).find((x) => x.id === nid);
    if (!n) return;
    const beforeAlloc = nodeAllocations(n, data.Workload || [], data.ExecutionEnvironment || []);
    const afterAlloc = nodeAllocations(n, proposed.Workload || [], proposed.ExecutionEnvironment || []);
    resourceDelta.push({ node: n, before: beforeAlloc, after: afterAlloc, ramDelta: afterAlloc.ram - beforeAlloc.ram, cpuDelta: afterAlloc.cpu - beforeAlloc.cpu });
  });

  const unknownImpacts = operations
    .filter((o) => o.type === "NETWORK_RELATIONSHIP_CHANGE" || (o.type === "GENERIC_PROPERTY_CHANGE" && !o.field))
    .map((o) => ({ type: o.type, note: "impact not deterministically modelable from current data" }));

  return { before, after, newFindings, resolvedFindings, unchanged, resourceDelta, unknownImpacts, rollbackTarget: change.rollback_strategy || null };
}