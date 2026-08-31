import { base44 } from "@/api/base44Client";
import { isSample, isFixture } from "@/lib/provenance";

// ---------- Entity names ----------
export const ENTITY_NAMES = {
  node: "Node",
  environment: "ExecutionEnvironment",
  workload: "Workload",
  dependency: "Dependency",
  networkDevice: "NetworkDevice",
  switchPort: "SwitchPort",
  storageDevice: "StorageDevice",
  storagePool: "StoragePool",
  plannedChange: "PlannedChange",
  decision: "Decision",
  maintenance: "Maintenance",
  task: "Task",
};

// ---------- Lifecycle / status colors ----------
export const LIFECYCLE_STATES = ["planned", "onboarding", "active", "experimental", "maintenance", "degraded", "retiring", "retired"];

export function lifecycleTone(state) {
  switch (state) {
    case "active": return "emerald";
    case "onboarding": return "sky";
    case "planned": return "violet";
    case "experimental": return "amber";
    case "maintenance": return "amber";
    case "degraded": return "orange";
    case "retiring": return "rose";
    case "retired": return "zinc";
    default: return "zinc";
  }
}

export function criticalityTone(c) {
  switch (c) {
    case "critical": return "rose";
    case "high": return "orange";
    case "medium": return "amber";
    case "low": return "emerald";
    default: return "zinc";
  }
}

export function riskTone(r) {
  switch (r) {
    case "high": return "rose";
    case "medium": return "amber";
    case "low": return "emerald";
    default: return "zinc";
  }
}

export function stateClassTone(s) {
  switch (s) {
    case "observed": return "sky";
    case "imported": return "violet";
    case "inferred": return "amber";
    case "planned": return "fuchsia";
    case "documented": return "zinc";
    case "sample": return "zinc";
    default: return "zinc";
  }
}

export function provenanceLabel(s) {
  return ({ documented: "Declared", observed: "Observed", imported: "Imported", inferred: "Inferred", planned: "Planned", sample: "Sample" })[s] || s || "";
}

export function outcomeTone(o) {
  switch (o) {
    case "success": return "emerald";
    case "partial": return "amber";
    case "failed": return "rose";
    case "aborted": return "zinc";
    case "pending": return "sky";
    default: return "zinc";
  }
}

// Tailwind-safe badge classes (literal so purge keeps them)
const TONES = {
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30",
  sky: "bg-sky-500/15 text-sky-600 dark:text-sky-400 ring-sky-500/30",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-violet-500/30",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30",
  orange: "bg-orange-500/15 text-orange-600 dark:text-orange-400 ring-orange-500/30",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-rose-500/30",
  zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 ring-zinc-500/30",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 ring-fuchsia-500/30",
};

export function badgeClass(tone) {
  return `inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONES[tone] || TONES.zinc}`;
}

// StatusBadge (JSX) lives in @/components/StatusBadge to keep this file JS-only.
export { default as StatusBadge } from "@/components/StatusBadge";

// ---------- Formatting ----------
export function fmtGB(gb) {
  if (gb == null || isNaN(gb)) return "—";
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${Math.round(gb)} GB`;
}

// ---------- Reference resolution (relational model) ----------
// Resolve a canonical record's display name by id, live.
export function refName(list, id, nameKey) {
  if (!id || !list) return "";
  const r = list.find((x) => x.id === id);
  return r ? (r[nameKey] || "") : "";
}

// Resolve a typed reference (Dependency/Maintenance/Task) to a display name.
// `data` is the aggregated entity map from useAllEntities.
export function typedRefName(type, id, data) {
  if (!id || !data) return "";
  const map = {
    node: { list: data.Node, key: "hostname" },
    workload: { list: data.Workload, key: "name" },
    environment: { list: data.ExecutionEnvironment, key: "name" },
    network_device: { list: data.NetworkDevice, key: "name" },
    network_service: { list: data.NetworkDevice, key: "name" },
    storage: { list: data.StorageDevice, key: "model" },
    change: { list: data.PlannedChange, key: "title" },
    decision: { list: data.Decision, key: "title" },
  };
  const m = map[type];
  return m ? refName(m.list, id, m.key) : "";
}

export function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return d; }
}

export function fmtDateTime(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return d; }
}

export function timeAgo(d) {
  if (!d) return "";
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d2 = Math.floor(h / 24);
  if (d2 < 30) return `${d2}d ago`;
  return fmtDate(d);
}

// ---------- Completeness-aware aggregates ----------
// Sum a numeric field across records, counting records where the field is absent/NaN as "unknown".
// Use for capacity summary cards so undocumented capacity is surfaced, not silently dropped.
export function aggregateKnown(records, field) {
  let sum = 0, unknownCount = 0;
  (records || []).forEach((r) => {
    const v = r ? r[field] : null;
    if (v == null || (typeof v === "number" && isNaN(v))) unknownCount++;
    else sum += Number(v) || 0;
  });
  return { sum, unknownCount, knownCount: (records || []).length - unknownCount };
}

// ---------- Export ----------
export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function exportJSON(records, name) {
  downloadFile(`${name}.json`, JSON.stringify(records, null, 2), "application/json");
}

export function exportCSV(records, columns, name) {
  const headers = columns.map((c) => c.label);
  const rows = records.map((r) => columns.map((c) => {
    const v = c.get ? c.get(r) : r[c.key];
    if (Array.isArray(v)) return v.join("; ");
    if (v == null) return "";
    return String(v).replace(/"/g, '""');
  }));
  const csv = [headers, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  downloadFile(`${name}.csv`, csv, "text/csv");
}

// ---------- Dependency analysis ----------
// Build adjacency from dependencies where source/target are workloads
export function detectCycles(deps) {
  const adj = {};
  deps.forEach((d) => {
    if (!d) return;
    if (d.source_type === "workload" && d.target_type === "workload") {
      (adj[d.source_id] = adj[d.source_id] || []).push(d.target_id);
    }
  });
  const cycles = [];
  const visited = {}, stack = {}, path = [];
  function dfs(n) {
    visited[n] = true; stack[n] = true; path.push(n);
    (adj[n] || []).forEach((m) => {
      if (!visited[m]) dfs(m);
      else if (stack[m]) {
        const idx = path.indexOf(m);
        cycles.push(path.slice(idx).concat(m));
      }
    });
    stack[n] = false; path.pop();
  }
  Object.keys(adj).forEach((n) => { if (!visited[n]) dfs(n); });
  return cycles;
}

// Flag: low-criticality service depended on by high-criticality service
export function criticalityMismatches(deps, workloads) {
  const wlById = {};
  workloads.forEach((w) => { wlById[w.id] = w; });
  const out = [];
  deps.forEach((d) => {
    if (d.source_type !== "workload" || d.target_type !== "workload") return;
    const src = wlById[d.source_id], tgt = wlById[d.target_id];
    if (!src || !tgt) return;
    const rank = { low: 0, medium: 1, high: 2, critical: 3 };
    if ((rank[tgt.criticality] || 0) < (rank[src.criticality] || 0)) {
      out.push({ source: src, target: tgt });
    }
  });
  return out;
}

// Flag: reconstructable workload containing persistent state
export function reconstructabilityIssues(workloads, environments) {
  const envById = {};
  environments.forEach((e) => { envById[e.id] = e; });
  const out = [];
  workloads.forEach((w) => {
    if (!w.reconstructable) return;
    const env = w.current_environment ? envById[w.current_environment] : null;
    if (env && env.persistent_state) out.push({ workload: w, environment: env });
  });
  return out;
}

// Flag: aggregate resource oversubscription at node and environment layers (not per-workload).
export function resourceShortages(workloads, nodes, environments, pools) {
  const out = [];
  nodes.forEach((n) => {
    const over = nodeOversubscription(n, workloads, environments, pools);
    Object.entries(over).forEach(([field, amount]) => out.push({ node: n, field, amount }));
  });
  (environments || []).forEach((e) => {
    const over = environmentOversubscription(e, workloads);
    Object.entries(over).forEach(([field, amount]) => out.push({ environment: e, field, amount }));
  });
  return out;
}

// ---------- Resource accounting layers ----------
// Layer 1 PHYSICAL NODE CAPACITY · Layer 2 ENVIRONMENT ALLOCATION · Layer 3 WORKLOAD REQUIREMENT.
// A workload inside an environment is counted via its environment's reservation, NOT directly against the node.

// Workloads directly hosted on a node WITHOUT a containing environment on that node (legacy/compat).
export function directHostedWorkloads(node, workloads, environments) {
  // A workload is direct-hosted only when it has NO environment relationship.
  // Env-hosted workloads (resolved or with a missing env) are not direct-hosted.
  return (workloads || []).filter((w) => {
    if (w.current_environment) return false;
    return w.current_host === node.id;
  });
}

// Physical node allocation = sum of environment reservations on node + direct-hosted workload requirements.
// Workloads inside an environment are NOT added (their env reservation already accounts for them).
export function nodeAllocations(node, workloads, environments) {
  let cpu = 0, ram = 0, vram = 0, storage = 0;
  const envById = new Map((environments || []).map((e) => [e.id, e]));
  (environments || []).forEach((e) => {
    if (e.current_host !== node.id) return;
    cpu += e.cpu_allocation || 0;
    ram += e.ram_allocation_gb || 0;
    storage += e.storage_allocation_gb || 0;
  });
  (workloads || []).forEach((w) => {
    const env = w.current_environment ? envById.get(w.current_environment) : null;
    if (w.current_environment) {
      // Environment-authoritative: realized on its environment's host, counted via reservation.
      if (!env) return; // referenced env missing -> unresolved, do not attribute to a stale host
      if (env.current_host !== node.id) return; // realized on a different node
      return; // counted via its environment's reservation above
    }
    // Legacy direct-hosted (no environment relationship)
    if (w.current_host !== node.id) return;
    cpu += w.cpu_requirement || 0;
    ram += w.ram_requirement_gb || 0;
    vram += w.gpu_vram_requirement_gb || 0;
    storage += w.storage_requirement_gb || 0;
  });
  return { cpu, ram, vram, storage };
}

// Layer 3: usage of an environment = sum of workload requirements inside it.
export function environmentUsage(env, workloads) {
  let cpu = 0, ram = 0, vram = 0, storage = 0, count = 0;
  (workloads || []).forEach((w) => {
    if (w.current_environment !== env.id) return;
    count++;
    cpu += w.cpu_requirement || 0;
    ram += w.ram_requirement_gb || 0;
    vram += w.gpu_vram_requirement_gb || 0;
    storage += w.storage_requirement_gb || 0;
  });
  return { cpu, ram, vram, storage, count };
}

// Environment oversubscription: usage > allocation (where allocation is documented).
export function environmentOversubscription(env, workloads) {
  const usage = environmentUsage(env, workloads);
  const out = {};
  if (env.cpu_allocation != null && usage.cpu > env.cpu_allocation) out.cpu = usage.cpu - env.cpu_allocation;
  if (env.ram_allocation_gb != null && usage.ram > env.ram_allocation_gb) out.ram = usage.ram - env.ram_allocation_gb;
  if (env.storage_allocation_gb != null && usage.storage > env.storage_allocation_gb) out.storage = usage.storage - env.storage_allocation_gb;
  return out;
}

// Node oversubscription: allocation > capacity (where capacity is documented).
export function nodeOversubscription(node, workloads, environments, pools) {
  const alloc = nodeAllocations(node, workloads, environments);
  const out = {};
  const cpuCap = node.logical_cpus != null ? node.logical_cpus : node.physical_cores;
  if (cpuCap != null && alloc.cpu > cpuCap) out.cpu = alloc.cpu - cpuCap;
  if (node.ram_capacity_gb != null && alloc.ram > node.ram_capacity_gb) out.ram = alloc.ram - node.ram_capacity_gb;
  const su = nodeStorageUsable(node, pools);
  if (su.known && alloc.storage > su.usable) out.storage = alloc.storage - su.usable;
  if (node.gpu_vram_gb != null && node.gpu_vram_gb > 0 && alloc.vram > node.gpu_vram_gb) out.vram = alloc.vram - node.gpu_vram_gb;
  return out;
}

// Storage capacity on a node. Raw = sum of device capacities. Usable = sum of pool usable capacities.
// Do NOT double-count a device's raw capacity and the pool built from it as two usable capacities.
export function nodeStorageRaw(node, storageDevices) {
  const raw = (storageDevices || []).filter((d) => d.current_node === node.id && d.health !== "retired")
    .reduce((s, d) => s + (d.capacity_gb || 0), 0);
  return { raw, known: raw > 0 };
}
export function nodeStorageUsable(node, pools) {
  const nodePools = (pools || []).filter((p) => p.node === node.id);
  const usable = nodePools.filter((p) => p.state !== "retired").reduce((s, p) => s + (p.usable_capacity_gb || 0), 0);
  return { usable, known: nodePools.length > 0 && usable > 0 };
}

// ---------- Placement scoring ----------
// Hard constraints first (PASS/FAIL/UNKNOWN/NA), then strict lexicographic priority order.
// Unknown hard constraints yield ELIGIBILITY UNKNOWN — never a confident eligible recommendation.
const PRIO_STATE_RANK = { pass: 0, unknown: 1, warn: 2, bad: 3 };
const ELIG_RANK = { eligible: 0, unknown: 1, ineligible: 2 };

export function scorePlacement(workload, node, opts = {}) {
  const envs = opts.envs || [];
  const workloads = opts.workloads || [];
  const pools = opts.pools || [];
  const others = workloads.filter((w) => w.id !== workload.id && !isSample(w) && !isFixture(w));
  const envById = new Map(envs.map((e) => [e.id, e]));
  const env = workload.current_environment ? envById.get(workload.current_environment) : null;
  const inEnv = !!(env && env.current_host === node.id);

  const nodeAlloc = nodeAllocations(node, others, envs);
  const envUsage = env ? environmentUsage(env, others) : null;

  const hardConstraints = [];
  const hardFails = [];
  const unknowns = [];
  const unverified = [];
  const evidence = [];
  const need = {
    cpu: workload.cpu_requirement || 0,
    ram: workload.ram_requirement_gb || 0,
    vram: workload.gpu_vram_requirement_gb || 0,
    storage: workload.storage_requirement_gb || 0,
  };
  const hc = (key, label, state, detail) => {
    hardConstraints.push({ key, label, state, detail });
    if (state === "fail") { hardFails.push(label); evidence.push(`${label}: ${detail}`); }
    else if (state === "unknown") unknowns.push(`${label}: ${detail}`);
  };

  // RAM
  if (need.ram > 0) {
    if (inEnv) {
      const cap = env.ram_allocation_gb;
      if (cap == null) hc("ram", "RAM", "unknown", "environment RAM allocation not documented");
      else if (need.ram > cap - envUsage.ram) hc("ram", "RAM", "fail", `need ${need.ram}GB > env free ${(cap - envUsage.ram).toFixed(0)}GB of ${cap}GB`);
      else hc("ram", "RAM", "pass", `env free ${(cap - envUsage.ram).toFixed(0)}GB of ${cap}GB after placement`);
    } else {
      const cap = node.ram_capacity_gb;
      if (cap == null) hc("ram", "RAM", "unknown", "node RAM capacity not documented");
      else if (need.ram > cap - nodeAlloc.ram) hc("ram", "RAM", "fail", `need ${need.ram}GB > node free ${(cap - nodeAlloc.ram).toFixed(0)}GB of ${cap}GB`);
      else hc("ram", "RAM", "pass", `node free ${(cap - nodeAlloc.ram).toFixed(0)}GB of ${cap}GB after placement`);
    }
  } else hc("ram", "RAM", "na", "no RAM requirement");

  // CPU
  if (need.cpu > 0) {
    if (inEnv) {
      const cap = env.cpu_allocation;
      if (cap == null) hc("cpu", "CPU", "unknown", "environment CPU allocation not documented");
      else if (need.cpu > cap - envUsage.cpu) hc("cpu", "CPU", "fail", `need ${need.cpu} > env free ${cap - envUsage.cpu} of ${cap}`);
      else hc("cpu", "CPU", "pass", `env free ${cap - envUsage.cpu} of ${cap} after placement`);
    } else {
      const cap = node.logical_cpus != null ? node.logical_cpus : node.physical_cores;
      if (cap == null) hc("cpu", "CPU", "unknown", "node CPU count not documented");
      else if (need.cpu > cap - nodeAlloc.cpu) hc("cpu", "CPU", "fail", `need ${need.cpu} > node free ${cap - nodeAlloc.cpu} of ${cap}`);
      else hc("cpu", "CPU", "pass", `node free ${cap - nodeAlloc.cpu} of ${cap} after placement`);
    }
  } else hc("cpu", "CPU", "na", "no CPU requirement");

  // Storage
  if (need.storage > 0) {
    if (inEnv) {
      const cap = env.storage_allocation_gb;
      if (cap == null) hc("storage", "Storage", "unknown", "environment storage allocation not documented");
      else if (need.storage > cap - envUsage.storage) hc("storage", "Storage", "fail", `need ${need.storage}GB > env free ${(cap - envUsage.storage).toFixed(0)}GB of ${cap}GB`);
      else hc("storage", "Storage", "pass", `env free ${(cap - envUsage.storage).toFixed(0)}GB of ${cap}GB after placement`);
    } else {
      const su = nodeStorageUsable(node, pools);
      if (!su.known) hc("storage", "Storage", "unknown", "no storage pool usable capacity documented on node");
      else if (need.storage > su.usable - nodeAlloc.storage) hc("storage", "Storage", "fail", `need ${need.storage}GB > node free ${(su.usable - nodeAlloc.storage).toFixed(0)}GB of ${su.usable}GB usable`);
      else hc("storage", "Storage", "pass", `node free ${(su.usable - nodeAlloc.storage).toFixed(0)}GB of ${su.usable}GB usable after placement`);
    }
  } else hc("storage", "Storage", "na", "no storage requirement");

  // GPU VRAM (node-level; environments do not reserve GPU)
  if (need.vram > 0) {
    const gpuPresent = (node.gpus && node.gpus.length > 0) || (node.gpu_vram_gb != null && node.gpu_vram_gb > 0);
    if (!gpuPresent) {
      if (node.gpus == null && node.gpu_vram_gb == null) hc("gpu", "GPU VRAM", "unknown", "node GPU state unknown");
      else hc("gpu", "GPU VRAM", "fail", "workload requires GPU VRAM but node has no documented GPU");
    } else {
      const cap = node.gpu_vram_gb;
      if (cap == null) hc("gpu", "GPU VRAM", "unknown", "node GPU VRAM capacity not documented");
      else if (need.vram > cap - nodeAlloc.vram) hc("gpu", "GPU VRAM", "fail", `need ${need.vram}GB > node free ${(cap - nodeAlloc.vram).toFixed(0)}GB of ${cap}GB`);
      else hc("gpu", "GPU VRAM", "pass", `node free ${(cap - nodeAlloc.vram).toFixed(0)}GB of ${cap}GB after placement`);
    }
  } else hc("gpu", "GPU VRAM", "na", "no GPU VRAM requirement");

  // Availability (hard)
  if (workload.availability_requirement === "always_on") {
    if (node.availability_expectation == null) hc("availability", "Availability", "unknown", "node availability expectation not documented");
    else if (node.availability_expectation !== "always_on") hc("availability", "Availability", "fail", "always-on workload on non-always-on node");
    else hc("availability", "Availability", "pass", "node is always-on");
  } else hc("availability", "Availability", "na", "no always-on requirement");

  // Explicit eligible/preferred allowlist (hard when an eligible list is populated)
  const eligible = workload.eligible_alternative_nodes || [];
  if (eligible.length > 0) {
    if (eligible.includes(node.id) || workload.preferred_node === node.id) hc("placement", "Placement rules", "pass", "node is in declared eligible/preferred set");
    else hc("placement", "Placement rules", "fail", "node not in declared eligible/preferred list");
  } else hc("placement", "Placement rules", "na", "no explicit eligible list");

  // Free-text / structured-but-unmodeled requirements are NOT verified
  if (workload.gpu_requirement && need.vram === 0) unverified.push("gpu_requirement is free text — not deterministically verified");
  if (workload.network_requirement) unverified.push("network_requirement is free text — not deterministically verified");
  if (workload.minimum_network_mbps != null) unknowns.push("minimum_network_mbps set but node network capacity not modeled");
  if (workload.required_capabilities && workload.required_capabilities.length) unknowns.push("required_capabilities set but node capabilities not modeled");
  if (workload.required_gpu_class) unknowns.push("required_gpu_class set but node GPU class not modeled");

  const hasFail = hardConstraints.some((c) => c.state === "fail");
  const hasUnknown = hardConstraints.some((c) => c.state === "unknown");
  const eligibility = hasFail ? "ineligible" : hasUnknown ? "unknown" : "eligible";

  if (eligibility === "ineligible") {
    return { eligibility, eligible: false, score: 0, hardFails, hardConstraints, priorities: [], reasons: [`Fails hard constraint: ${hardFails.join(", ")}`], evidence, unknowns, unverified, confidence: "low", rankKey: `${ELIG_RANK.ineligible}|zzz` };
  }

  // ---- Priorities (strict order: simplicity → reliability → power → scalability → performance) ----
  const priorities = [];
  const prio = (key, label, score, state, reason) => priorities.push({ key, label, score, state, reason });

  // 1. Simplicity
  let sScore, sState, sReason;
  if (inEnv) { sScore = 5; sState = "pass"; sReason = "Uses existing execution environment on this node"; }
  else if (workload.preferred_node === node.id) { sScore = 5; sState = "pass"; sReason = "Matches declared preferred node"; }
  else if (eligible.includes(node.id)) { sScore = 4; sState = "pass"; sReason = "Listed as an eligible alternative"; }
  else if (env) { sScore = 3; sState = "warn"; sReason = "Environment exists but is hosted elsewhere — placement here adds coordination"; }
  else { sScore = 3; sState = "warn"; sReason = "Direct-hosted placement (no execution environment)"; }
  if (node.node_type === "workstation" && workload.availability_requirement === "always_on") { sScore = 1; sState = "bad"; sReason = "Always-on workload on a workstation"; }
  prio("simplicity", "Simplicity", sScore, sState, sReason);

  // 2. Reliability
  let rScore = 5, rState = "pass", rReason = "Node lifecycle is healthy/active";
  if (["degraded", "maintenance", "retiring", "retired"].includes(node.lifecycle_state)) { rScore = 1; rState = "bad"; rReason = `Node lifecycle is ${node.lifecycle_state}`; }
  else if (node.lifecycle_state === "experimental") { rScore = 3; rState = "warn"; rReason = "Node is experimental"; }
  if (workload.availability_requirement === "always_on" && node.availability_expectation === "always_on") rReason += " · always-on host";
  if ((workload.criticality === "critical" || workload.criticality === "high") && node.availability_expectation === "best_effort") { rScore = Math.min(rScore, 2); rState = rState === "bad" ? "bad" : "warn"; rReason += " · high-criticality on best-effort node"; }
  prio("reliability", "Reliability", rScore, rState, rReason);

  // 3. Power efficiency — missing data is UNKNOWN, never 0
  let pScore, pState, pReason;
  const idle = node.idle_power_w;
  if (idle == null) { pScore = 0; pState = "unknown"; pReason = "No reliable power data recorded"; }
  else if (idle <= 15) { pScore = 5; pState = "pass"; pReason = `Very low idle power (${idle}W)`; }
  else if (idle <= 40) { pScore = 4; pState = "pass"; pReason = `Low idle power (${idle}W)`; }
  else if (idle <= 80) { pScore = 3; pState = "pass"; pReason = `Moderate idle power (${idle}W)`; }
  else if (idle <= 150) { pScore = 2; pState = "warn"; pReason = `High idle power (${idle}W)`; }
  else { pScore = 1; pState = "warn"; pReason = `Very high idle power (${idle}W)`; }
  prio("power", "Power efficiency", pScore, pState, pReason);

  // 4. Scalability — headroom on the binding resource
  let scScore, scState, scReason;
  const bCap = inEnv ? env.ram_allocation_gb : node.ram_capacity_gb;
  const bUsed = inEnv ? (envUsage ? envUsage.ram : 0) : nodeAlloc.ram;
  if (bCap == null) { scScore = 0; scState = "unknown"; scReason = "Capacity data insufficient to evaluate headroom"; }
  else {
    const remain = 1 - (bUsed + need.ram) / bCap;
    if (remain > 0.5) { scScore = 5; scState = "pass"; scReason = `${Math.round(remain * 100)}% headroom remains after placement`; }
    else if (remain > 0.25) { scScore = 4; scState = "pass"; scReason = `${Math.round(remain * 100)}% headroom remains`; }
    else if (remain > 0.1) { scScore = 3; scState = "warn"; scReason = `${Math.round(remain * 100)}% headroom remains`; }
    else { scScore = 2; scState = "warn"; scReason = `Only ${Math.round(remain * 100)}% headroom remains`; }
  }
  prio("scalability", "Scalability", scScore, scState, scReason);

  // 5. Performance
  let pfScore, pfState, pfReason;
  if (need.vram > 0) {
    const cap = node.gpu_vram_gb;
    if (cap == null) { pfScore = 0; pfState = "unknown"; pfReason = "GPU VRAM capacity unknown"; }
    else if (cap >= need.vram * 2) { pfScore = 5; pfState = "pass"; pfReason = `Large GPU VRAM headroom (${cap}GB vs ${need.vram}GB need)`; }
    else { pfScore = 3; pfState = "warn"; pfReason = `Limited GPU VRAM headroom (${cap}GB vs ${need.vram}GB need)`; }
  } else if (need.cpu > 0) {
    const cap = node.logical_cpus != null ? node.logical_cpus : node.physical_cores;
    if (cap == null) { pfScore = 0; pfState = "unknown"; pfReason = "CPU capacity unknown"; }
    else if (cap >= need.cpu * 4) { pfScore = 5; pfState = "pass"; pfReason = `Large CPU headroom (${cap} vs ${need.cpu} need)`; }
    else if (cap >= need.cpu * 2) { pfScore = 4; pfState = "pass"; pfReason = "Adequate CPU headroom"; }
    else { pfScore = 2; pfState = "warn"; pfReason = "Tight CPU headroom"; }
  } else { pfScore = 3; pfState = "pass"; pfReason = "No demanding resource requirement"; }
  prio("performance", "Performance", pfScore, pfState, pfReason);

  const score = Math.round((priorities.reduce((s, p) => s + p.score, 0) / (priorities.length * 5)) * 100);
  const reasons = priorities.map((p) => `${p.label}: ${p.reason}`);
  const confidence = eligibility === "unknown" ? "low" : (unknowns.length || unverified.length) ? "medium" : "high";
  const rankKey = `${ELIG_RANK[eligibility]}|${priorities.map((p) => `${PRIO_STATE_RANK[p.state]}${5 - p.score}`).join("|")}`;

  return { eligibility, eligible: eligibility === "eligible", score, hardFails, hardConstraints, priorities, reasons, evidence, unknowns, unverified, confidence, rankKey };
}

// ---------- Global search ----------
export async function globalSearch(query) {
  if (!query || query.trim().length < 2) return [];
  const q = query.toLowerCase();
  const targets = [
    { entity: "Node", label: "Node", nameKey: "hostname", route: "/nodes" },
    { entity: "Workload", label: "Workload", nameKey: "name", route: "/workloads" },
    { entity: "ExecutionEnvironment", label: "Environment", nameKey: "name", route: "/environments" },
    { entity: "NetworkDevice", label: "Network device", nameKey: "name", route: "/network" },
    { entity: "StorageDevice", label: "Storage", nameKey: "model", route: "/storage" },
    { entity: "StoragePool", label: "Storage pool", nameKey: "name", route: "/storage-pools" },
    { entity: "PlannedChange", label: "Change", nameKey: "title", route: "/change-planner" },
    { entity: "Decision", label: "Decision", nameKey: "title", route: "/decisions" },
    { entity: "Maintenance", label: "Maintenance", nameFn: (r) => `${r.type} — ${r.description || (r.target_id || "").slice(-6) || "record"}`, route: "/maintenance" },
    { entity: "Task", label: "Task", nameKey: "task", route: "/tasks" },
  ];
  const results = await Promise.all(targets.map(async (t) => {
    try {
      const recs = await base44.entities[t.entity].list("-updated_date", 200);
      return recs
        .filter((r) => {
          const name = (t.nameFn ? t.nameFn(r) : r[t.nameKey] || "").toLowerCase();
          const desc = (r.description || r.notes || r.title || "").toLowerCase();
          return name.includes(q) || desc.includes(q);
        })
        .slice(0, 6)
        .map((r) => ({ entity: t.label, route: t.route, id: r.id, name: t.nameFn ? t.nameFn(r) : r[t.nameKey], sub: r.description || r.hostname || "" }));
    } catch { return []; }
  }));
  return results.flat();
}