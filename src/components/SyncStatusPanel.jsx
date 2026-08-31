import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Card } from "@/components/ui-bits";
import { CheckCircle2, AlertTriangle, CircleDot, Clock, GitBranch, Database, RefreshCw } from "lucide-react";

const STATE_LABEL = {
  never_imported: "Never imported",
  synchronized: "Synchronized",
  local_additions: "Local additions",
  import_warnings: "Import warnings",
  import_blocked: "Import blocked",
  partial_failure: "Partial failure",
  stale: "Stale",
};
const STATE_TONE = {
  never_imported: "text-muted-foreground",
  synchronized: "text-emerald-500",
  local_additions: "text-sky-500",
  import_warnings: "text-amber-500",
  import_blocked: "text-rose-500",
  partial_failure: "text-rose-500",
  stale: "text-amber-500",
};

export default function SyncStatusPanel() {
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = await base44.entities.CanonicalSync.list();
      setMeta(list[0] || null);
    } catch { setMeta(null); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const state = meta?.sync_state || "never_imported";
  const report = (() => { try { return meta?.last_report ? JSON.parse(meta.last_report) : null; } catch { return null; } })();

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Canonical Source / Sync Status</h3>
        <button onClick={load} className="text-muted-foreground hover:text-foreground"><RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /></button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
        <Field icon={GitBranch} label="Canonical source" value={meta?.source_repository || "homelab-foundation"} />
        <Field icon={Clock} label="Last canonical import" value={meta?.last_import_at ? new Date(meta.last_import_at).toLocaleString() : "Never"} />
        <Field icon={GitBranch} label="Source commit" value={meta?.source_commit || "—"} mono />
        <Field icon={Database} label="Source schema" value={meta?.schema_version || "—"} mono />
        <Field icon={CheckCircle2} label="Imported objects" value={meta?.imported_count ?? 0} />
        <Field icon={CircleDot} label="Atlas-local objects" value={meta?.atlas_local_count ?? 0} />
        <Field icon={AlertTriangle} label="Import warnings" value={meta?.warning_count ?? 0} />
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Sync state</div>
          <div className={`text-sm font-medium mt-0.5 ${STATE_TONE[state]}`}>{STATE_LABEL[state]}</div>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mt-3">
        One-way projection: canonical repository → Atlas. Atlas does not write back to the repository and never mutates infrastructure.
      </p>
      {report && (
        <div className="mt-2 text-[11px] text-muted-foreground font-mono">
          last report: {report.created} created · {report.updated} updated · {report.unchanged} unchanged · {report.failed} failed · {report.unresolved} unresolved · {report.conflicts} conflicts
        </div>
      )}
    </Card>
  );
}

function Field({ icon: Icon, label, value, mono }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1"><Icon className="w-3 h-3" />{label}</div>
      <div className={`text-sm mt-0.5 truncate ${mono ? "font-mono" : ""}`} title={value}>{value}</div>
    </div>
  );
}