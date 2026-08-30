import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAllEntities } from "@/hooks/useEntities";
import { runHealthChecks } from "@/lib/healthEngine";
import { Section } from "@/components/Related";

const LOAD = ["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "StoragePool", "NetworkDevice", "Dependency", "Maintenance", "Task", "PlannedChange", "Decision"];

// Findings relevant to a specific object: direct affected match, canonical match, or evidence mention.
export default function ObjectFindings({ type, id, canonicalId }) {
  const { data } = useAllEntities(LOAD);
  const navigate = useNavigate();
  const findings = useMemo(() => runHealthChecks(data), [data]);
  const relevant = useMemo(() => findings.filter((f) => {
    if (f.affected_id && f.affected_id === id) return true;
    if (canonicalId && f.affected_canonical_id === canonicalId) return true;
    if ((f.evidence || []).some((e) => typeof e === "string" && (e.includes(id) || (canonicalId && e.includes(canonicalId))))) return true;
    return false;
  }), [findings, id, canonicalId]);

  if (!relevant.length) return null;
  const dot = (s) => s === "critical" || s === "error" ? "bg-rose-500" : s === "warning" ? "bg-amber-500" : "bg-muted-foreground";
  return (
    <Section title={`Findings (${relevant.length})`}>
      <ul className="space-y-1.5">
        {relevant.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dot(f.severity)}`} />
            <div className="min-w-0">
              <span className="font-mono text-[10px] text-muted-foreground">{f.code}</span> <span className="font-medium">{f.title}</span>
              <p className="text-muted-foreground">{f.explanation}</p>
            </div>
          </li>
        ))}
      </ul>
      <button onClick={() => navigate("/findings")} className="text-[11px] text-sky-500 hover:underline mt-2">View on Data Quality page</button>
    </Section>
  );
}