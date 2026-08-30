import React, { useMemo, useState } from "react";
import { useAllEntities } from "@/hooks/useEntities";
import { Card } from "@/components/ui-bits";
import { fmtGB, badgeClass, scorePlacement } from "@/lib/homelab";
import { EligibilityBadge, ConstraintRow, PriorityRow } from "@/components/PlacementBits";
import { Star, AlertTriangle } from "lucide-react";

const LOAD = ["Node", "Workload", "ExecutionEnvironment", "StoragePool"];

export default function PlacementSimulator() {
  const { data, loading } = useAllEntities(LOAD);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const pools = data.StoragePool || [];
  const [wlId, setWlId] = useState("");

  const wl = workloads.find((w) => w.id === wlId);
  const currentHost = wl ? (envs.find((e) => e.id === wl.current_environment)?.current_host || wl.current_host) : null;

  const results = useMemo(() => {
    if (!wl) return [];
    return nodes.map((n) => ({ node: n, res: scorePlacement(wl, n, { envs, workloads, pools }) }))
      .sort((a, b) => (a.res.rankKey || "").localeCompare(b.res.rankKey || ""));
  }, [wl, nodes, workloads, envs, pools]);

  const eligibleResults = results.filter((r) => r.res.eligibility === "eligible");
  const recommended = eligibleResults[0] || null;
  const recommendedId = recommended && recommended.node.id !== currentHost ? recommended.node.id : null;

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const groups = {
    recommended: results.filter((r) => r.node.id === recommendedId),
    eligible: eligibleResults.filter((r) => r.node.id !== recommendedId),
    unknown: results.filter((r) => r.res.eligibility === "unknown"),
    ineligible: results.filter((r) => r.res.eligibility === "ineligible"),
  };

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
            {currentHost ? <>Currently realized on <span className="font-medium text-foreground">{nodes.find((n) => n.id === currentHost)?.hostname || "—"}</span></> : "No current realization"}
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
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">CPU req:</span> <span className="font-medium">{wl.cpu_requirement || 0}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">RAM req:</span> <span className="font-medium">{fmtGB(wl.ram_requirement_gb)}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">VRAM req:</span> <span className="font-medium">{fmtGB(wl.gpu_vram_requirement_gb)}</span></div>
            <div className="rounded-md border border-border p-2"><span className="text-muted-foreground">Availability:</span> <span className="font-medium capitalize">{(wl.availability_requirement || "").replace(/_/g, " ")}</span></div>
          </div>

          <Group title="Recommended" tone="emerald" items={groups.recommended} currentHost={currentHost} recommended />
          <Group title="Eligible" tone="sky" items={groups.eligible} currentHost={currentHost} />
          <Group title="Eligibility unknown" tone="amber" items={groups.unknown} currentHost={currentHost} />
          <Group title="Ineligible" tone="rose" items={groups.ineligible} currentHost={currentHost} />

          <div className="text-[11px] text-muted-foreground space-y-1">
            <div>Hard constraints (RAM, CPU, GPU VRAM, GPU presence, storage, availability, explicit eligible list) make a candidate <span className="text-rose-500 font-medium">ineligible</span> — they disqualify, they are not scored down.</div>
            <div>Unknown hard constraints yield <span className="text-amber-500 font-medium">eligibility unknown</span> — never a confident eligible recommendation.</div>
            <div>Eligible candidates are ranked lexicographically by priority order — simplicity → reliability → power → scalability → performance — so performance cannot override a simplicity/reliability disadvantage.</div>
            <div>The workload's own footprint is excluded from current allocation so re-placement is scored accurately. The simulator never makes infrastructure changes.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ title, tone, items, currentHost, recommended }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className={badgeClass(tone)}>{items.length}</span>
      </div>
      <div className="space-y-3">
        {items.map((r) => <CandidateCard key={r.node.id} r={r} currentHost={currentHost} recommended={recommended} />)}
      </div>
    </div>
  );
}

function CandidateCard({ r, currentHost, recommended }) {
  const isCurrent = currentHost && r.node.id === currentHost;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{r.node.hostname}</span>
          <span className="text-xs text-muted-foreground capitalize">· {r.node.lifecycle_state} · {r.node.availability_expectation.replace(/_/g, " ")}</span>
          {isCurrent && <span className={badgeClass("sky")}>current host</span>}
          {recommended && <span className={badgeClass("emerald")}><Star className="w-3 h-3" />recommended</span>}
        </div>
        <div className="flex items-center gap-2">
          <EligibilityBadge eligibility={r.res.eligibility} />
          <span className="text-[11px] text-muted-foreground">conf: {r.res.confidence}</span>
        </div>
      </div>

      {r.res.hardConstraints.length > 0 && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">{r.res.hardConstraints.map((c) => <ConstraintRow key={c.key} c={c} />)}</div>
      )}
      {r.res.priorities.length > 0 && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{r.res.priorities.map((p) => <PriorityRow key={p.key} p={p} />)}</div>
      )}
      {r.res.unverified.length > 0 && (
        <ul className="mt-2 space-y-1">{r.res.unverified.map((u, i) => <li key={i} className="text-[11px] text-amber-600 dark:text-amber-400 italic flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />unverified: {u}</li>)}</ul>
      )}
      {r.res.unknowns.length > 0 && (
        <ul className="mt-2 space-y-1">{r.res.unknowns.map((u, i) => <li key={i} className="text-[11px] text-muted-foreground italic">· unknown: {u}</li>)}</ul>
      )}
    </Card>
  );
}