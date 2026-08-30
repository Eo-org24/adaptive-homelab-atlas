import React, { useMemo, useState } from "react";
import { useAllEntities } from "@/hooks/useEntities";
import { PageHeader, Card } from "@/components/ui-bits";
import { fmtGB, nodeAllocations, scorePlacement } from "@/lib/homelab";
import { Boxes, Cpu, MemoryStick, Monitor, HardDrive } from "lucide-react";

function Bar({ allocated, total, tone = "sky" }) {
  const pct = total > 0 ? Math.min(100, (allocated / total) * 100) : 0;
  const tones = { sky: "bg-sky-500", emerald: "bg-emerald-500", amber: "bg-amber-500", violet: "bg-violet-500" };
  return (
    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
      <div className={`h-full ${tones[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function Capacity() {
  const { data, loading } = useAllEntities(["Node", "Workload", "ExecutionEnvironment"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const [hypWL, setHypWL] = useState("");
  const [hypNode, setHypNode] = useState("");

  const rows = useMemo(() => nodes.map((n) => {
    const alloc = nodeAllocations(n, workloads, envs);
    return {
      node: n,
      cpu: { total: n.logical_cpus || n.physical_cores || 0, alloc: alloc.cpu },
      ram: { total: n.ram_capacity_gb || 0, alloc: alloc.ram },
      vram: { total: n.gpu_vram_gb || 0, alloc: alloc.vram },
      storage: { total: 0, alloc: alloc.storage },
    };
  }), [nodes, workloads, envs]);

  const hypResult = useMemo(() => {
    if (!hypWL || !hypNode) return null;
    const wl = workloads.find((w) => w.id === hypWL);
    const node = nodes.find((n) => n.id === hypNode);
    if (!wl || !node) return null;
    const alloc = nodeAllocations(node, workloads, envs);
    const res = scorePlacement(wl, node, { currentAlloc: alloc });
    return { wl, node, res, alloc };
  }, [hypWL, hypNode, workloads, nodes, envs]);

  if (loading) return <div className="p-6"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin mx-auto mt-20" /></div>;

  return (
    <div className="p-4 xl:p-6 max-w-[1760px] mx-auto">
      <PageHeader title="Capacity" description="Documented capacity versus workload allocation. Hypothetical placement never changes real assignments." />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Cpu className="w-3.5 h-3.5" /> Total CPU</div><div className="text-2xl font-semibold mt-1">{nodes.reduce((s, n) => s + (n.logical_cpus || n.physical_cores || 0), 0)}</div><div className="text-xs text-muted-foreground">logical CPUs</div></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><MemoryStick className="w-3.5 h-3.5" /> Total RAM</div><div className="text-2xl font-semibold mt-1">{fmtGB(nodes.reduce((s, n) => s + (n.ram_capacity_gb || 0), 0))}</div></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Monitor className="w-3.5 h-3.5" /> GPU VRAM</div><div className="text-2xl font-semibold mt-1">{fmtGB(nodes.reduce((s, n) => s + (n.gpu_vram_gb || 0), 0))}</div></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Boxes className="w-3.5 h-3.5" /> Workloads</div><div className="text-2xl font-semibold mt-1">{workloads.length}</div></Card>
      </div>

      <Card title="Per-node capacity & allocation">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2.5">Node</th>
                <th className="text-left font-medium px-3 py-2.5 w-40">CPU (cores)</th>
                <th className="text-left font-medium px-3 py-2.5 w-40">RAM (GB)</th>
                <th className="text-left font-medium px-3 py-2.5 w-40">GPU VRAM (GB)</th>
                <th className="text-left font-medium px-3 py-2.5 w-40">Storage alloc (GB)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.node.id}>
                  <td className="px-3 py-3">
                    <div className="font-medium">{r.node.hostname}</div>
                    <div className="text-[11px] text-muted-foreground capitalize">{r.node.lifecycle_state}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-xs tabular-nums">{r.cpu.alloc} / {r.cpu.total} <span className="text-muted-foreground">({r.cpu.total - r.cpu.alloc} free)</span></div>
                    <Bar allocated={r.cpu.alloc} total={r.cpu.total} tone="emerald" />
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-xs tabular-nums">{fmtGB(r.ram.alloc)} / {fmtGB(r.ram.total)} <span className="text-muted-foreground">({fmtGB(r.ram.total - r.ram.alloc)} free)</span></div>
                    <Bar allocated={r.ram.alloc} total={r.ram.total} tone="sky" />
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-xs tabular-nums">{fmtGB(r.vram.alloc)} / {fmtGB(r.vram.total)}</div>
                    <Bar allocated={r.vram.alloc} total={r.vram.total} tone="violet" />
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-xs tabular-nums">{fmtGB(r.storage.alloc)}</div>
                    <Bar allocated={r.storage.alloc} total={Math.max(r.storage.alloc, 1)} tone="amber" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Hypothetical workload placement" className="mt-4 p-4">
        <p className="text-xs text-muted-foreground mb-3">Select a workload and a candidate node to preview the resulting allocation. Nothing is saved.</p>
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <select value={hypWL} onChange={(e) => setHypWL(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm flex-1">
            <option value="">Select workload…</option>
            {workloads.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select value={hypNode} onChange={(e) => setHypNode(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm flex-1">
            <option value="">Select candidate node…</option>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}</option>)}
          </select>
        </div>
        {hypResult && (
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm">Placing <span className="font-medium">{hypResult.wl.name}</span> on <span className="font-medium">{hypResult.node.hostname}</span></div>
              <div className={`text-lg font-semibold ${hypResult.res.score >= 70 ? "text-emerald-500" : hypResult.res.score >= 40 ? "text-amber-500" : "text-rose-500"}`}>{hypResult.res.score}/100</div>
            </div>
            {hypResult.res.hardFails.length > 0 ? (
              <div className="text-sm text-rose-500">Blocked: {hypResult.res.reasons.join("; ")}</div>
            ) : (
              <ul className="space-y-1.5">
                {hypResult.res.reasons.map((r, i) => <li key={i} className="text-xs text-muted-foreground flex items-start gap-2"><span className="w-1 h-1 rounded-full bg-muted-foreground mt-1.5 shrink-0" />{r}</li>)}
              </ul>
            )}
            <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-border">
              <div><div className="text-[11px] text-muted-foreground">RAM after</div><div className="text-sm font-medium">{fmtGB(Math.max(0, hypResult.alloc.ram + (hypResult.wl.ram_requirement_gb || 0)))} / {fmtGB(hypResult.node.ram_capacity_gb)}</div></div>
              <div><div className="text-[11px] text-muted-foreground">CPU after</div><div className="text-sm font-medium">{hypResult.alloc.cpu + (hypResult.wl.cpu_requirement || 0)} / {hypResult.node.logical_cpus || 0}</div></div>
              <div><div className="text-[11px] text-muted-foreground">VRAM after</div><div className="text-sm font-medium">{fmtGB(hypResult.alloc.vram + (hypResult.wl.gpu_vram_requirement_gb || 0))} / {fmtGB(hypResult.node.gpu_vram_gb)}</div></div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}