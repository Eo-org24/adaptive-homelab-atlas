import React, { useMemo, useState } from "react";
import { useAllEntities } from "@/hooks/useEntities";
import { Card } from "@/components/ui-bits";
import { fmtGB, nodeAllocations, scorePlacement } from "@/lib/homelab";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

export default function PlacementSimulator() {
  const { data, loading } = useAllEntities(["Node", "Workload", "ExecutionEnvironment"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const [wlId, setWlId] = useState("");

  const wl = workloads.find((w) => w.id === wlId);

  const results = useMemo(() => {
    if (!wl) return [];
    return nodes.map((n) => {
      const alloc = nodeAllocations(n, workloads, envs);
      const res = scorePlacement(wl, n, { currentAlloc: alloc });
      return { node: n, res, alloc };
    }).sort((a, b) => b.res.score - a.res.score);
  }, [wl, nodes, workloads, envs]);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div>
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground">Select a workload to evaluate placement candidates</label>
        <select value={wlId} onChange={(e) => setWlId(e.target.value)} className="mt-1 w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">—</option>
          {workloads.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.category.replace(/_/g, " ")})</option>)}
        </select>
      </div>

      <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 mb-4">
        The simulator only proposes placements. It never makes infrastructure changes.
      </div>

      {!wl ? (
        <p className="text-sm text-muted-foreground">Pick a workload above to see scored candidate nodes.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">CPU req:</span> <span className="font-medium">{wl.cpu_requirement || 0}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">RAM req:</span> <span className="font-medium">{fmtGB(wl.ram_requirement_gb)}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">VRAM req:</span> <span className="font-medium">{fmtGB(wl.gpu_vram_requirement_gb)}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">Availability:</span> <span className="font-medium capitalize">{(wl.availability_requirement || "").replace(/_/g, " ")}</span></div>
          </div>

          {results.map((r) => {
            const ok = r.res.hardFails.length === 0;
            const tone = !ok ? "rose" : r.res.score >= 70 ? "emerald" : r.res.score >= 40 ? "amber" : "rose";
            return (
              <Card key={r.node.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {ok ? (r.res.score >= 70 ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <AlertTriangle className="w-4 h-4 text-amber-500" />) : <XCircle className="w-4 h-4 text-rose-500" />}
                    <span className="font-medium">{r.node.hostname}</span>
                    <span className="text-xs text-muted-foreground capitalize">· {r.node.lifecycle_state} · {r.node.availability_expectation.replace(/_/g, " ")}</span>
                  </div>
                  <div className={`text-lg font-semibold ${tone === "emerald" ? "text-emerald-500" : tone === "amber" ? "text-amber-500" : "text-rose-500"}`}>{r.res.score}/100</div>
                </div>
                <ul className="mt-2 space-y-1">
                  {r.res.reasons.map((reason, i) => (
                    <li key={i} className={`text-xs flex items-start gap-2 ${ok ? "text-muted-foreground" : "text-rose-500"}`}>
                      <span className="w-1 h-1 rounded-full bg-current mt-1.5 shrink-0" />{reason}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-[11px] text-muted-foreground">
        Scoring priority order: simplicity → reliability → power efficiency → scalability → performance. Resource requirements are hard constraints; architectural principles are soft constraints.
      </div>
    </div>
  );
}