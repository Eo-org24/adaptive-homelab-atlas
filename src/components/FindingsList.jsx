import React from "react";
import { useNavigate } from "react-router-dom";
import { AlertOctagon, AlertTriangle, AlertCircle, Info, CircleDot } from "lucide-react";

const SEV = {
  critical: { icon: AlertOctagon, color: "text-rose-500" },
  high: { icon: AlertTriangle, color: "text-orange-500" },
  medium: { icon: AlertCircle, color: "text-amber-500" },
  low: { icon: CircleDot, color: "text-sky-500" },
  info: { icon: Info, color: "text-muted-foreground" },
};

const ROUTE = {
  workload: "/workloads", node: "/nodes", environment: "/environments",
  dependency: "/dependencies", maintenance: "/maintenance", task: "/tasks",
  storage: "/storage", network_device: "/network",
};

export default function FindingsList({ findings }) {
  const navigate = useNavigate();
  if (!findings || !findings.length) return <p className="text-sm text-muted-foreground">No findings.</p>;
  return (
    <ul className="space-y-2">
      {findings.map((f, i) => {
        const s = SEV[f.severity] || SEV.info;
        const Icon = s.icon;
        const go = ROUTE[f.affected_type] ? () => navigate(`${ROUTE[f.affected_type]}?focus=${f.affected_id}`) : null;
        return (
          <li key={i} className="rounded-md border border-border p-3">
            <div className="flex items-start gap-2">
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.color}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono text-muted-foreground">{f.code}</span>
                  <span className="text-sm font-medium">{f.title}</span>
                  {f.affected_name && go && (
                    <button onClick={go} className="text-xs text-sky-500 hover:underline truncate max-w-[40ch]">{f.affected_name}</button>
                  )}
                  {!f.data_sufficient && <span className="text-[10px] text-muted-foreground italic">insufficient data</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{f.explanation}</p>
                {f.evidence && f.evidence.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {f.evidence.map((e, j) => <li key={j} className="text-[11px] text-muted-foreground/80 font-mono">· {e}</li>)}
                  </ul>
                )}
                {f.suggested_action && <p className="text-[11px] mt-1 text-emerald-600 dark:text-emerald-400">→ {f.suggested_action}</p>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}