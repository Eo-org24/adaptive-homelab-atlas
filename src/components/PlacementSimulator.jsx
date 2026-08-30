import React, { useMemo, useState } from "react";
import { useAllEntities } from "@/hooks/useEntities";
import { Card } from "@/components/ui-bits";
import { fmtGB, nodeAllocations, scorePlacement, badgeClass } from "@/lib/homelab";
import { CheckCircle2, XCircle, AlertTriangle, Cpu, MemoryStick, Monitor, Star } from "lucide-react";

// Resource dimensions the simulator evaluates as hard constraints.
const RES = [
  { key: "ram", label: "RAM", icon: MemoryStick, need: (wl) => wl.ram_requirement_gb, total: (n) => n.ram_capacity_gb, fmt: fmtGB },
  { key: "cpu", label: "CPU", icon: Cpu, need: (wl) => wl.cpu_requirement, total: (n) => n.logical_cpus || n.physical_cores, fmt: (v) => (v || 0) },
  { key: "vram", label: "GPU VRAM", icon: Monitor, need: (wl) => wl.gpu_vram_requirement_gb, total: (n) => n.gpu_vram_gb, fmt: fmtGB },
];

export default function PlacementSimulator() {
  const { data, loading } = useAllEntities(["Node", "Workload", "ExecutionEnvironment"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const [wlId, setWlId] = useState("");

  const wl = workloads.find((w) => w.id === wlId);

  const results = useMemo(() => {
    if (!wl) return [];
    // Exclude the workload itself from current allocation: it is being (re)placed,
    // not stacked on top of its own existing footprint.
    const others = workloads.filter((w) => w.id !== wl.id);
    return nodes.map((n) => {
      const alloc = nodeAllocations(n, others, envs);
      const res = scorePlacement(wl, n, { currentAlloc: alloc });
      const constraints = RES.map((r) => {
        const need = r.need(wl) || 0;
        const total = r.total(n) || 0;
        const free = total - alloc[r.key];
        const ok = need <= free;
        return { ...r, need, total, free, ok, short: ok ? 0 : need - free };
      }).filter((c) => c.need > 0);
      const hardFail = !res.eligible;
      return { node: n, res, alloc, constraints, hardFail };
    }).sort((a, b) => {
      if (a.hardFail !== b.hardFail) return a.hardFail ? 1 : -1;
      if (!a.hardFail) return (a.res.rankKey || "").localeCompare(b.res.rankKey || "");
      return 0;
    });
  }, [wl, nodes, workloads, envs]);

  const viable = results.filter((r) => !r.hardFail);
  const recommended = viable[0] || null;
  const currentHost = wl ? nodes.find((n) => n.id === wl.current_host) : null;
  const isAlreadyOptimal = !!(recommended && currentHost && recommended.node.id === currentHost.id);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div>
      <div className="mb-4 flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 max-w-md">
          <label className="text-xs font-medium text-muted-foreground">Select a workload to evaluate placement candidates</label>
          <select value={wlId} onChange={(e) => setWlId(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="">—</option>
            {workloads.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.category.replace(/_/g, " ")})</option>)}
          </select>
        </div>
        {wl && (
          <div className="text-xs text-muted-foreground">
            {currentHost ? <>Currently hosted on <span className="font-medium text-foreground">{currentHost.hostname}</span></> : "Not currently assigned to any node"}
          </div>
        )}
      </div>

      <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 mb-4">
        The simulator only proposes placements. It never makes infrastructure changes.
      </div>

      {!wl ? (
        <p className="text-sm text-muted-foreground">Pick a workload above to see scored candidate nodes.</p>
      ) : nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No nodes documented — add nodes to evaluate placement.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">CPU req:</span> <span className="font-medium">{wl.cpu_requirement || 0}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">RAM req:</span> <span className="font-medium">{fmtGB(wl.ram_requirement_gb)}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">VRAM req:</span> <span className="font-medium">{fmtGB(wl.gpu_vram_requirement_gb)}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">Availability:</span> <span className="font-medium capitalize">{(wl.availability_requirement || "").replace(/_/g, " ")}</span></div>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-muted-foreground">{viable.length} viable / {results.length} total candidates</span>
            {viable.length === 0 && <span className={badgeClass("rose")}>No node can satisfy this workload's hard constraints</span>}
            {recommended && !isAlreadyOptimal && <span className={badgeClass("emerald")}><Star className="w-3 h-3" />Recommended: {recommended.node.hostname}</span>}
            {isAlreadyOptimal && <span className={badgeClass("emerald")}>Already on the best viable host</span>}
          </div>

          {results.map((r) => {
            const ok = !r.hardFail;
            const isRec = recommended && r.node.id === recommended.node.id;
            const isCurrent = currentHost && r.node.id === currentHost.id;
            const tone = !ok ? "rose" : r.res.score >= 70 ? "emerald" : r.res.score >= 40 ? "amber" : "rose";
            return (
              <Card key={r.node.id} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {ok ? (r.res.score >= 70 ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <AlertTriangle className="w-4 h-4 text-amber-500" />) : <XCircle className="w-4 h-4 text-rose-500" />}
                    <span className="font-medium">{r.node.hostname}</span>
                    <span className="text-xs text-muted-foreground capitalize">· {r.node.lifecycle_state} · {r.node.availability_expectation.replace(/_/g, " ")}</span>
                    {isCurrent && <span className={badgeClass("sky")}>current host</span>}
                    {isRec && !isCurrent && <span className={badgeClass("emerald")}><Star className="w-3 h-3" />recommended</span>}
                  </div>
                  <div className={`text-lg font-semibold ${tone === "emerald" ? "text-emerald-500" : tone === "amber" ? "text-amber-500" : "text-rose-500"}`}>{r.res.score}/100</div>
                </div>

                {r.constraints.length > 0 && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {r.constraints.map((c) => {
                      const after = c.free - c.need;
                      return (
                        <div key={c.key} className="rounded-md border border-border p-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1 text-muted-foreground"><c.icon className="w-3 h-3" />{c.label}</span>
                            {c.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <XCircle className="w-3 h-3 text-rose-500" />}
                          </div>
                          <div className="mt-1 tabular-nums">need {c.fmt(c.need)} · free {c.fmt(c.free)}</div>
                          {!c.ok ? (
                            <div className="text-rose-500 mt-0.5">short {c.fmt(c.short)}</div>
                          ) : (
                            <div className="text-muted-foreground mt-0.5">after placement: {c.fmt(after)} free</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {ok && r.res.priorities?.length > 0 && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {r.res.priorities.map((p) => {
                      const tone = p.verdict === "good" ? "emerald" : p.verdict === "warn" ? "amber" : "rose";
                      const Icon = p.verdict === "good" ? CheckCircle2 : p.verdict === "warn" ? AlertTriangle : XCircle;
                      return (
                        <div key={p.key} className="rounded-md border border-border p-2 text-xs">
                          <div className="flex items-center gap-1.5">
                            <Icon className={`w-3 h-3 ${tone === "emerald" ? "text-emerald-500" : tone === "amber" ? "text-amber-500" : "text-rose-500"}`} />
                            <span className="font-medium">{p.label}</span>
                            <span className="ml-auto capitalize text-muted-foreground">{p.verdict}</span>
                          </div>
                          <div className="text-muted-foreground mt-1">{p.detail}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {ok && r.res.unknowns?.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.res.unknowns.map((u, i) => (
                      <li key={i} className="text-[11px] flex items-start gap-2 text-muted-foreground italic">
                        <span className="w-1 h-1 rounded-full bg-current mt-1.5 shrink-0" />unknown: {u}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-[11px] text-muted-foreground space-y-1">
        <div>Hard constraints (RAM, CPU, GPU VRAM, GPU presence) make a candidate <span className="text-rose-500 font-medium">ineligible</span> — they disqualify, they are not merely scored down.</div>
        <div>Eligible candidates are ranked lexicographically by priority order — simplicity → reliability → power efficiency → scalability → performance — so a performance advantage cannot override a simplicity or reliability disadvantage.</div>
        <div>Allocation excludes the workload's own current footprint so re-placement is scored accurately. The simulator never makes infrastructure changes.</div>
      </div>
    </div>
  );
}