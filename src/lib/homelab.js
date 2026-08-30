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
    default: return "zinc";
  }
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
  const reasons = [];
  let score = 100;
  const alloc = opts.currentAlloc || { cpu: 0, ram: 0, vram: 0, storage: 0 };

  // Hard constraints (resource requirements)
  const hardFails = [];
  if (workload.ram_requirement_gb && node.ram_capacity_gb != null) {
    const remaining = node.ram_capacity_gb - alloc.ram;
    if (workload.ram_requirement_gb > remaining) { hardFails.push("RAM"); score -= 100; }
  }
  if (workload.cpu_requirement && node.logical_cpus != null) {
    const remaining = node.logical_cpus - alloc.cpu;
    if (workload.cpu_requirement > remaining) { hardFails.push("CPU"); score -= 100; }
  }
  if (workload.gpu_vram_requirement_gb && node.gpu_vram_gb != null) {
    const remaining = node.gpu_vram_gb - alloc.vram;
    if (workload.gpu_vram_requirement_gb > remaining) { hardFails.push("GPU VRAM"); score -= 100; }
  }
  if (hardFails.length) {
    return { score: 0, hardFails, reasons: [`Insufficient ${hardFails.join(", ")} on ${node.hostname}`] };
  }
  if (workload.gpu_vram_requirement_gb && (!node.gpu_vram_gb || node.gpu_vram_gb === 0)) {
    score -= 60; reasons.push("Node has no documented GPU VRAM but workload requires GPU");
  }

  // Soft constraints (architectural principles, weighted by priority order)
  // 1. Simplicity — prefer preferred node, avoid introducing new dependency surface
  if (workload.preferred_node === node.id) { score += 8; reasons.push("Matches preferred node (simplicity)"); }
  else if (workload.eligible_alternative_nodes?.includes(node.id)) { score += 4; reasons.push("Listed as eligible alternative"); }
  else { score -= 6; reasons.push("Not in preferred/eligible list (adds coordination surface)"); }

  // 2. Reliability — availability expectation vs node lifecycle
  if (node.lifecycle_state === "active") { score += 6; }
  else if (["degraded", "maintenance", "retiring", "retired"].includes(node.lifecycle_state)) { score -= 20; reasons.push(`Node lifecycle is ${node.lifecycle_state}`); }
  if (workload.availability_requirement === "always_on" && node.availability_expectation !== "always_on") {
    score -= 15; reasons.push("Always-on workload on non-always-on node (reliability risk)");
  }
  if (node.availability_expectation === "always_on") { score += 5; }

  // 3. Power efficiency — lower idle/max power is better
  const idle = node.idle_power_w || 0;
  if (idle > 0) {
    if (idle <= 15) { score += 6; reasons.push("Very low idle power (efficient)"); }
    else if (idle <= 60) { score += 2; }
    else if (idle >= 200) { score -= 8; reasons.push("High idle power draw"); }
  }

  // 4. Scalability — headroom after placement
  if (node.ram_capacity_gb && workload.ram_requirement_gb) {
    const remainPct = 1 - (alloc.ram + workload.ram_requirement_gb) / node.ram_capacity_gb;
    if (remainPct > 0.5) { score += 4; reasons.push("Plenty of remaining capacity (scalable)"); }
    else if (remainPct < 0.15) { score -= 8; reasons.push("Little headroom left after placement"); }
  }

  // 5. Performance — more cores / vram is better for demanding workloads
  if (workload.category === "ai_inference" || workload.gpu_vram_requirement_gb) {
    if (node.gpu_vram_gb && node.gpu_vram_gb >= (workload.gpu_vram_requirement_gb || 0) * 2) { score += 6; reasons.push("Strong GPU headroom (performance)"); }
  }
  if (workload.cpu_requirement && node.logical_cpus && node.logical_cpus >= workload.cpu_requirement * 4) { score += 3; }

  // Architectural rule: avoid making a powerful workstation a mandatory always-on dependency
  if (node.node_type === "workstation" && workload.availability_requirement === "always_on") {
    score -= 25; reasons.push("Workstation as always-on dependency violates 'no mandatory always-on' principle");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, hardFails: [], reasons };
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