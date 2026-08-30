import { base44 } from "@/api/base44Client";

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

// Flag: workload assigned to a node without enough stated resources
export function resourceShortages(workloads, nodes) {
  const nodeById = {};
  nodes.forEach((n) => { nodeById[n.id] = n; });
  const out = [];
  workloads.forEach((w) => {
    const n = w.current_host ? nodeById[w.current_host] : null;
    if (!n) return;
    if (w.ram_requirement_gb && n.ram_capacity_gb && w.ram_requirement_gb > n.ram_capacity_gb)
      out.push({ workload: w, node: n, field: "RAM" });
    if (w.cpu_requirement && n.logical_cpus && w.cpu_requirement > n.logical_cpus)
      out.push({ workload: w, node: n, field: "CPU" });
    if (w.gpu_vram_requirement_gb && n.gpu_vram_gb && w.gpu_vram_requirement_gb > n.gpu_vram_gb)
      out.push({ workload: w, node: n, field: "GPU VRAM" });
  });
  return out;
}

// ---------- Capacity aggregation ----------
export function nodeAllocations(node, workloads, environments) {
  // Sum requirements of workloads whose current_host == node.id
  let cpu = 0, ram = 0, vram = 0, storage = 0;
  workloads.forEach((w) => {
    if (w.current_host !== node.id) return;
    cpu += w.cpu_requirement || 0;
    ram += w.ram_requirement_gb || 0;
    vram += w.gpu_vram_requirement_gb || 0;
    storage += w.storage_requirement_gb || 0;
  });
  environments.forEach((e) => {
    if (e.current_host !== node.id) return;
    cpu += e.cpu_allocation || 0;
    ram += e.ram_allocation_gb || 0;
    storage += e.storage_allocation_gb || 0;
  });
  return { cpu, ram, vram, storage };
}

// ---------- Placement scoring ----------
// priorities order: simplicity, reliability, power_efficiency, scalability, performance
export function scorePlacement(workload, node, opts = {}) {
  const alloc = opts.currentAlloc || { cpu: 0, ram: 0, vram: 0, storage: 0 };
  const reasons = [];
  const evidence = [];
  const unknowns = [];
  const hardFails = [];
  const priorities = [];
  const vrank = { good: 0, warn: 1, bad: 2 };

  // ---- Hard constraints: failure makes a candidate INELIGIBLE (not merely lower-scored) ----
  const ramNeed = workload.ram_requirement_gb || 0;
  const ramCap = node.ram_capacity_gb;
  if (ramNeed > 0) {
    if (ramCap == null) unknowns.push("Node RAM capacity not documented");
    else if (ramNeed > ramCap - alloc.ram) { hardFails.push("RAM"); evidence.push(`RAM need ${ramNeed}GB > free ${(ramCap - alloc.ram).toFixed(0)}GB of ${ramCap}GB`); }
  }
  const cpuNeed = workload.cpu_requirement || 0;
  const cpuCap = node.logical_cpus != null ? node.logical_cpus : node.physical_cores;
  if (cpuNeed > 0) {
    if (cpuCap == null) unknowns.push("Node CPU count not documented");
    else if (cpuNeed > cpuCap - alloc.cpu) { hardFails.push("CPU"); evidence.push(`CPU need ${cpuNeed} > free ${cpuCap - alloc.cpu} of ${cpuCap}`); }
  }
  const vramNeed = workload.gpu_vram_requirement_gb || 0;
  const vramCap = node.gpu_vram_gb;
  if (vramNeed > 0) {
    if (!vramCap || vramCap === 0) { hardFails.push("GPU VRAM"); evidence.push(`Workload requires ${vramNeed}GB GPU VRAM but node has no documented GPU`); }
    else if (vramNeed > vramCap - alloc.vram) { hardFails.push("GPU VRAM"); evidence.push(`GPU VRAM need ${vramNeed}GB > free ${(vramCap - alloc.vram).toFixed(0)}GB of ${vramCap}GB`); }
  }
  if (workload.gpu_requirement && (!node.gpus || node.gpus.length === 0) && !vramNeed)
    unknowns.push("Workload declares a GPU requirement but node GPU list is empty and no VRAM specified");

  if (hardFails.length) {
    return { eligible: false, score: 0, hardFails, reasons: [`Fails hard constraint: ${hardFails.join(", ")}`], evidence, unknowns, priorities: [], rankKey: "9" };
  }

  // ---- Priority evaluation in exact order: simplicity, reliability, power, scalability, performance ----
  // 1. Simplicity
  let simpVerdict = "good", simpDetail = "", simpScore = 80;
  if (workload.preferred_node === node.id) { simpDetail = "Matches declared preferred node — no new coordination surface"; simpScore = 100; }
  else if (workload.eligible_alternative_nodes?.includes(node.id)) { simpDetail = "Listed as an eligible alternative"; simpScore = 85; }
  else { simpVerdict = "warn"; simpDetail = "Not in preferred/eligible list — placement here adds coordination surface"; simpScore = 50; }
  if (node.node_type === "workstation" && workload.availability_requirement === "always_on") { simpVerdict = "bad"; simpDetail = "Always-on workload on a workstation conflicts with the simplicity principle"; simpScore = 20; }
  priorities.push({ key: "simplicity", label: "Simplicity", verdict: simpVerdict, score: simpScore, detail: simpDetail });

  // 2. Reliability
  let relVerdict = "good", relDetail = "", relScore = 80;
  if (["degraded", "maintenance", "retiring", "retired"].includes(node.lifecycle_state)) { relVerdict = "bad"; relDetail = `Node lifecycle is ${node.lifecycle_state}`; relScore = 25; }
  else if (node.lifecycle_state === "experimental") { relVerdict = "warn"; relDetail = "Node is experimental"; relScore = 55; }
  else { relDetail = "Node lifecycle is healthy/active"; relScore = 85; }
  if (workload.availability_requirement === "always_on" && node.availability_expectation !== "always_on") { relVerdict = "bad"; relDetail += " — always-on workload on a non-always-on node"; relScore = Math.min(relScore, 30); }
  else if (node.availability_expectation === "always_on") { relScore = Math.min(100, relScore + 10); }
  if ((workload.criticality === "critical" || workload.criticality === "high") && node.availability_expectation === "best_effort") { if (relVerdict !== "bad") relVerdict = "warn"; relDetail += " — high-criticality workload on best-effort node"; relScore = Math.min(relScore, 45); }
  priorities.push({ key: "reliability", label: "Reliability", verdict: relVerdict, score: relScore, detail: relDetail });

  // 3. Power efficiency
  let powVerdict = "good", powDetail = "", powScore = 70;
  const idle = node.idle_power_w;
  if (idle == null) { powVerdict = "warn"; powDetail = "Idle power not documented"; powScore = 50; }
  else if (idle <= 15) { powDetail = `Very low idle power (${idle}W)`; powScore = 95; }
  else if (idle <= 60) { powDetail = `Moderate idle power (${idle}W)`; powScore = 75; }
  else if (idle >= 200) { powVerdict = "warn"; powDetail = `High idle power (${idle}W)`; powScore = 40; }
  else { powDetail = `Idle power ${idle}W`; powScore = 65; }
  priorities.push({ key: "power", label: "Power efficiency", verdict: powVerdict, score: powScore, detail: powDetail });

  // 4. Scalability — headroom after placement
  let scalVerdict = "good", scalDetail = "", scalScore = 70;
  if (ramCap && ramNeed) {
    const remainPct = 1 - (alloc.ram + ramNeed) / ramCap;
    if (remainPct > 0.5) { scalDetail = `${Math.round(remainPct * 100)}% RAM headroom after placement`; scalScore = 90; }
    else if (remainPct > 0.2) { scalDetail = `${Math.round(remainPct * 100)}% RAM headroom after placement`; scalScore = 70; }
    else { scalVerdict = "warn"; scalDetail = `Only ${Math.round(remainPct * 100)}% RAM headroom after placement`; scalScore = 40; }
  } else { scalVerdict = "warn"; scalDetail = "Insufficient capacity data to evaluate headroom"; scalScore = 50; unknowns.push("Scalability assessed on RAM only; storage headroom not modeled per node"); }
  priorities.push({ key: "scalability", label: "Scalability", verdict: scalVerdict, score: scalScore, detail: scalDetail });

  // 5. Performance
  let perfVerdict = "good", perfDetail = "", perfScore = 70;
  if (vramNeed > 0) {
    if (vramCap && vramCap >= vramNeed * 2) { perfDetail = `Strong GPU VRAM headroom (${vramCap}GB vs ${vramNeed}GB need)`; perfScore = 90; }
    else if (vramCap) { perfVerdict = "warn"; perfDetail = `Limited GPU VRAM headroom (${vramCap}GB vs ${vramNeed}GB need)`; perfScore = 55; }
  } else if (cpuNeed > 0 && cpuCap) {
    if (cpuCap >= cpuNeed * 4) { perfDetail = `Strong CPU headroom (${cpuCap} vs ${cpuNeed} need)`; perfScore = 85; }
    else if (cpuCap >= cpuNeed * 2) { perfDetail = "Adequate CPU headroom"; perfScore = 70; }
    else { perfVerdict = "warn"; perfDetail = "Tight CPU headroom"; perfScore = 50; }
  } else { perfVerdict = "warn"; perfDetail = "No demanding resource requirement declared"; perfScore = 60; }
  priorities.push({ key: "performance", label: "Performance", verdict: perfVerdict, score: perfScore, detail: perfDetail });

  // Composite score is display-only. Recommendation is lexicographic on priority order,
  // so performance cannot override a simplicity/reliability disadvantage.
  const score = Math.round(priorities.reduce((s, p) => s + p.score, 0) / priorities.length);
  reasons.push(...priorities.map((p) => `${p.label}: ${p.detail}`));
  const rankKey = priorities.map((p) => `${vrank[p.verdict]}${(100 - p.score).toString().padStart(3, "0")}`).join("|");

  return { eligible: true, score, hardFails: [], reasons, evidence, unknowns, priorities, rankKey };
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