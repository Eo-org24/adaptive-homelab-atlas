import React, { useMemo, useState } from "react";
import { useArchitectureDataset } from "@/hooks/useArchitectureDataset";
import { PageHeader, Card } from "@/components/ui-bits";
import ArchitectureGraph from "@/components/ArchitectureGraph";
import { physicalGraph, executionGraph, dependencyGraph, storageGraph, changeGraph, placementGraph, MODES } from "@/lib/graph";
import { runHealthChecks } from "@/lib/healthEngine";
import { normalizeSourceKind } from "@/lib/provenance";
import { Database } from "lucide-react";

const LOAD = ["Node", "ExecutionEnvironment", "Workload", "StorageDevice", "StoragePool", "NetworkDevice", "Dependency", "Maintenance", "Task", "PlannedChange", "Decision"];
const SEL = "rounded-md border border-input bg-background px-2 py-1.5 text-xs";

export default function Architecture() {
  const { data, complete, incompleteEntities, loading } = useArchitectureDataset(LOAD);
  const [mode, setMode] = useState("physical");
  const [fKind, setFKind] = useState("all");
  const [fLifecycle, setFLifecycle] = useState("all");
  const [fCriticality, setFCriticality] = useState("all");
  const [fState, setFState] = useState("all");
  const [fSev, setFSev] = useState("all");
  const [focusId, setFocusId] = useState("");
  const [changeId, setChangeId] = useState("");

  const findings = useMemo(() => runHealthChecks(data), [data]);
  const changes = data.PlannedChange || [];
  const change = changes.find((c) => c.id === changeId);

  const rawGraph = useMemo(() => {
    if (mode === "physical") return physicalGraph(data);
    if (mode === "execution") return executionGraph(data);
    if (mode === "placement") return placementGraph(data);
    if (mode === "dependency") return dependencyGraph(data);
    if (mode === "storage") return storageGraph(data);
    if (mode === "change") return change ? changeGraph(data, change) : { nodes: [], edges: [] };
    return { nodes: [], edges: [] };
  }, [data, mode, change]);

  // Focus: restrict to a node/workload/env and its 1-hop neighborhood.
  const focusGraph = useMemo(() => {
    if (!focusId) return rawGraph;
    const neighbors = new Set();
    rawGraph.edges.forEach((e) => { if (e.source === focusId) neighbors.add(e.target); if (e.target === focusId) neighbors.add(e.source); });
    neighbors.add(focusId);
    return { nodes: rawGraph.nodes.filter((n) => neighbors.has(n.id)), edges: rawGraph.edges.filter((e) => neighbors.has(e.source) && neighbors.has(e.target)) };
  }, [rawGraph, focusId]);

  // Filters
  const filtered = useMemo(() => {
    const sevRank = { critical: 0, error: 1, warning: 2, info: 3 };
    const nodeFindings = {}; findings.forEach((f) => { if (f.affected_id) (nodeFindings[f.affected_id] ||= []).push(f); });
    const keep = (n) => {
      if (fKind !== "all" && n.kind !== fKind) return false;
      if (fLifecycle !== "all" && n.lifecycle !== fLifecycle) return false;
      if (fCriticality !== "all" && n.criticality !== fCriticality) return false;
      if (fState !== "all" && n.state !== fState) return false;
      if (fSev !== "all") {
        const fs = nodeFindings[n.record?.id] || [];
        if (!fs.some((f) => sevRank[f.severity] <= sevRank[fSev])) return false;
      }
      return true;
    };
    const keepIds = new Set(focusGraph.nodes.filter(keep).map((n) => n.id));
    return { nodes: focusGraph.nodes.filter((n) => keepIds.has(n.id)), edges: focusGraph.edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)) };
  }, [focusGraph, fKind, fLifecycle, fCriticality, fState, fSev, findings]);

  const lifecycles = ["active", "planned", "experimental", "maintenance", "degraded", "retiring", "retired"];
  const states = ["canonical", "observed", "planned", "inferred", "local", "sample", "unknown"];

  if (loading) return <div className="p-6"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin mx-auto mt-20" /></div>;

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <PageHeader title="Architecture Graph" description="Relationship-driven views derived live from canonical records. No separate graph database — every edge corresponds to a real relationship. Pan, zoom, and select to inspect." />
      {!complete && (
        <Card className="p-4 mb-4 border-rose-500/30 bg-rose-500/5">
          <div className="flex items-start gap-2">
            <Database className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-rose-600 dark:text-rose-400">DATASET INCOMPLETE</div>
              <p className="text-xs text-muted-foreground mt-1">Architecture graph may be missing objects due to an incomplete dataset load. Results are not authoritative.</p>
              {incompleteEntities.length > 0 && <p className="text-[11px] text-muted-foreground mt-1">Affected: {incompleteEntities.join(", ")}</p>}
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex rounded-md border border-border overflow-hidden">
          {MODES.map((m) => <button key={m.key} onClick={() => setMode(m.key)} className={`px-3 py-1.5 text-xs ${mode === m.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{m.label}</button>)}
        </div>
        {mode === "change" && (
          <select value={changeId} onChange={(e) => setChangeId(e.target.value)} className={SEL}>
            <option value="">Select a planned change…</option>
            {changes.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <select value={fKind} onChange={(e) => setFKind(e.target.value)} className={SEL}><option value="all">All object types</option>{["node", "env", "workload", "storage", "pool", "network"].map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <select value={fLifecycle} onChange={(e) => setFLifecycle(e.target.value)} className={SEL}><option value="all">All lifecycles</option>{lifecycles.map((l) => <option key={l} value={l}>{l}</option>)}</select>
        <select value={fCriticality} onChange={(e) => setFCriticality(e.target.value)} className={SEL}><option value="all">All criticality</option>{["low", "medium", "high", "critical"].map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select value={fState} onChange={(e) => setFState(e.target.value)} className={SEL}><option value="all">All truth states</option>{states.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select value={fSev} onChange={(e) => setFSev(e.target.value)} className={SEL}><option value="all">No finding filter</option><option value="warning">Has warning+</option><option value="error">Has error+</option><option value="critical">Has critical</option></select>
        <select value={focusId} onChange={(e) => setFocusId(e.target.value)} className={SEL}>
          <option value="">Focus: none (all)</option>
          {(data.Node || []).map((n) => <option key={n.id} value={`node:${n.id}`}>node: {n.hostname}</option>)}
          {(data.Workload || []).map((w) => <option key={w.id} value={`workload:${w.id}`}>workload: {w.name}</option>)}
          {(data.ExecutionEnvironment || []).map((en) => <option key={en.id} value={`env:${en.id}`}>env: {en.name}</option>)}
        </select>
        <span className="text-muted-foreground">{filtered.nodes.length} nodes · {filtered.edges.length} edges</span>
      </div>

      {mode === "change" && !change ? (
        <Card className="p-6 text-sm text-muted-foreground text-center">Select a planned change above to visualize current vs proposed state.</Card>
      ) : filtered.nodes.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground text-center">No objects match the current filters. Loosen filters or pick a focus object.</Card>
      ) : (
        <ArchitectureGraph graph={filtered} findings={findings} />
      )}

      {mode === "change" && change && (
        <div className="mt-3 text-xs text-muted-foreground">Simulation only — proposed state is computed in memory and never written back to current entities. Added edges are green, removed edges are dashed red.</div>
      )}
    </div>
  );
}