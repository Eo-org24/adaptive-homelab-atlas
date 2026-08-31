// Deterministic architecture-health engine.
// Structured findings: { code, severity, category, affected_type, affected_id,
//   affected_canonical_id, affected_name, title, explanation, evidence, recommendation,
//   confidence, provenance, generated_at, data_sufficient }.
// No AI prose: a finding exists only if it can be proven from current data; UNKNOWN where it cannot.

import { detectCycles, fmtGB, nodeAllocations, nodeOversubscription, environmentUsage, environmentOversubscription, nodeStorageUsable } from "@/lib/homelab";
import { readFieldProvenance, staleStatus, observationCategory, isSample, STALE_CONFIG } from "@/lib/provenance";
import { buildLookups, resolveRef, refFieldNames, DEP_TYPE_MAP } from "@/lib/relationships";

const GEN_AT = new Date().toISOString();
const SEVERITY_RANK = { critical: 0, error: 1, warning: 2, info: 3 };
// Staleness thresholds are defined ONCE in provenance.js (category-aware).
// The health engine consumes that shared policy — no competing fixed threshold.

const CANONICAL_ENTITIES = ["Node", "ExecutionEnvironment", "Workload", "Decision", "Dependency", "StorageDevice", "NetworkDevice", "StoragePool", "SwitchPort"];

function nameOf(list, id, key) {
  if (!id || !list) return "";
  const r = list.find((x) => x.id === id);
  return r ? (r[key] || r.hostname || r.name || r.title || id) : "";
}

export function runHealthChecks(data, options = {}) {
  // Harden against null / non-object records so malformed input fails safely.
  const clean = {};
  Object.keys(data || {}).forEach((k) => { clean[k] = Array.isArray(data[k]) ? data[k].filter((v) => v && typeof v === "object") : data[k]; });
  data = clean;
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const deps = data.Dependency || [];
  const maint = data.Maintenance || [];
  const tasks = data.Task || [];
  const storage = data.StorageDevice || [];
  const pools = data.StoragePool || [];
  const netdevs = data.NetworkDevice || [];
  const changes = data.PlannedChange || [];
  const ports = data.SwitchPort || [];

  // Sample data must NOT participate in real-infrastructure conclusions (capacity,
  // SPOF, placement) unless the operator explicitly enables INCLUDE SAMPLE DATA.
  // Provenance/identity/relationship/data-quality checks still run on the full set
  // (so sample-data presence is still flagged).
  const includeSample = options.includeSample === true;
  const realNodes = includeSample ? nodes : nodes.filter((n) => !isSample(n));
  const realWorkloads = includeSample ? workloads : workloads.filter((w) => !isSample(w));
  const realEnvs = includeSample ? envs : envs.filter((e) => !isSample(e));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const wlIds = new Set(workloads.map((w) => w.id));
  const envIds = new Set(envs.map((e) => e.id));
  const ndIds = new Set(netdevs.map((d) => d.id));
  const storageIds = new Set(storage.map((d) => d.id));

  const findings = [];
  const push = (f) => findings.push({
    generated_at: GEN_AT, provenance: "deterministic",
    confidence: f.confidence || "high", data_sufficient: f.data_sufficient !== false,
    affected_canonical_id: f.affected_canonical_id || "", recommendation: f.recommendation || "",
    ...f,
  });

  const wlName = (id) => nameOf(workloads, id, "name");
  const wlCid = (id) => (workloads.find((w) => w.id === id) || {}).canonical_id || "";
  const nodeCid = (id) => (nodes.find((n) => n.id === id) || {}).canonical_id || "";

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

  // ---------- RELATIONSHIP ----------
  workloads.forEach((w) => {
    if (w.current_host && !nodeIds.has(w.current_host)) push({ code: "DANGLING_HOST_REF", severity: "error", category: "relationship", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Dangling host reference", explanation: `Workload "${w.name}" references a host node that no longer exists.`, evidence: [`current_host=${w.current_host}`], recommendation: "Reassign the workload to a valid node or clear the reference." });
    if (w.current_environment && !envIds.has(w.current_environment)) push({ code: "DANGLING_ENV_REF", severity: "error", category: "relationship", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Dangling environment reference", explanation: `Workload "${w.name}" references an execution environment that no longer exists.`, evidence: [`current_environment=${w.current_environment}`], recommendation: "Reassign to a valid environment or clear the reference." });
    if (w.preferred_node && !nodeIds.has(w.preferred_node)) push({ code: "DANGLING_PREFERRED_REF", severity: "warning", category: "relationship", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Dangling preferred-node reference", explanation: `Preferred node for "${w.name}" does not exist.`, evidence: [`preferred_node=${w.preferred_node}`], recommendation: "Update the preferred node." });
    (w.eligible_alternative_nodes || []).forEach((id) => { if (id && !nodeIds.has(id)) push({ code: "DANGLING_ELIGIBLE_REF", severity: "warning", category: "relationship", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Dangling eligible-node reference", explanation: `Eligible alternative node for "${w.name}" does not exist.`, evidence: [`eligible list includes ${id}`], recommendation: "Remove the stale node from the eligible list." }); });
  });
  envs.forEach((e) => {
    if (e.current_host && !nodeIds.has(e.current_host)) push({ code: "DANGLING_HOST_REF", severity: "error", category: "relationship", affected_type: "environment", affected_id: e.id, affected_canonical_id: e.canonical_id, affected_name: e.name, title: "Dangling host reference", explanation: `Environment "${e.name}" references a host node that no longer exists.`, evidence: [`current_host=${e.current_host}`], recommendation: "Reassign the environment to a valid node." });
  });
  deps.forEach((d) => {
    if (!refExists(d.source_type, d.source_id)) push({ code: "DEP_SOURCE_MISSING", severity: "error", category: "relationship", affected_type: "dependency", affected_id: d.id, affected_canonical_id: d.canonical_id, affected_name: `${d.source_type}→${d.target_type}`, title: "Dependency source missing", explanation: "A dependency points from a source object that no longer exists.", evidence: [`source ${d.source_type}=${d.source_id}`], recommendation: "Delete or re-point the dependency." });
    if (!refExists(d.target_type, d.target_id)) push({ code: "DEP_TARGET_MISSING", severity: "error", category: "relationship", affected_type: "dependency", affected_id: d.id, affected_canonical_id: d.canonical_id, affected_name: `${d.source_type}→${d.target_type}`, title: "Dependency target missing", explanation: "A dependency points to a target object that no longer exists.", evidence: [`target ${d.target_type}=${d.target_id}`], recommendation: "Delete or re-point the dependency." });
  });
  maint.forEach((m) => {
    if (m.target_id && !refExists(m.target_type, m.target_id)) push({ code: "MAINT_TARGET_MISSING", severity: "warning", category: "relationship", affected_type: "maintenance", affected_id: m.id, affected_name: m.type, title: "Maintenance target missing", explanation: "A maintenance record references a target that no longer exists.", evidence: [`target ${m.target_type}=${m.target_id}`], recommendation: "Re-link the maintenance record or archive it." });
  });
  tasks.forEach((t) => {
    if (t.related_object_id && !refExists(t.related_object_type, t.related_object_id)) push({ code: "TASK_REF_MISSING", severity: "info", category: "relationship", affected_type: "task", affected_id: t.id, affected_name: t.task, title: "Task reference missing", explanation: "A task references an object that no longer exists.", evidence: [`related ${t.related_object_type}=${t.related_object_id}`], recommendation: "Re-link or clear the task reference." });
  });
  // Orphaned environment
  envs.forEach((e) => {
    const used = workloads.some((w) => w.current_environment === e.id);
    if (!e.current_host && !used) push({ code: "ORPHANED_ENV", severity: "info", category: "relationship", affected_type: "environment", affected_id: e.id, affected_canonical_id: e.canonical_id, affected_name: e.name, title: "Orphaned execution environment", explanation: `Environment "${e.name}" has no host node and no workload runs in it.`, evidence: ["no current_host", "no workload references this environment"], recommendation: "Assign a host, link a workload, or retire the environment." });
  });
  // Storage pool referencing missing devices
  pools.forEach((p) => {
    (p.device_ids || []).forEach((did) => {
      if (did && !storageIds.has(did)) push({ code: "POOL_MISSING_DEVICE", severity: "error", category: "relationship", affected_type: "storage_pool", affected_id: p.id, affected_canonical_id: p.canonical_id, affected_name: p.name, title: "Storage pool references missing device", explanation: `Pool "${p.name}" lists a storage device that no longer exists.`, evidence: [`device_ids includes ${did}`], recommendation: "Remove the stale device from the pool or restore the device record." });
    });
  });
  // SwitchPort referencing a missing network device
  ports.forEach((sp) => {
    if (sp.device && !ndIds.has(sp.device)) push({ code: "DANGLING_DEVICE_REF", severity: "error", category: "relationship", affected_type: "switch_port", affected_id: sp.id, affected_canonical_id: sp.canonical_id, affected_name: sp.port_identifier, title: "Dangling switch-port device reference", explanation: `Switch port "${sp.port_identifier}" references a network device that no longer exists.`, evidence: [`device=${sp.device}`], recommendation: "Re-link the port to a valid network device or restore the device record." });
  });

  // ---------- IDENTITY: duplicate canonical IDs ----------
  const canonicalIndex = new Map();
  CANONICAL_ENTITIES.forEach((entity) => {
    (data[entity] || []).forEach((r) => {
      if (!r.canonical_id) return;
      if (!canonicalIndex.has(r.canonical_id)) canonicalIndex.set(r.canonical_id, []);
      canonicalIndex.get(r.canonical_id).push({ entity, id: r.id, name: r.hostname || r.name || r.title || r.model || r.id });
    });
  });
  canonicalIndex.forEach((recs, cid) => {
    if (recs.length > 1) push({ code: "DUPLICATE_CANONICAL_ID", severity: "error", category: "identity", affected_type: recs[0].entity.toLowerCase(), affected_id: recs[0].id, affected_canonical_id: cid, affected_name: recs[0].name, title: "Duplicate canonical ID", explanation: `Canonical ID "${cid}" is claimed by ${recs.length} records.`, evidence: recs.map((r) => `${r.entity}:${r.name}`), recommendation: "Resolve the duplicate — canonical IDs must be unique." });
  });

  // ---------- CAPACITY (real infrastructure only — sample data excluded) ----------
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const envById = Object.fromEntries(envs.map((e) => [e.id, e]));
  realNodes.forEach((n) => {
    const over = nodeOversubscription(n, realWorkloads, realEnvs, pools);
    const alloc = nodeAllocations(n, realWorkloads, realEnvs);
    if (over.cpu) push({ code: "NODE_CPU_OVERSUBSCRIBED", severity: "error", category: "capacity", affected_type: "node", affected_id: n.id, affected_canonical_id: n.canonical_id, affected_name: n.hostname, title: "Node CPU oversubscribed", explanation: `Allocated CPU on "${n.hostname}" exceeds capacity by ${over.cpu}.`, evidence: [`allocated ${alloc.cpu} > capacity ${n.logical_cpus ?? n.physical_cores}`], recommendation: "Reduce environment allocations or move workloads off this node." });
    if (over.ram) push({ code: "NODE_RAM_OVERSUBSCRIBED", severity: "error", category: "capacity", affected_type: "node", affected_id: n.id, affected_canonical_id: n.canonical_id, affected_name: n.hostname, title: "Node RAM oversubscribed", explanation: `Allocated RAM on "${n.hostname}" exceeds capacity by ${fmtGB(over.ram)}.`, evidence: [`allocated ${alloc.ram}GB > capacity ${n.ram_capacity_gb}GB`], recommendation: "Reduce environment allocations or move workloads off this node." });
    if (over.storage) push({ code: "NODE_STORAGE_OVERSUBSCRIBED", severity: "error", category: "capacity", affected_type: "node", affected_id: n.id, affected_canonical_id: n.canonical_id, affected_name: n.hostname, title: "Node storage oversubscribed", explanation: `Allocated storage on "${n.hostname}" exceeds usable pool capacity by ${fmtGB(over.storage)}.`, evidence: [`allocated ${alloc.storage}GB > usable ${nodeStorageUsable(n, pools).usable}GB`], recommendation: "Add pool capacity or relocate storage-heavy workloads." });
  });
  realEnvs.forEach((e) => {
    const over = environmentOversubscription(e, realWorkloads);
    const usage = environmentUsage(e, realWorkloads);
    if (over.cpu) push({ code: "ENV_CPU_OVERSUBSCRIBED", severity: "error", category: "capacity", affected_type: "environment", affected_id: e.id, affected_canonical_id: e.canonical_id, affected_name: e.name, title: "Environment CPU oversubscribed", explanation: `Workloads in "${e.name}" require more CPU than allocated.`, evidence: [`usage ${usage.cpu} > allocation ${e.cpu_allocation}`], recommendation: "Increase environment CPU allocation or move workloads out." });
    if (over.ram) push({ code: "ENV_RAM_OVERSUBSCRIBED", severity: "error", category: "capacity", affected_type: "environment", affected_id: e.id, affected_canonical_id: e.canonical_id, affected_name: e.name, title: "Environment RAM oversubscribed", explanation: `Workloads in "${e.name}" require more RAM than allocated.`, evidence: [`usage ${usage.ram}GB > allocation ${e.ram_allocation_gb}GB`], recommendation: "Increase environment RAM allocation or move workloads out." });
    if (over.storage) push({ code: "ENV_STORAGE_OVERSUBSCRIBED", severity: "warning", category: "capacity", affected_type: "environment", affected_id: e.id, affected_canonical_id: e.canonical_id, affected_name: e.name, title: "Environment storage oversubscribed", explanation: `Workloads in "${e.name}" require more storage than allocated.`, evidence: [`usage ${usage.storage}GB > allocation ${e.storage_allocation_gb}GB`], recommendation: "Increase environment storage allocation or move workloads out." });
  });
  realWorkloads.forEach((w) => {
    const env = w.current_environment ? envById[w.current_environment] : null;
    const host = (env && env.current_host) ? nodeById[env.current_host] : (w.current_host ? nodeById[w.current_host] : null);
    if (w.lifecycle === "active" && !env && !w.current_host) push({ code: "WORKLOAD_PLACEMENT_UNRESOLVED", severity: "warning", category: "capacity", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Workload placement unresolved", explanation: `Active workload "${w.name}" has no execution environment and no host.`, evidence: ["no current_environment", "no current_host"], recommendation: "Assign an execution environment or host." });
    if (env && !env.current_host && w.lifecycle === "active") push({ code: "WORKLOAD_PLACEMENT_UNRESOLVED", severity: "warning", category: "capacity", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Workload environment unplaced", explanation: `"${w.name}" runs in environment "${env.name}" which has no host node.`, evidence: [`environment ${env.name} has no current_host`], recommendation: "Assign a host to the environment." });
    if (!host) return;
    if (w.gpu_vram_requirement_gb) {
      const gpuPresent = (host.gpus && host.gpus.length > 0) || (host.gpu_vram_gb != null && host.gpu_vram_gb > 0);
      if (!gpuPresent && host.gpus != null) push({ code: "MISSING_REQUIRED_GPU", severity: "error", category: "capacity", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Required GPU missing", explanation: `"${w.name}" requires GPU VRAM but host "${host.hostname}" has no documented GPU.`, evidence: [`gpu_vram_requirement ${w.gpu_vram_requirement_gb}GB; node has no GPU`], recommendation: "Move to a GPU-equipped node." });
      else if (gpuPresent && host.gpu_vram_gb != null && w.gpu_vram_requirement_gb > host.gpu_vram_gb) push({ code: "GPU_VRAM_INSUFFICIENT", severity: "error", category: "capacity", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "GPU VRAM insufficient", explanation: `"${w.name}" requires ${w.gpu_vram_requirement_gb}GB VRAM but host GPU has ${host.gpu_vram_gb}GB.`, evidence: [`requirement ${w.gpu_vram_requirement_gb}GB > ${host.gpu_vram_gb}GB`], recommendation: "Move to a node with a larger GPU." });
    }
    if (w.ram_requirement_gb && !env && host.ram_capacity_gb == null) push({ code: "UNKNOWN_REQUIRED_CAPACITY", severity: "warning", category: "capacity", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Required capacity unknown", explanation: `"${w.name}" requires RAM but host "${host.hostname}" RAM capacity is undocumented.`, evidence: [`ram_requirement ${w.ram_requirement_gb}GB; node ram_capacity_gb unknown`], recommendation: "Document node RAM capacity.", data_sufficient: false, confidence: "low" });
    if (env && w.ram_requirement_gb && env.ram_allocation_gb == null) push({ code: "UNKNOWN_REQUIRED_CAPACITY", severity: "warning", category: "capacity", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Required capacity unknown", explanation: `"${w.name}" requires RAM but environment "${env.name}" RAM allocation is undocumented.`, evidence: [`ram_requirement ${w.ram_requirement_gb}GB; env ram_allocation unknown`], recommendation: "Document environment RAM allocation.", data_sufficient: false, confidence: "low" });
  });

  // ---------- DEPENDENCY ----------
  const cycles = detectCycles(deps);
  cycles.forEach((c) => {
    const names = c.map((id) => wlName(id) || id);
    push({ code: "DEP_CYCLE", severity: "error", category: "dependency", affected_type: "workload", affected_id: c[0], affected_canonical_id: wlCid(c[0]), affected_name: names[0], title: "Dependency cycle", explanation: `Circular dependency detected: ${names.join(" → ")}.`, evidence: [`cycle: ${names.join(" → ")}`], recommendation: "Break the cycle by removing or weakening one dependency." });
  });
  const wlById = Object.fromEntries(workloads.map((w) => [w.id, w]));
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  deps.forEach((d) => {
    if (d.source_type !== "workload" || d.target_type !== "workload") return;
    if (d.kind === "optional") return;
    const src = wlById[d.source_id], tgt = wlById[d.target_id];
    if (!src || !tgt) return;
    if ((rank[tgt.criticality] || 0) < (rank[src.criticality] || 0)) push({ code: "CRITICALITY_INVERSION", severity: "warning", category: "dependency", affected_type: "workload", affected_id: src.id, affected_canonical_id: src.canonical_id, affected_name: src.name, title: "Criticality inversion", explanation: `High-criticality "${src.name}" depends on lower-criticality "${tgt.name}".`, evidence: [`source ${src.criticality} → target ${tgt.criticality}`], recommendation: "Raise the target's criticality or weaken the dependency to optional." });
  });

  // ---------- LIFECYCLE: dependency on retired/retiring/degraded ----------
  const retiredStates = ["retiring", "retired"];
  const degradedStates = ["degraded", "maintenance"];
  deps.forEach((d) => {
    const tgt = d.target_type === "workload" ? wlById[d.target_id] : null;
    if (tgt && retiredStates.includes(tgt.lifecycle)) push({ code: "DEP_ON_RETIRED", severity: "error", category: "lifecycle", affected_type: "workload", affected_id: d.source_id, affected_canonical_id: wlCid(d.source_id), affected_name: wlName(d.source_id), title: "Dependency on retired workload", explanation: `"${wlName(d.source_id)}" depends on "${tgt.name}" which is ${tgt.lifecycle}.`, evidence: [`target lifecycle=${tgt.lifecycle}`], recommendation: "Migrate the dependency to an active replacement." });
    else if (tgt && degradedStates.includes(tgt.lifecycle)) push({ code: "DEP_ON_DEGRADED", severity: "warning", category: "lifecycle", affected_type: "workload", affected_id: d.source_id, affected_canonical_id: wlCid(d.source_id), affected_name: wlName(d.source_id), title: "Dependency on degraded workload", explanation: `"${wlName(d.source_id)}" depends on "${tgt.name}" which is ${tgt.lifecycle}.`, evidence: [`target lifecycle=${tgt.lifecycle}`], recommendation: "Confirm the degraded target can still serve the dependency." });
  });
  envs.forEach((e) => {
    if ([...retiredStates, ...degradedStates].includes(e.lifecycle)) {
      workloads.filter((w) => w.current_environment === e.id && !retiredStates.includes(w.lifecycle)).forEach((w) => push({ code: "ACTIVE_IN_RETIRED_ENV", severity: "error", category: "lifecycle", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Active workload in retired/degraded environment", explanation: `"${w.name}" runs in environment "${e.name}" which is ${e.lifecycle}.`, evidence: [`environment lifecycle=${e.lifecycle}; workload lifecycle=${w.lifecycle}`], recommendation: "Migrate the workload to an active environment." }));
    }
  });

  // ---------- AVAILABILITY / SPOF (real infrastructure only — sample data excluded) ----------
  realNodes.forEach((n) => {
    const critical = realWorkloads.filter((w) => {
      const env = w.current_environment ? envById[w.current_environment] : null;
      const onNode = (env && env.current_host === n.id) || (!env && w.current_host === n.id);
      return onNode && (w.criticality === "high" || w.criticality === "critical");
    });
    if (critical.length >= 4) push({ code: "SPOF_CONCENTRATION", severity: "warning", category: "availability", affected_type: "node", affected_id: n.id, affected_canonical_id: n.canonical_id, affected_name: n.hostname, title: "Single point of failure: concentration", explanation: `"${n.hostname}" hosts ${critical.length} high/critical workloads.`, evidence: critical.map((w) => w.name), recommendation: "Distribute critical workloads across nodes or document intentional colocation." });
  });
  const weakTarget = (kind, rec) => {
    if (!rec) return false;
    if (kind === "Workload") return rec.availability_requirement === "best_effort" || [...retiredStates, ...degradedStates].includes(rec.lifecycle);
    if (kind === "ExecutionEnvironment") return [...retiredStates, ...degradedStates].includes(rec.lifecycle);
    if (kind === "Node") return rec.availability_expectation === "best_effort" || [...retiredStates, ...degradedStates].includes(rec.lifecycle_state);
    return false;
  };
  const targetRec = (d) => {
    const kind = DEP_TYPE_MAP[d.target_type];
    if (!kind) return null;
    const list = { Workload: workloads, ExecutionEnvironment: envs, Node: nodes, NetworkDevice: netdevs, StorageDevice: storage }[kind];
    return { kind, rec: (list || []).find((r) => r.id === d.target_id) };
  };
  realWorkloads.forEach((w) => {
    if (w.criticality !== "high" && w.criticality !== "critical") return;
    const hardDeps = deps.filter((d) => d.source_type === "workload" && d.source_id === w.id && d.kind !== "optional");
    hardDeps.forEach((d) => {
      const t = targetRec(d);
      if (t && weakTarget(t.kind, t.rec)) push({ code: "SPOF_CRITICAL_DEP_WEAK", severity: "warning", category: "availability", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Single point of failure: weak mandatory dependency", explanation: `High-criticality "${w.name}" has a mandatory dependency on ${t.kind} "${t.rec.name || t.rec.hostname}" which is best-effort/degraded/retiring.`, evidence: [`dependency ${d.kind} → ${t.kind} "${t.rec.name || t.rec.hostname}"`], recommendation: "Add redundancy or strengthen the dependency target." });
    });
  });
  realWorkloads.forEach((w) => {
    const env = w.current_environment ? envById[w.current_environment] : null;
    const host = (env && env.current_host) ? nodeById[env.current_host] : (w.current_host ? nodeById[w.current_host] : null);
    if (w.availability_requirement === "always_on" && host && host.availability_expectation && host.availability_expectation !== "always_on")
      push({ code: "ALWAYS_ON_NON_ALWAYS_ON", severity: "error", category: "availability", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Always-on workload on non-always-on host", explanation: `"${w.name}" requires always-on availability but is realized on "${host.hostname}" (${host.availability_expectation}).`, evidence: [`workload always_on; host ${host.availability_expectation}`], recommendation: "Move to an always-on node or relax the availability requirement." });
  });

  // ---------- STATE ----------
  workloads.forEach((w) => {
    const env = w.current_environment ? envById[w.current_environment] : null;
    if (w.reconstructable && env && env.persistent_state && !w.backup_requirement) push({ code: "RECONSTRUCTABLE_NO_BACKUP", severity: "error", category: "state", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Persistent state without backup policy", explanation: `"${w.name}" is reconstructable and runs with persistent state, but no backup requirement is documented.`, evidence: ["reconstructable=true", "env persistent_state=true", "backup_requirement empty"], recommendation: "Document a backup requirement or mark the workload non-reconstructable." });
    if (w.reconstructable && env && env.persistent_state) push({ code: "RECONSTRUCTABLE_PERSISTENT", severity: "warning", category: "state", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Reconstructable workload with unclassified persistent state", explanation: `"${w.name}" is marked reconstructable but its environment "${env.name}" carries persistent state.`, evidence: ["reconstructable=true", "env persistent_state=true"], recommendation: "Confirm reconstructability accounts for state recovery, or mark non-reconstructable." });
    if (w.lifecycle === "active" && !w.current_host && !env) push({ code: "ACTIVE_NO_REALIZATION", severity: "warning", category: "state", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Active workload without realization", explanation: `"${w.name}" is active but has no current host node.`, evidence: ["lifecycle=active", "current_host empty"], recommendation: "Assign a host or set lifecycle to planned." });
    if (w.lifecycle === "retired" && w.current_host) push({ code: "RETIRED_STILL_REALIZED", severity: "info", category: "state", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Retired workload still realized", explanation: `"${w.name}" is retired but still has a current host.`, evidence: ["lifecycle=retired", "current_host set"], recommendation: "Clear the host or remove the workload." });
  });

  // ---------- PROVENANCE ----------
  workloads.forEach((w) => {
    const sc = w.state_classification;
    if ((w.criticality === "high" || w.criticality === "critical") && (sc === "sample" || sc === "inferred")) push({ code: "CRITICAL_UNKNOWN_PROVENANCE", severity: "warning", category: "provenance", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Important data with unknown provenance", explanation: `"${w.name}" is ${w.criticality}-critical but its state is ${sc}, not declared/observed.`, evidence: [`criticality=${w.criticality}`, `state_classification=${sc}`], recommendation: "Validate against an authoritative source and re-classify as declared or observed." });
    if (sc === "planned" && w.lifecycle === "active") push({ code: "PLANNED_AS_CURRENT", severity: "warning", category: "provenance", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Planned state used as current", explanation: `"${w.name}" is active but its state is classified as planned.`, evidence: ["lifecycle=active", "state_classification=planned"], recommendation: "Re-classify as declared/observed once realized, or set lifecycle to planned." });
    if (sc === "observed" && !w.observed_at) push({ code: "NO_OBSERVATION", severity: "info", category: "provenance", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "No observation recorded", explanation: `"${w.name}" is classified observed but has no observed_at timestamp.`, evidence: ["state_classification=observed", "observed_at empty"], recommendation: "Record an observation timestamp or re-classify." });
    if (sc === "observed" && w.observed_at) {
      // Shared category-aware staleness policy (provenance.js). Workloads are "service".
      const cat = observationCategory("workload");
      if (staleStatus(w.observed_at, cat) === "STALE") {
        const cfg = STALE_CONFIG[cat];
        const ageDays = Math.round((Date.now() - new Date(w.observed_at).getTime()) / 86400000);
        push({ code: "STALE_OBSERVATION", severity: "warning", category: "provenance", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Stale observation", explanation: `"${w.name}" was last observed ${ageDays} days ago (stale beyond ${cfg.agingDays}d for ${cfg.label}).`, evidence: [`observed_at=${w.observed_at}`, `age=${ageDays}d`, `threshold=${cfg.agingDays}d`], recommendation: "Re-observe or re-classify as declared." });
      }
    }
    if (sc === "sample") push({ code: "SAMPLE_DATA", severity: "info", category: "provenance", affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name, title: "Sample data present", explanation: `"${w.name}" is marked as sample data, not real infrastructure.`, evidence: ["state_classification=sample"], recommendation: "Replace with real data before relying on this record." });
  });

  // ---------- DATA QUALITY: canonical sync ----------
  const lookups = buildLookups(data);
  CANONICAL_ENTITIES.forEach((entity) => {
    (data[entity] || []).forEach((r) => {
      if (r.source_kind === "canonical" && !r.canonical_id) push({ code: "CANONICAL_MISSING_ID", severity: "warning", category: "data_quality", affected_type: entity.toLowerCase(), affected_id: r.id, affected_name: r.hostname || r.name || r.title || r.model || r.id, title: "Canonical object missing canonical ID", explanation: `A ${entity} marked source_kind=canonical has no canonical_id.`, evidence: [`source_kind=canonical`, "canonical_id empty"], recommendation: "Assign a canonical_id or set source_kind to manual." });
      if (r.source_kind === "canonical" && r.canonical_id) {
        refFieldNames(entity).forEach((field) => {
          const val = r[field];
          if (val == null || val === "") return;
          const targetKind = field === "source_id" ? DEP_TYPE_MAP[r.source_type] : field === "target_id" ? DEP_TYPE_MAP[r.target_type] : (REF_TARGET[field] || null);
          const values = Array.isArray(val) ? val : [val];
          values.forEach((v) => { if (!v) return; if (targetKind && !resolveRef(targetKind, v, lookups)) push({ code: "CANONICAL_UNRESOLVED_REF", severity: "warning", category: "data_quality", affected_type: entity.toLowerCase(), affected_id: r.id, affected_canonical_id: r.canonical_id, affected_name: r.hostname || r.name || r.title || r.model || r.id, title: "Canonical object with unresolved reference", explanation: `Canonical ${entity} "${r.canonical_id}" references an unknown ${targetKind} via ${field}.`, evidence: [`${field}=${v}`], recommendation: "Import the referenced object or correct the reference." }); });
        });
      }
    });
  });

  // ---------- CHANGE RISK ----------
  changes.forEach((c) => {
    if (["accepted", "ready", "executing"].includes(c.status) && !c.rollback_strategy) push({ code: "CHANGE_NO_ROLLBACK", severity: "warning", category: "change_risk", affected_type: "planned_change", affected_id: c.id, affected_canonical_id: c.canonical_id, affected_name: c.title, title: "In-flight change without rollback plan", explanation: `Change "${c.title}" is ${c.status} but has no rollback strategy.`, evidence: [`status=${c.status}`, "rollback_strategy empty"], recommendation: "Document a rollback strategy before execution." });
    if (c.risk === "high" && ["ready", "executing"].includes(c.status) && !c.prerequisites) push({ code: "HIGH_RISK_NO_PREREQ", severity: "warning", category: "change_risk", affected_type: "planned_change", affected_id: c.id, affected_canonical_id: c.canonical_id, affected_name: c.title, title: "High-risk change without prerequisites", explanation: `High-risk change "${c.title}" is ${c.status} but has no documented prerequisites.`, evidence: [`risk=high`, `status=${c.status}`, "prerequisites empty"], recommendation: "Document and verify prerequisites before execution." });
  });

  // ---------- SOURCE-AWARE FINDINGS (§16) ----------
  CANONICAL_ENTITIES.forEach((entity) => {
    (data[entity] || []).forEach((r) => {
      const fp = readFieldProvenance(r);
      const overrideFields = Object.keys(fp).filter((f) => fp[f].local != null);
      if (overrideFields.length && r.source_kind === "canonical") overrideFields.forEach((f) => push({
        code: "LOCAL_OVERRIDE_ON_CANONICAL", severity: "warning", category: "provenance",
        affected_type: entity.toLowerCase(), affected_id: r.id, affected_canonical_id: r.canonical_id,
        affected_name: r.hostname || r.name || r.title || r.model || r.id,
        title: "Local override on canonical object",
        explanation: `Canonical ${entity} "${r.canonical_id}" has an Atlas-local override on field "${f}" that may conflict with the next import.`,
        evidence: [`field=${f}`, `local=${fp[f].local}`, `canonical=${r[f]}`],
        recommendation: "Review the override before importing, or promote it to canonical.",
      }));
      if (r.source_kind === "canonical" && r.imported_at) {
        // Shared category-aware staleness policy (provenance.js), "default" category.
        if (staleStatus(r.imported_at, "default") === "STALE") {
          const cfg = STALE_CONFIG.default;
          const ageDays = Math.round((Date.now() - new Date(r.imported_at).getTime()) / 86400000);
          push({
            code: "CANONICAL_SOURCE_STALE", severity: "info", category: "provenance",
            affected_type: entity.toLowerCase(), affected_id: r.id, affected_canonical_id: r.canonical_id,
            affected_name: r.hostname || r.name || r.title || r.model || r.id,
            title: "Canonical source is stale",
            explanation: `Canonical ${entity} "${r.canonical_id}" was imported ${ageDays} days ago — the source snapshot may have moved on (stale beyond ${cfg.agingDays}d).`,
            evidence: [`imported_at=${r.imported_at}`, `age=${ageDays}d`, `threshold=${cfg.agingDays}d`],
            recommendation: "Re-import to refresh canonical state.",
          });
        }
      }
    });
  });
  workloads.forEach((w) => {
    if (w.state_classification === "sample" && !["retired", "planned"].includes(w.lifecycle)) push({
      code: "SAMPLE_DATA_IN_ACTIVE_ARCHITECTURE", severity: "warning", category: "provenance",
      affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name,
      title: "Sample data in active architecture",
      explanation: `"${w.name}" is marked as sample data but has lifecycle ${w.lifecycle} — sample data should not be treated as real infrastructure.`,
      evidence: [`state_classification=sample`, `lifecycle=${w.lifecycle}`],
      recommendation: "Replace with real data or set lifecycle to retired/planned.",
    });
    if (w.state_classification === "inferred" && (w.confidence == null || w.confidence < 0.5) && (w.criticality === "high" || w.criticality === "critical")) push({
      code: "INFERRED_LOW_CONFIDENCE", severity: "warning", category: "provenance",
      affected_type: "workload", affected_id: w.id, affected_canonical_id: w.canonical_id, affected_name: w.name,
      title: "Low-confidence inferred data on important workload",
      explanation: `"${w.name}" is ${w.criticality}-critical, state is inferred, and confidence is ${w.confidence == null ? "unset" : w.confidence}.`,
      evidence: [`state_classification=inferred`, `confidence=${w.confidence ?? "unset"}`, `criticality=${w.criticality}`],
      recommendation: "Validate and re-classify, or raise confidence.",
    });
  });

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code));
  return findings;
}

// Map relationship fields to their target entity kind (for canonical unresolved-ref checks).
const REF_TARGET = {
  current_host: "Node", current_environment: "ExecutionEnvironment", preferred_node: "Node",
  eligible_alternative_nodes: "Node", supersedes: "Decision", superseded_by: "Decision",
  related_nodes: "Node", related_workloads: "Workload", node: "Node", current_node: "Node",
  device: "NetworkDevice",
};

export function findingsBySeverity(findings) {
  const m = { critical: [], error: [], warning: [], info: [] };
  findings.forEach((f) => (m[f.severity] || (m[f.severity] = [])).push(f));
  return m;
}