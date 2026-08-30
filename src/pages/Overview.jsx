import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Server, Boxes, Cpu, MemoryStick, Monitor, HardDrive, AlertTriangle, GitBranch, ListTodo,
  CircleDot, FlaskConical, ShieldAlert, ArrowRight, Clock,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { useAllEntities } from "@/hooks/useEntities";
import { StatCard, Card, EmptyState } from "@/components/ui-bits";
import {
  fmtGB, fmtDate, timeAgo, lifecycleTone, criticalityTone, riskTone, badgeClass, StatusBadge,
  detectCycles, criticalityMismatches, reconstructabilityIssues, resourceShortages, nodeAllocations, typedRefName,
} from "@/lib/homelab";

const LOAD = ["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "NetworkDevice", "PlannedChange", "Task", "Maintenance", "Decision", "Dependency"];

const PIE_COLORS = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#f43f5e", "#6366f1", "#ec4899", "#14b8a6", "#f97316", "#a3a3a3", "#84cc16"];

export default function Overview() {
  const { data, loading } = useAllEntities(LOAD);
  const navigate = useNavigate();

  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const storage = data.StorageDevice || [];
  const changes = data.PlannedChange || [];
  const tasks = data.Task || [];
  const maintenance = data.Maintenance || [];
  const decisions = data.Decision || [];
  const deps = data.Dependency || [];

  const stats = useMemo(() => {
    const activeNodes = nodes.filter((n) => !["retired", "planned"].includes(n.lifecycle_state));
    const totalRam = nodes.reduce((s, n) => s + (n.ram_capacity_gb || 0), 0);
    const totalCpu = nodes.reduce((s, n) => s + (n.logical_cpus || n.physical_cores || 0), 0);
    const totalVram = nodes.reduce((s, n) => s + (n.gpu_vram_gb || 0), 0);
    const usableStorage = storage.filter((s) => s.health !== "retired").reduce((s, d) => s + (d.capacity_gb || 0), 0);
    const warnings = [
      ...detectCycles(deps).map((c) => `Dependency cycle: ${c.join(" → ")}`),
      ...criticalityMismatches(deps, workloads).map((m) => `Low-criticality "${m.target.name}" supports high-criticality "${m.source.name}"`),
      ...reconstructabilityIssues(workloads, envs).map((r) => `"${r.workload.name}" marked reconstructable but env "${r.environment.name}" has persistent state`),
      ...resourceShortages(workloads, nodes).map((r) => `"${r.workload.name}" needs more ${r.field} than ${r.node.hostname} provides`),
    ];
    return {
      nodes: activeNodes.length, totalNodes: nodes.length, workloads: workloads.length,
      totalRam, totalCpu, totalVram, usableStorage,
      warnings, pendingChanges: changes.filter((c) => !["completed", "abandoned", "rolled_back"].includes(c.status)).length,
      openTasks: tasks.filter((t) => !["completed", "abandoned"].includes(t.status)).length,
    };
  }, [nodes, workloads, envs, storage, changes, tasks, deps]);

  const ramByNode = nodes.map((n) => ({ name: n.hostname, allocated: nodeAllocations(n, workloads, envs).ram, total: n.ram_capacity_gb || 0 }));
  const cpuByNode = nodes.map((n) => ({ name: n.hostname, allocated: nodeAllocations(n, workloads, envs).cpu, total: n.logical_cpus || n.physical_cores || 0 }));
  const storageByMedia = useMemo(() => {
    const m = {};
    storage.forEach((d) => { m[d.media_type] = (m[d.media_type] || 0) + (d.capacity_gb || 0); });
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  }, [storage]);
  const wlByCategory = useMemo(() => {
    const m = {};
    workloads.forEach((w) => { m[w.category] = (m[w.category] || 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name: name.replace(/_/g, " "), value }));
  }, [workloads]);
  const wlByLifecycle = useMemo(() => {
    const m = {};
    workloads.forEach((w) => { m[w.lifecycle] = (m[w.lifecycle] || 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name: name.replace(/_/g, " "), value }));
  }, [workloads]);
  const wlByCriticality = useMemo(() => {
    const order = ["critical", "high", "medium", "low"];
    const m = {};
    workloads.forEach((w) => { m[w.criticality] = (m[w.criticality] || 0) + 1; });
    return order.filter((o) => m[o]).map((name) => ({ name, value: m[name] }));
  }, [workloads]);

  const recentChanges = [...changes].sort((a, b) => new Date(b.updated_date) - new Date(a.updated_date)).slice(0, 6);
  const plannedWork = changes.filter((c) => ["accepted", "ready", "proposed", "idea"].includes(c.status)).slice(0, 6);
  const experiments = workloads.filter((w) => w.lifecycle === "experimental" || w.category === "experimental").slice(0, 6);
  const attentionNodes = nodes.filter((n) => ["degraded", "maintenance", "retiring", "onboarding"].includes(n.lifecycle_state));
  const recentMaintenance = [...maintenance].sort((a, b) => new Date(b.timestamp || b.updated_date) - new Date(a.timestamp || a.updated_date)).slice(0, 6);

  if (loading) return <div className="p-6"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin mx-auto mt-20" /></div>;

  return (
    <div className="p-4 xl:p-6 max-w-[1760px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Operations Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">Documented state of the homelab — not live monitoring. Manually entered, observed, imported, inferred, and planned values are distinguished throughout.</p>
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <CircleDot className="w-3 h-3 text-emerald-500" /> Documented as of {fmtDate(new Date())}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">
        <StatCard label="Nodes" value={stats.nodes} sub={`${stats.totalNodes} documented`} icon={Server} tone="sky" onClick={() => navigate("/nodes")} />
        <StatCard label="Workloads" value={stats.workloads} icon={Boxes} tone="violet" onClick={() => navigate("/workloads")} />
        <StatCard label="Total CPU" value={`${stats.totalCpu}`} sub="logical CPUs" icon={Cpu} tone="emerald" onClick={() => navigate("/capacity")} />
        <StatCard label="Total RAM" value={fmtGB(stats.totalRam)} icon={MemoryStick} tone="amber" onClick={() => navigate("/capacity")} />
        <StatCard label="GPU VRAM" value={fmtGB(stats.totalVram)} icon={Monitor} tone="orange" onClick={() => navigate("/capacity")} />
        <StatCard label="Storage" value={fmtGB(stats.usableStorage)} sub="documented" icon={HardDrive} tone="sky" onClick={() => navigate("/storage")} />
        <StatCard label="Warnings" value={stats.warnings.length} sub="unresolved" icon={AlertTriangle} tone={stats.warnings.length ? "rose" : "emerald"} onClick={() => navigate("/change-planner")} />
        <StatCard label="Open tasks" value={stats.openTasks} sub={`${stats.pendingChanges} pending changes`} icon={ListTodo} tone="amber" onClick={() => navigate("/tasks")} />
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="RAM capacity by node (GB)" className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={ramByNode} margin={{ top: 4, right: 4, bottom: 4, left: -16 }}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="total" name="Total" fill="#64748b" radius={[3, 3, 0, 0]} />
              <Bar dataKey="allocated" name="Allocated" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="CPU capacity by node (cores)" className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={cpuByNode} margin={{ top: 4, right: 4, bottom: 4, left: -16 }}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="total" name="Total" fill="#64748b" radius={[3, 3, 0, 0]} />
              <Bar dataKey="allocated" name="Allocated" fill="#10b981" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Storage by media type" className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={storageByMedia} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2}>
                {storageByMedia.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => fmtGB(v)} contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
        <Card title="Workload distribution by category" className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={wlByCategory} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} paddingAngle={2}>
                {wlByCategory.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Workload lifecycle state" className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={wlByLifecycle} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 10 }}>
              <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={70} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="value" fill="#8b5cf6" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Workload criticality" className="p-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={wlByCriticality} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                {wlByCriticality.map((e, i) => <Cell key={i} fill={["#f43f5e", "#f97316", "#f59e0b", "#10b981"][["critical", "high", "medium", "low"].indexOf(e.name)]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Sections grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
        {/* Architecture warnings */}
        <Card title="Architecture warnings" className="p-4" actions={<ShieldAlert className="w-4 h-4 text-rose-500" />}>
          {stats.warnings.length === 0 ? (
            <EmptyState title="No warnings" sub="No cycles, criticality mismatches, or resource issues detected." />
          ) : (
            <ul className="space-y-2">
              {stats.warnings.slice(0, 8).map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-500 mt-0.5 shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Recent changes */}
        <Card title="Recent changes" className="p-4" actions={<button onClick={() => navigate("/change-planner")} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></button>}>
          {recentChanges.length === 0 ? <EmptyState title="No changes recorded" /> : (
            <ul className="space-y-2.5">
              {recentChanges.map((c) => (
                <li key={c.id} className="flex items-start gap-2 cursor-pointer" onClick={() => navigate(`/change-planner?focus=${c.id}`)}>
                  <GitBranch className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{c.title}</div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <StatusBadge value={c.status} tone={lifecycleTone(c.status)} />
                      <span>{timeAgo(c.updated_date)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Planned work */}
        <Card title="Planned work" className="p-4">
          {plannedWork.length === 0 ? <EmptyState title="Nothing planned" /> : (
            <ul className="space-y-2.5">
              {plannedWork.map((c) => (
                <li key={c.id} className="flex items-start gap-2 cursor-pointer" onClick={() => navigate(`/change-planner?focus=${c.id}`)}>
                  <Clock className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{c.title}</div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <StatusBadge value={c.status} tone={lifecycleTone(c.status)} />
                      {c.planned_date && <span>{fmtDate(c.planned_date)}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Current experiments */}
        <Card title="Current experiments" className="p-4" actions={<FlaskConical className="w-4 h-4 text-amber-500" />}>
          {experiments.length === 0 ? <EmptyState title="No experiments" /> : (
            <ul className="space-y-2.5">
              {experiments.map((w) => (
                <li key={w.id} className="flex items-start gap-2 cursor-pointer" onClick={() => navigate(`/workloads?focus=${w.id}`)}>
                  <FlaskConical className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{w.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">{w.description || w.category}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Nodes requiring attention */}
        <Card title="Nodes requiring attention" className="p-4">
          {attentionNodes.length === 0 ? <EmptyState title="All nodes nominal" /> : (
            <ul className="space-y-2.5">
              {attentionNodes.map((n) => (
                <li key={n.id} className="flex items-center gap-2 cursor-pointer" onClick={() => navigate(`/nodes?focus=${n.id}`)}>
                  <Server className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium flex-1 truncate">{n.hostname}</span>
                  <StatusBadge value={n.lifecycle_state} tone={lifecycleTone(n.lifecycle_state)} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Recent maintenance */}
        <Card title="Recent maintenance activity" className="p-4" actions={<button onClick={() => navigate("/maintenance")} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></button>}>
          {recentMaintenance.length === 0 ? <EmptyState title="No maintenance logged" /> : (
            <ul className="space-y-2.5">
              {recentMaintenance.map((m) => (
                <li key={m.id} className="flex items-start gap-2 cursor-pointer" onClick={() => navigate(`/maintenance?focus=${m.id}`)}>
                  <span className={`mt-0.5 shrink-0 ${badgeClass(riskTone(m.outcome === "success" ? "low" : m.outcome === "failed" ? "high" : "medium"))}`}>
                    {m.type}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{typedRefName(m.target_type, m.target_id, data) || "—"}</div>
                    <div className="text-[11px] text-muted-foreground">{timeAgo(m.timestamp || m.updated_date)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}