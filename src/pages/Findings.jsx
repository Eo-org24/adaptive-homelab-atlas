import React, { useMemo, useState } from "react";
import { useAllEntities } from "@/hooks/useEntities";
import { runHealthChecks, findingsBySeverity } from "@/lib/healthEngine";
import FindingsList from "@/components/FindingsList";
import { PageHeader, Card, StatCard } from "@/components/ui-bits";
import { AlertOctagon, AlertTriangle, AlertCircle, CircleDot, Info } from "lucide-react";

const LOAD = ["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "StoragePool", "NetworkDevice", "Dependency", "Maintenance", "Task", "PlannedChange", "Decision"];

export default function Findings() {
  const { data, loading } = useAllEntities(LOAD);
  const findings = useMemo(() => runHealthChecks(data), [data]);
  const bySev = useMemo(() => findingsBySeverity(findings), [findings]);
  const [sev, setSev] = useState("all");
  const [cat, setCat] = useState("all");

  const cats = useMemo(() => Array.from(new Set(findings.map((f) => f.category))), [findings]);
  const shown = findings.filter((f) => (sev === "all" || f.severity === sev) && (cat === "all" || f.category === cat));

  if (loading) return <div className="p-6"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin mx-auto mt-20" /></div>;

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <PageHeader title="Architecture Health" description="Deterministic findings derived from documented relationships and state. No live monitoring — findings reflect only the data Atlas holds, and say 'insufficient data' where they cannot decide." />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <StatCard label="Critical" value={bySev.critical.length} icon={AlertOctagon} tone="rose" />
        <StatCard label="High" value={bySev.high.length} icon={AlertTriangle} tone="orange" />
        <StatCard label="Medium" value={bySev.medium.length} icon={AlertCircle} tone="amber" />
        <StatCard label="Low" value={bySev.low.length} icon={CircleDot} tone="sky" />
        <StatCard label="Info / unknown" value={bySev.info.length} icon={Info} tone="zinc" />
      </div>
      <div className="flex items-center gap-2 flex-wrap mb-4 text-xs">
        <select value={sev} onChange={(e) => setSev(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5">
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info / unknown</option>
        </select>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5">
          <option value="all">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-muted-foreground">{shown.length} finding{shown.length !== 1 ? "s" : ""}</span>
      </div>
      <Card className="p-4">
        {shown.length ? <FindingsList findings={shown} /> : <p className="text-sm text-muted-foreground py-6 text-center">No findings match the current filters.</p>}
      </Card>
    </div>
  );
}