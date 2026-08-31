import React, { useMemo, useState } from "react";
import { useArchitectureDataset } from "@/hooks/useArchitectureDataset";
import { runHealthChecks, findingsBySeverity } from "@/lib/healthEngine";
import FindingsList from "@/components/FindingsList";
import { PageHeader, Card, StatCard } from "@/components/ui-bits";
import { AlertOctagon, AlertTriangle, AlertCircle, Info, CheckCircle2, DatabaseZap } from "lucide-react";

const LOAD = ["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "StoragePool", "NetworkDevice", "Dependency", "Maintenance", "Task", "PlannedChange", "Decision"];

const SECTIONS = [
  { key: "RELATIONSHIPS", title: "Relationships", cats: ["relationship", "identity"] },
  { key: "CAPACITY", title: "Capacity", cats: ["capacity", "availability"] },
  { key: "DEPENDENCIES", title: "Dependencies", cats: ["dependency"] },
  { key: "PROVENANCE", title: "Provenance", cats: ["provenance"] },
  { key: "CANONICAL_SYNC", title: "Canonical sync", cats: ["data_quality"] },
  { key: "PLANNED_STATE", title: "Planned state / change risk", cats: ["change_risk", "lifecycle"] },
  { key: "ORPHANS", title: "Orphans", codes: ["ORPHANED_ENV"] },
  { key: "STALE_DATA", title: "Stale data", codes: ["STALE_OBSERVATION", "NO_OBSERVATION"] },
];

const OBJECT_TYPES = ["node", "workload", "environment", "dependency", "maintenance", "task", "storage", "storage_pool", "network_device", "planned_change", "decision"];

export default function Findings() {
  const { data, complete, errors, incompleteEntities, loading } = useArchitectureDataset(LOAD);
  const findings = useMemo(() => runHealthChecks(data), [data]);
  const bySev = useMemo(() => findingsBySeverity(findings), [findings]);
  const [sev, setSev] = useState("all");
  const [cat, setCat] = useState("all");
  const [objType, setObjType] = useState("all");
  const [canonicalOnly, setCanonicalOnly] = useState(false);
  const [q, setQ] = useState("");

  const cats = useMemo(() => Array.from(new Set(findings.map((f) => f.category))).sort(), [findings]);
  const totalObjects = useMemo(() => LOAD.reduce((s, k) => s + (data[k] || []).length, 0), [data]);
  const affectedObjectIds = useMemo(() => new Set(findings.map((f) => f.affected_id).filter(Boolean)), [findings]);
  const cleanObjects = Math.max(0, totalObjects - affectedObjectIds.size);

  const shown = findings.filter((f) => {
    if (sev !== "all" && f.severity !== sev) return false;
    if (cat !== "all" && f.category !== cat) return false;
    if (objType !== "all" && f.affected_type !== objType) return false;
    if (canonicalOnly && !f.affected_canonical_id) return false;
    if (q.trim()) {
      const s = q.toLowerCase();
      if (!(`${f.code} ${f.title} ${f.explanation} ${f.affected_name || ""}`.toLowerCase().includes(s))) return false;
    }
    return true;
  });

  if (loading) return <div className="p-6"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin mx-auto mt-20" /></div>;

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <PageHeader title="Data Quality & Integrity" description="Deterministic findings derived from documented relationships and state. No live monitoring — findings reflect only the data Atlas holds, and say 'insufficient data' where they cannot decide." />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <StatCard label="Errors" value={bySev.critical.length + bySev.error.length} icon={AlertOctagon} tone="rose" />
        <StatCard label="Warnings" value={bySev.warning.length} icon={AlertTriangle} tone="amber" />
        <StatCard label="Info / unknown" value={bySev.info.length} icon={Info} tone="zinc" />
        <StatCard label="Clean objects" value={cleanObjects} icon={CheckCircle2} tone="emerald" />
        <StatCard label="Total objects" value={totalObjects} icon={AlertCircle} tone="sky" />
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-4 text-xs">
        <select value={sev} onChange={(e) => setSev(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5">
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info / unknown</option>
        </select>
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5">
          <option value="all">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={objType} onChange={(e) => setObjType(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5">
          <option value="all">All object types</option>
          {OBJECT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={canonicalOnly} onChange={(e) => setCanonicalOnly(e.target.checked)} /> canonical only</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter text…" className="rounded-md border border-input bg-background px-2 py-1.5 flex-1 min-w-[120px]" />
        <span className="text-muted-foreground">{shown.length} finding{shown.length !== 1 ? "s" : ""}</span>
      </div>

      {sev === "all" && cat === "all" && objType === "all" && !canonicalOnly && !q.trim() ? (
        <div className="space-y-4">
          {SECTIONS.map((sec) => {
            const items = findings.filter((f) =>
              (sec.cats ? sec.cats.includes(f.category) : false) || (sec.codes ? sec.codes.includes(f.code) : false)
            );
            if (!items.length) return null;
            return (
              <Card key={sec.key} className="p-4">
                <h3 className="text-sm font-medium mb-3">{sec.title} <span className="text-muted-foreground">({items.length})</span></h3>
                <FindingsList findings={items} />
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="p-4">
          {shown.length ? <FindingsList findings={shown} /> : <p className="text-sm text-muted-foreground py-6 text-center">No findings match the current filters.</p>}
        </Card>
      )}
    </div>
  );
}