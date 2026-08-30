// Deterministic architecture-health engine.
// Produces structured findings derived purely from documented relationships and state.
// No live monitoring, no AI guessing — where data is insufficient it says so explicitly.

import { detectCycles, fmtGB, nodeAllocations, nodeOversubscription, environmentUsage, environmentOversubscription, nodeStorageUsable } from "@/lib/homelab";

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function nameOf(list, id, key) {
  if (!id || !list) return "";
  const r = list.find((x) => x.id === id);
  return r ? (r[key] || r.hostname || r.name || r.title || id) : "";
}

export function runHealthChecks(data) {
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const deps = data.Dependency || [];
  const maint = data.Maintenance || [];
  const tasks = data.Task || [];
  const storage = data.StorageDevice || [];
  const pools = data.StoragePool || [];
  const netdevs = data.NetworkDevice || [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const wlIds = new Set(workloads.map((w) => w.id));
  const envIds = new Set(envs.map((e) => e.id));
  const ndIds = new Set(netdevs.map((d) => d.id));
  const storageIds = new Set(storage.map((d) => d.id));

  const findings = [];
  const push = (f) => findings.push({ status: "open", data_sufficient: true, ...f });

  const wlName = (id) => nameOf(workloads, id, "name");
  const nodeName = (id) => nameOf(nodes, id, "hostname");

  const refExists = (type, id) => {
    switch (type) {
      case "node": return nodeIds.has(id);
      case "workload": return wlIds.has(id);
      case "environment": return envIds.has(id);
      case "network_device": case "network_service": return ndIds.has(id);
      case "storage": return storageIds.has(id);
      default: return false;
    }
  };

  // ---------- Identity / reference ----------
  workloads.forEach((w) => {
    if (w.current_host && !nodeIds.has(w.current_host)) push({ code: "ID-001", title: "Dangling host reference", severity: "high", category: "identity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `Workload "${w.name}" references a host node that no longer exists.`, evidence: [`current_host=${w.current_host}`], suggested_action: "Reassign the workload to a valid node or clear the reference." });
    if (w.current_environment && !envIds.has(w.current_environment)) push({ code: "ID-001", title: "Dangling environment reference", severity: "high", category: "identity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `Workload "${w.name}" references an execution environment that no longer exists.`, evidence: [`current_environment=${w.current_environment}`], suggested_action: "Reassign to a valid environment or clear the reference." });
    if (w.preferred_node && !nodeIds.has(w.preferred_node)) push({ code: "ID-001", title: "Dangling preferred-node reference", severity: "low", category: "identity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `Preferred node for "${w.name}" does not exist.`, evidence: [`preferred_node=${w.preferred_node}`], suggested_action: "Update the preferred node." });
    (w.eligible_alternative_nodes || []).forEach((id) => { if (id && !nodeIds.has(id)) push({ code: "ID-001", title: "Dangling eligible-node reference", severity: "low", category: "identity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `Eligible alternative node for "${w.name}" does not exist.`, evidence: [`eligible list includes ${id}`], suggested_action: "Remove the stale node from the eligible list." }); });
  });
  envs.forEach((e) => {
    if (e.current_host && !nodeIds.has(e.current_host)) push({ code: "ID-001", title: "Dangling host reference", severity: "high", category: "identity", affected_type: "environment", affected_id: e.id, affected_name: e.name, explanation: `Environment "${e.name}" references a host node that no longer exists.`, evidence: [`current_host=${e.current_host}`], suggested_action: "Reassign the environment to a valid node." });
  });
  deps.forEach((d) => {
    if (!refExists(d.source_type, d.source_id)) push({ code: "ID-002", title: "Dependency source missing", severity: "high", category: "identity", affected_type: "dependency", affected_id: d.id, affected_name: `${d.source_type}→${d.target_type}`, explanation: "A dependency points from a source object that no longer exists.", evidence: [`source ${d.source_type}=${d.source_id}`], suggested_action: "Delete or re-point the dependency." });
    if (!refExists(d.target_type, d.target_id)) push({ code: "ID-003", title: "Dependency target missing", severity: "high", category: "identity", affected_type: "dependency", affected_id: d.id, affected_name: `${d.source_type}→${d.target_type}`, explanation: "A dependency points to a target object that no longer exists.", evidence: [`target ${d.target_type}=${d.target_id}`], suggested_action: "Delete or re-point the dependency." });
  });
  maint.forEach((m) => {
    if (m.target_id && !refExists(m.target_type, m.target_id)) push({ code: "ID-004", title: "Maintenance target missing", severity: "medium", category: "identity", affected_type: "maintenance", affected_id: m.id, affected_name: m.type, explanation: "A maintenance record references a target that no longer exists.", evidence: [`target ${m.target_type}=${m.target_id}`], suggested_action: "Re-link the maintenance record or archive it." });
  });
  tasks.forEach((t) => {
    if (t.related_object_id && !refExists(t.related_object_type, t.related_object_id)) push({ code: "ID-005", title: "Task reference missing", severity: "low", category: "identity", affected_type: "task", affected_id: t.id, affected_name: t.task, explanation: "A task references an object that no longer exists.", evidence: [`related ${t.related_object_type}=${t.related_object_id}`], suggested_action: "Re-link or clear the task reference." });
  });
  envs.forEach((e) => {
    const used = workloads.some((w) => w.current_environment === e.id);
    if (!e.current_host && !used) push({ code: "ID-006", title: "Orphaned execution environment", severity: "low", category: "identity", affected_type: "environment", affected_id: e.id, affected_name: e.name, explanation: `Environment "${e.name}" has no host node and no workload runs in it.`, evidence: ["no current_host", "no workload references this environment"], suggested_action: "Assign a host, link a workload, or retire the environment." });
  });

  // ---------- Capacity: aggregate oversubscription + per-workload ----------
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const envById = Object.fromEntries(envs.map((e) => [e.id, e]));
  nodes.forEach((n) => {
    const over = nodeOversubscription(n, workloads, envs, pools);
    const alloc = nodeAllocations(n, workloads, envs);
    if (over.cpu) push({ code: "NODE_CPU_OVERSUBSCRIBED", title: "Node CPU oversubscribed", severity: "high", category: "capacity", affected_type: "node", affected_id: n.id, affected_name: n.hostname, explanation: `Allocated CPU on "${n.hostname}" exceeds capacity by ${over.cpu}.`, evidence: [`allocated ${alloc.cpu} > capacity ${n.logical_cpus ?? n.physical_cores}`], suggested_action: "Reduce environment allocations or move workloads off this node." });
    if (over.ram) push({ code: "NODE_RAM_OVERSUBSCRIBED", title: "Node RAM oversubscribed", severity: "high", category: "capacity", affected_type: "node", affected_id: n.id, affected_name: n.hostname, explanation: `Allocated RAM on "${n.hostname}" exceeds capacity by ${fmtGB(over.ram)}.`, evidence: [`allocated ${alloc.ram}GB > capacity ${n.ram_capacity_gb}GB`], suggested_action: "Reduce environment allocations or move workloads off this node." });
    if (over.storage) push({ code: "NODE_STORAGE_OVERSUBSCRIBED", title: "Node storage oversubscribed", severity: "medium", category: "capacity", affected_type: "node", affected_id: n.id, affected_name: n.hostname, explanation: `Allocated storage on "${n.hostname}" exceeds usable pool capacity by ${fmtGB(over.storage)}.`, evidence: [`allocated ${alloc.storage}GB > usable ${nodeStorageUsable(n, pools).usable}GB`], suggested_action: "Add pool capacity or relocate storage-heavy workloads." });
  });
  envs.forEach((e) => {
    const over = environmentOversubscription(e, workloads);
    const usage = environmentUsage(e, workloads);
    if (over.cpu) push({ code: "ENV_CPU_OVERSUBSCRIBED", title: "Environment CPU oversubscribed", severity: "high", category: "capacity", affected_type: "environment", affected_id: e.id, affected_name: e.name, explanation: `Workloads in "${e.name}" require more CPU than allocated.`, evidence: [`usage ${usage.cpu} > allocation ${e.cpu_allocation}`], suggested_action: "Increase environment CPU allocation or move workloads out." });
    if (over.ram) push({ code: "ENV_RAM_OVERSUBSCRIBED", title: "Environment RAM oversubscribed", severity: "high", category: "capacity", affected_type: "environment", affected_id: e.id, affected_name: e.name, explanation: `Workloads in "${e.name}" require more RAM than allocated.`, evidence: [`usage ${usage.ram}GB > allocation ${e.ram_allocation_gb}GB`], suggested_action: "Increase environment RAM allocation or move workloads out." });
    if (over.storage) push({ code: "ENV_STORAGE_OVERSUBSCRIBED", title: "Environment storage oversubscribed", severity: "medium", category: "capacity", affected_type: "environment", affected_id: e.id, affected_name: e.name, explanation: `Workloads in "${e.name}" require more storage than allocated.`, evidence: [`usage ${usage.storage}GB > allocation ${e.storage_allocation_gb}GB`], suggested_action: "Increase environment storage allocation or move workloads out." });
  });
  workloads.forEach((w) => {
    const env = w.current_environment ? envById[w.current_environment] : null;
    const host = (env && env.current_host) ? nodeById[env.current_host] : (w.current_host ? nodeById[w.current_host] : null);
    if (w.lifecycle === "active" && !env && !w.current_host) push({ code: "WORKLOAD_PLACEMENT_UNRESOLVED", title: "Workload placement unresolved", severity: "medium", category: "capacity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `Active workload "${w.name}" has no execution environment and no host.`, evidence: ["no current_environment", "no current_host"], suggested_action: "Assign an execution environment or host." });
    if (env && !env.current_host && w.lifecycle === "active") push({ code: "WORKLOAD_PLACEMENT_UNRESOLVED", title: "Workload environment unplaced", severity: "medium", category: "capacity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" runs in environment "${env.name}" which has no host node.`, evidence: [`environment ${env.name} has no current_host`], suggested_action: "Assign a host to the environment." });
    if (!host) return;
    if (w.gpu_vram_requirement_gb) {
      const gpuPresent = (host.gpus && host.gpus.length > 0) || (host.gpu_vram_gb != null && host.gpu_vram_gb > 0);
      if (!gpuPresent && host.gpus != null) push({ code: "MISSING_REQUIRED_GPU", title: "Required GPU missing", severity: "high", category: "capacity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" requires GPU VRAM but host "${host.hostname}" has no documented GPU.`, evidence: [`gpu_vram_requirement ${w.gpu_vram_requirement_gb}GB; node has no GPU`], suggested_action: "Move to a GPU-equipped node." });
      else if (gpuPresent && host.gpu_vram_gb != null && w.gpu_vram_requirement_gb > host.gpu_vram_gb) push({ code: "GPU_VRAM_INSUFFICIENT", title: "GPU VRAM insufficient", severity: "high", category: "capacity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" requires ${w.gpu_vram_requirement_gb}GB VRAM but host GPU has ${host.gpu_vram_gb}GB.`, evidence: [`requirement ${w.gpu_vram_requirement_gb}GB > ${host.gpu_vram_gb}GB`], suggested_action: "Move to a node with a larger GPU." });
    }
    if (w.ram_requirement_gb && !env && host.ram_capacity_gb == null) push({ code: "UNKNOWN_REQUIRED_CAPACITY", title: "Required capacity unknown", severity: "medium", category: "capacity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" requires RAM but host "${host.hostname}" RAM capacity is undocumented.`, evidence: [`ram_requirement ${w.ram_requirement_gb}GB; node ram_capacity_gb unknown`], suggested_action: "Document node RAM capacity.", data_sufficient: false });
    if (env && w.ram_requirement_gb && env.ram_allocation_gb == null) push({ code: "UNKNOWN_REQUIRED_CAPACITY", title: "Required capacity unknown", severity: "medium", category: "capacity", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" requires RAM but environment "${env.name}" RAM allocation is undocumented.`, evidence: [`ram_requirement ${w.ram_requirement_gb}GB; env ram_allocation unknown`], suggested_action: "Document environment RAM allocation.", data_sufficient: false });
  });

  // ---------- Dependency ----------
  const cycles = detectCycles(deps);
  cycles.forEach((c) => {
    const names = c.map((id) => wlName(id) || id);
    push({ code: "DEP-001", title: "Dependency cycle", severity: "high", category: "dependency", affected_type: "workload", affected_id: c[0], affected_name: names[0], explanation: `Circular dependency detected: ${names.join(" → ")}.`, evidence: [`cycle: ${names.join(" → ")}`], suggested_action: "Break the cycle by removing or weakening one dependency." });
  });
  const wlById = Object.fromEntries(workloads.map((w) => [w.id, w]));
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  const availRank = { best_effort: 0, on_demand: 1, business_hours: 2, always_on: 3 };
  deps.forEach((d) => {
    if (d.source_type !== "workload" || d.target_type !== "workload") return;
    if (d.kind === "optional") return;
    const src = wlById[d.source_id], tgt = wlById[d.target_id];
    if (!src || !tgt) return;
    if ((rank[tgt.criticality] || 0) < (rank[src.criticality] || 0)) push({ code: "DEP-002", title: "Criticality mismatch in dependency", severity: "medium", category: "dependency", affected_type: "workload", affected_id: src.id, affected_name: src.name, explanation: `High-criticality "${src.name}" depends on lower-criticality "${tgt.name}".`, evidence: [`source ${src.criticality} → target ${tgt.criticality}`], suggested_action: "Raise the target's criticality or weaken the dependency to optional." });
    if (src.availability_requirement && tgt.availability_requirement && (availRank[tgt.availability_requirement] || 0) < (availRank[src.availability_requirement] || 0)) push({ code: "DEP-002", title: "Availability mismatch in dependency", severity: "medium", category: "dependency", affected_type: "workload", affected_id: src.id, affected_name: src.name, explanation: `"${src.name}" (${src.availability_requirement}) depends on "${tgt.name}" (${tgt.availability_requirement}).`, evidence: [`source ${src.availability_requirement} → target ${tgt.availability_requirement}`], suggested_action: "Raise the target's availability or add redundancy." });
  });
  nodes.forEach((n) => {
    const critical = workloads.filter((w) => w.current_host === n.id && (w.criticality === "high" || w.criticality === "critical"));
    if (critical.length >= 4) push({ code: "DEP-003", title: "Dependency concentration on single node", severity: "medium", category: "dependency", affected_type: "node", affected_id: n.id, affected_name: n.hostname, explanation: `"${n.hostname}" hosts ${critical.length} high/critical workloads — a single point of concentration.`, evidence: critical.map((w) => w.name), suggested_action: "Distribute critical workloads across nodes or document intentional colocation." });
  });
  const retiredStates = ["retiring", "retired"];
  deps.forEach((d) => {
    const tgt = d.target_type === "workload" ? wlById[d.target_id] : null;
    if (tgt && retiredStates.includes(tgt.lifecycle)) push({ code: "DEP-004", title: "Dependency on retiring/retired workload", severity: "high", category: "dependency", affected_type: "workload", affected_id: d.source_id, affected_name: wlName(d.source_id), explanation: `"${wlName(d.source_id)}" depends on "${tgt.name}" which is ${tgt.lifecycle}.`, evidence: [`target lifecycle=${tgt.lifecycle}`], suggested_action: "Migrate the dependency to an active replacement." });
  });
  envs.forEach((e) => {
    if (retiredStates.includes(e.lifecycle)) {
      workloads.filter((w) => w.current_environment === e.id && !retiredStates.includes(w.lifecycle)).forEach((w) => push({ code: "DEP-004", title: "Active workload in retired environment", severity: "high", category: "dependency", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" runs in environment "${e.name}" which is ${e.lifecycle}.`, evidence: [`environment lifecycle=${e.lifecycle}; workload lifecycle=${w.lifecycle}`], suggested_action: "Migrate the workload to an active environment." }));
    }
  });

  // ---------- State ----------
  workloads.forEach((w) => {
    const env = w.current_environment ? envById[w.current_environment] : null;
    if (w.reconstructable && env && env.persistent_state && !w.backup_requirement) push({ code: "STATE-002", title: "Persistent state without backup policy", severity: "high", category: "state", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is reconstructable and runs with persistent state, but no backup requirement is documented.`, evidence: [`reconstructable=true`, `env persistent_state=true`, `backup_requirement empty`], suggested_action: "Document a backup requirement or mark the workload non-reconstructable." });
    if (w.reconstructable && env && env.persistent_state) push({ code: "STATE-001", title: "Reconstructable workload with persistent state", severity: "medium", category: "state", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is marked reconstructable but its environment "${env.name}" carries persistent state.`, evidence: [`reconstructable=true`, `env persistent_state=true`], suggested_action: "Confirm reconstructability accounts for state recovery, or mark non-reconstructable." });
    if (w.lifecycle === "active" && !w.current_host && !env) push({ code: "STATE-003", title: "Active workload without realization", severity: "medium", category: "state", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is active but has no current host node.`, evidence: [`lifecycle=active`, `current_host empty`], suggested_action: "Assign a host or set lifecycle to planned." });
    if (w.lifecycle === "retired" && w.current_host) push({ code: "STATE-003", title: "Retired workload still realized", severity: "low", category: "state", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is retired but still has a current host.`, evidence: [`lifecycle=retired`, `current_host set`], suggested_action: "Clear the host or remove the workload." });
  });

  // ---------- Provenance ----------
  workloads.forEach((w) => {
    const sc = w.state_classification;
    if ((w.criticality === "high" || w.criticality === "critical") && (sc === "sample" || sc === "inferred")) push({ code: "PROV-001", title: "Critical data from non-authoritative source", severity: "medium", category: "provenance", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is ${w.criticality}-critical but its state is ${sc}, not declared/observed.`, evidence: [`criticality=${w.criticality}`, `state_classification=${sc}`], suggested_action: "Validate against an authoritative source and re-classify as declared or observed." });
    if (sc === "planned" && w.lifecycle === "active") push({ code: "PROV-003", title: "Planned state used as current evidence", severity: "medium", category: "provenance", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is active but its state is classified as planned.`, evidence: [`lifecycle=active`, `state_classification=planned`], suggested_action: "Re-classify as declared/observed once realized, or set lifecycle to planned." });
    if (sc === "observed" && w.observed_at) {
      const ageDays = (Date.now() - new Date(w.observed_at).getTime()) / 86400000;
      if (ageDays > 90) push({ code: "PROV-002", title: "Stale observation", severity: "low", category: "provenance", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" was last observed ${Math.round(ageDays)} days ago.`, evidence: [`observed_at=${w.observed_at}`, `age=${Math.round(ageDays)}d`], suggested_action: "Re-observe or re-classify as declared." });
    }
    if (sc === "sample") push({ code: "PROV-004", title: "Sample data present", severity: "info", category: "provenance", affected_type: "workload", affected_id: w.id, affected_name: w.name, explanation: `"${w.name}" is marked as sample data, not real infrastructure.`, evidence: [`state_classification=sample`], suggested_action: "Replace with real data before relying on this record." });
  });
  storage.forEach((d) => {
    if (d.state_class === "sample") push({ code: "PROV-004", title: "Sample data present", severity: "info", category: "provenance", affected_type: "storage", affected_id: d.id, affected_name: d.model, explanation: `Storage device "${d.model}" is marked as sample data.`, evidence: [`state_class=sample`], suggested_action: "Replace with real data before relying on this record." });
  });

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code));
  return findings;
}

export function findingsBySeverity(findings) {
  const m = { critical: [], high: [], medium: [], low: [], info: [] };
  findings.forEach((f) => (m[f.severity] || (m[f.severity] = [])).push(f));
  return m;
}