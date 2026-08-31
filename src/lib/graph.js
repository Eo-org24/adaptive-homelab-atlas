// Architecture graph layer: nodes + edges derived entirely from real Atlas records.
// No separate graph source-of-truth. Identity uses internal ids (prefixed by kind);
// canonical_id is carried for display/external identity. Edges come from relationship fields.
import { normalizeSourceKind } from "@/lib/provenance";
import { detectCycles } from "@/lib/homelab";
import { applyOperations } from "@/lib/changeSandbox";

const nid = (kind, id) => `${kind}:${id}`;

function baseNode(kind, rec, labelField, layer) {
  return {
    id: nid(kind, rec.id), kind, record: rec, layer: layer ?? 0,
    label: rec[labelField] || rec.hostname || rec.name || rec.title || rec.model || rec.id,
    canonical_id: rec.canonical_id || "",
    lifecycle: rec.lifecycle_state || rec.lifecycle || "",
    criticality: rec.criticality || "",
    state: normalizeSourceKind(rec.source_kind || rec.state_classification),
    flags: [],
  };
}

function realizationNodes(data, includeStorage) {
  const nodes = [];
  (data.Node || []).forEach((n) => nodes.push(baseNode("node", n, "hostname", 0)));
  (data.ExecutionEnvironment || []).forEach((e) => nodes.push(baseNode("env", e, "name", 1)));
  (data.Workload || []).forEach((w) => nodes.push(baseNode("workload", w, "name", 2)));
  if (includeStorage) (data.StorageDevice || []).forEach((s) => { if (s.current_node) nodes.push(baseNode("storage", s, "model", 1)); });
  return nodes;
}

function realizationEdges(data, includeStorage) {
  const edges = [];
  (data.ExecutionEnvironment || []).forEach((e) => { if (e.current_host) edges.push({ id: `host-${e.id}`, source: nid("node", e.current_host), target: nid("env", e.id), type: "hosts", provenance: normalizeSourceKind(e.source_kind) }); });
  (data.Workload || []).forEach((w) => {
    if (w.current_environment) edges.push({ id: `exec-${w.id}`, source: nid("env", w.current_environment), target: nid("workload", w.id), type: "executes", provenance: normalizeSourceKind(w.source_kind) });
    else if (w.current_host) edges.push({ id: `hostd-${w.id}`, source: nid("node", w.current_host), target: nid("workload", w.id), type: "hosts-direct", provenance: normalizeSourceKind(w.source_kind) });
  });
  if (includeStorage) (data.StorageDevice || []).forEach((s) => { if (s.current_node) edges.push({ id: `contains-${s.id}`, source: nid("node", s.current_node), target: nid("storage", s.id), type: "contains", provenance: normalizeSourceKind(s.source_kind) }); });
  return edges;
}

export const physicalGraph = (data) => ({ nodes: realizationNodes(data, true), edges: realizationEdges(data, true) });
export const executionGraph = (data) => ({ nodes: realizationNodes(data, false), edges: realizationEdges(data, false) });

// Placement-policy view: workload -> execution-provider "placement-allowed" edges
// (from eligible_execution_providers), plus env -> node "hosts" for context. This is
// eligibility only — it MUST NOT produce an "executes"/current-realization edge.
export function placementGraph(data) {
  const nodes = [];
  (data.Node || []).forEach((n) => nodes.push(baseNode("node", n, "hostname", 0)));
  (data.ExecutionEnvironment || []).forEach((e) => nodes.push(baseNode("env", e, "name", 1)));
  (data.Workload || []).forEach((w) => nodes.push(baseNode("workload", w, "name", 2)));
  const edges = [];
  (data.ExecutionEnvironment || []).forEach((e) => { if (e.current_host) edges.push({ id: `host-${e.id}`, source: nid("node", e.current_host), target: nid("env", e.id), type: "hosts", provenance: normalizeSourceKind(e.source_kind) }); });
  (data.Workload || []).forEach((w) => {
    (w.eligible_execution_providers || []).forEach((eid) => {
      edges.push({ id: `pallow-${w.id}-${eid}`, source: nid("workload", w.id), target: nid("env", eid), type: "placement-allowed", provenance: normalizeSourceKind(w.source_kind) });
    });
  });
  return { nodes, edges };
}

export function storageGraph(data) {
  const nodes = [], edges = [];
  (data.Node || []).forEach((n) => nodes.push(baseNode("node", n, "hostname", 0)));
  (data.StoragePool || []).forEach((p) => nodes.push(baseNode("pool", p, "name", 1)));
  (data.StorageDevice || []).forEach((s) => nodes.push(baseNode("storage", s, "model", 2)));
  (data.StoragePool || []).forEach((p) => {
    if (p.node) edges.push({ id: `pn-${p.id}`, source: nid("node", p.node), target: nid("pool", p.id), type: "hosts-pool", provenance: normalizeSourceKind(p.source_kind) });
    (p.device_ids || []).forEach((did) => edges.push({ id: `pd-${p.id}-${did}`, source: nid("pool", p.id), target: nid("storage", did), type: "includes", provenance: normalizeSourceKind(p.source_kind) }));
  });
  return { nodes, edges };
}

function rankNodes(nodes, edges) {
  const adj = {}; edges.forEach((e) => { (adj[e.source] ||= []).push(e.target); });
  const memo = {};
  const depth = (id, seen = new Set()) => { if (seen.has(id)) return 0; seen.add(id); if (memo[id] != null) return memo[id]; const next = adj[id] || []; if (!next.length) return memo[id] = 0; return memo[id] = 1 + Math.max(...next.map((t) => depth(t, new Set(seen)))); };
  nodes.forEach((n) => { n.layer = depth(n.id); });
}

export function dependencyGraph(data) {
  const nodes = [], edges = [];
  const wls = data.Workload || [], envs = data.ExecutionEnvironment || [], nodesR = data.Node || [], storage = data.StorageDevice || [], net = data.NetworkDevice || [], deps = data.Dependency || [];
  wls.forEach((w) => nodes.push(baseNode("workload", w, "name", 0)));
  const ensure = (kind, rec, label) => { const id = kind === "external" ? `external:${rec.name || rec.id}` : nid(kind, rec.id); if (!nodes.find((n) => n.id === id)) nodes.push({ ...baseNode(kind, rec, kind === "node" ? "hostname" : "name", 0), label }); return id; };
  deps.forEach((d) => {
    const srcKind = d.source_type === "workload" ? "workload" : d.source_type === "environment" ? "env" : d.source_type === "node" ? "node" : null;
    if (!srcKind) return;
    const sId = nid(srcKind, d.source_id);
    if (!nodes.find((n) => n.id === sId)) return;
    let tKind = null, tRec = null, tLabel = null;
    if (d.target_type === "workload") { tKind = "workload"; tRec = wls.find((x) => x.id === d.target_id); tLabel = tRec?.name; }
    else if (d.target_type === "environment") { tKind = "env"; tRec = envs.find((x) => x.id === d.target_id); tLabel = tRec?.name; }
    else if (d.target_type === "node") { tKind = "node"; tRec = nodesR.find((x) => x.id === d.target_id); tLabel = tRec?.hostname; }
    else if (d.target_type === "storage") { tKind = "storage"; tRec = storage.find((x) => x.id === d.target_id); tLabel = tRec?.model; }
    else if (d.target_type === "network_device" || d.target_type === "network_service") { tKind = "network"; tRec = net.find((x) => x.id === d.target_id); tLabel = tRec?.name; }
    else if (d.target_type === "external") { tKind = "external"; tRec = { id: d.target_name, name: d.target_name }; tLabel = d.target_name || d.target_id; }
    if (!tRec) return;
    const tId = ensure(tKind, tRec, tLabel);
    edges.push({ id: `dep-${d.id}`, source: sId, target: tId, type: "depends_on", kind: d.kind, provenance: normalizeSourceKind(d.source_kind), flags: [] });
  });
  rankNodes(nodes, edges);
  const cycles = detectCycles(deps);
  const cycleIds = new Set(cycles.flat());
  nodes.forEach((n) => { if (cycleIds.has(n.record?.id)) n.flags.push("cycle"); if (["retiring", "retired", "degraded", "maintenance"].includes(n.lifecycle)) n.flags.push("weak-lifecycle"); });
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  edges.forEach((e) => { const s = nodes.find((n) => n.id === e.source), t = nodes.find((n) => n.id === e.target); if (s && t && s.criticality && t.criticality && (rank[t.criticality] || 0) < (rank[s.criticality] || 0)) e.flags.push("criticality-inversion"); });
  return { nodes, edges };
}

export function changeGraph(data, change) {
  const beforeEdges = realizationEdges(data, false);
  const proposed = applyOperations(data, change?.operations || []);
  const afterEdges = realizationEdges({ ...data, ...proposed }, false);
  const beforeSet = new Set(beforeEdges.map((e) => `${e.source}|${e.type}|${e.target}`));
  const afterSet = new Set(afterEdges.map((e) => `${e.source}|${e.type}|${e.target}`));
  const edges = [];
  beforeEdges.forEach((e) => { const k = `${e.source}|${e.type}|${e.target}`; edges.push({ ...e, status: afterSet.has(k) ? "unchanged" : "removed" }); });
  afterEdges.forEach((e) => { const k = `${e.source}|${e.type}|${e.target}`; if (!beforeSet.has(k)) edges.push({ ...e, status: "added" }); });
  const nodeMap = new Map();
  realizationNodes(data, false).forEach((n) => nodeMap.set(n.id, n));
  realizationNodes(proposed, false).forEach((n) => { if (!nodeMap.has(n.id)) nodeMap.set(n.id, { ...n, flags: ["added"] }); });
  const affected = new Set([...(change?.affected_nodes || []), ...(change?.affected_workloads || [])]);
  nodeMap.forEach((n) => { if (affected.has(n.record?.id)) n.flags = [...(n.flags || []), "affected"]; });
  return { nodes: [...nodeMap.values()], edges };
}

export const MODES = [
  { key: "physical", label: "Physical Realization" },
  { key: "execution", label: "Execution Topology" },
  { key: "placement", label: "Placement Policy" },
  { key: "dependency", label: "Workload Dependencies" },
  { key: "storage", label: "Storage Topology" },
  { key: "change", label: "Change Impact" },
];