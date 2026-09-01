import React, { useState, useEffect } from "react";
import { previewLegacyRecovery, runLegacyRecovery } from "@/lib/legacyRecovery";
import { createBase44Adapter } from "@/lib/canonicalImport";
import { Card } from "@/components/ui-bits";
import { ShieldAlert, Play, AlertTriangle, CheckCircle2, XCircle, Loader2, ArrowRight, AlertCircle, RefreshCw } from "lucide-react";

// Known legacy incident spec — pre-hardening canonical duplicate rows that
// predate content-digest persistence. Tightly scoped to explicit record IDs
// and explicit expected provenance. Cannot be used for arbitrary future duplicates.
const KNOWN_INCIDENT_SPEC = {
  groups: [
    {
      entity: "ExecutionEnvironment",
      canonical_id: "execution-provider:files1",
      keeperId: "6a95b7de89ed3cd85ffb4e32",
      duplicateIds: ["6a95b8095e26b8e79b8017dd"],
      expectedSourceCommit: "a1f33a877db26ed0d351113ca064791eb7f4792d",
      expectedSourceGeneratedAt: "2026-08-31T16:28:19.139523+00:00",
      expectedRepository: "homelab-foundation",
    },
    {
      entity: "ExecutionEnvironment",
      canonical_id: "execution-provider:tools1",
      keeperId: "6a95b7dff84e9b9dfb2cfc64",
      duplicateIds: ["6a95b809c2787b919a99803b"],
      expectedSourceCommit: "a1f33a877db26ed0d351113ca064791eb7f4792d",
      expectedSourceGeneratedAt: "2026-08-31T16:28:19.139523+00:00",
      expectedRepository: "homelab-foundation",
    },
  ],
};

export default function LegacyRecovery({ data, complete, disabled, busy, acquireLock, releaseLock, onAfterRepair }) {
  const [preview, setPreview] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");

  // Clear stale preview when data changes
  useEffect(() => {
    setPreview(null);
    setReport(null);
    setError("");
    setRefreshError("");
  }, [data]);

  const onPreview = () => {
    if (busy || disabled || !complete) return;
    setError(""); setReport(null); setRefreshError("");
    try {
      const p = previewLegacyRecovery(KNOWN_INCIDENT_SPEC, data);
      setPreview(p);
    } catch (e) {
      setError(`Legacy recovery preview failed: ${e.message}`);
    }
  };

  const onExecute = async () => {
    if (busy || disabled || !complete) return;
    if (!preview || preview.ready.length === 0) return;
    if (!acquireLock()) return;
    setError(""); setReport(null); setRefreshError("");
    try {
      const adapter = createBase44Adapter();
      const r = await runLegacyRecovery(KNOWN_INCIDENT_SPEC, { adapter });
      setReport(r);
      if (!r.blocked && (r.deleted.length > 0 || r.remapped.length > 0)) {
        if (onAfterRepair) {
          try {
            await onAfterRepair();
          } catch (e) {
            if (r.partial || r.recoveryRequired) {
              setRefreshError(`Page dataset refresh failed: ${e.message}. The recovery result above is authoritative (partial/recovery-required).`);
            } else {
              setRefreshError(`Page dataset refresh failed: ${e.message}. The recovery itself succeeded — please reload the page.`);
            }
          }
        }
      }
    } catch (e) {
      setError(`Legacy recovery failed: ${e.message}`);
    } finally {
      releaseLock();
    }
  };

  const hasEligible = preview && preview.ready && preview.ready.length > 0;
  const isPartial = report && (report.partial || report.recoveryRequired);
  const isComplete = report && !report.blocked && !report.partial && !report.recoveryRequired;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert className="w-4 h-4 text-rose-500" />
        <h3 className="text-sm font-medium">Legacy incident recovery</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        One-time recovery for pre-hardening canonical duplicate rows (files1, tools1) that predate
        content-digest persistence. Tightly scoped to explicit record IDs — cannot be used for
        arbitrary future duplicates. Normal duplicate repair remains strict R4.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onPreview}
          disabled={busy || disabled || !complete}
          className="inline-flex items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <AlertTriangle className="w-3.5 h-3.5" /> Preview legacy recovery (dry-run)
        </button>
        <button
          onClick={onExecute}
          disabled={busy || disabled || !complete || !hasEligible}
          className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 text-white px-3 py-1.5 text-sm hover:bg-rose-700 disabled:opacity-50"
          title={!hasEligible ? "Preview first to verify eligible groups" : ""}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Execute legacy recovery
        </button>
      </div>
      {error && (
        <div className="mt-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {preview && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <LegacyStat label="Groups" value={preview.groups.length} tone="amber" />
            <LegacyStat label="Eligible" value={preview.ready.length} tone="emerald" />
            <LegacyStat label="Blocked" value={preview.blocked.length} tone="rose" />
            <LegacyStat label="Reference remaps" value={preview.remaps.length} tone="sky" />
          </div>

          {preview.ready.length > 0 && (
            <div>
              <div className="text-xs font-medium text-emerald-500 mb-1">Eligible groups (ready for recovery)</div>
              <ul className="space-y-1 max-h-40 overflow-auto">
                {preview.ready.map((g, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground">
                    · {g.canonical_id} ({g.entity}) — keeper:{" "}
                    <span className="text-emerald-500">{g.keeper.id}</span>, delete:{" "}
                    {g.deletions.map((d) => d.id).join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.blocked.length > 0 && (
            <div>
              <div className="text-xs font-medium text-rose-500 mb-1">Blocked groups</div>
              <ul className="space-y-1 max-h-40 overflow-auto">
                {preview.blocked.map((g, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground">
                    · {g.canonical_id} ({g.entity}) —{" "}
                    <span className="text-rose-500">{g.blockedReason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.remaps.length > 0 && (
            <div>
              <div className="text-xs font-medium text-sky-500 mb-1">Proposed reference remaps</div>
              <ul className="space-y-1 max-h-40 overflow-auto">
                {preview.remaps.map((r, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground">
                    · {r.entity} {r.id}: {r.field}{" "}
                    {Array.isArray(r.oldValue) ? `[${r.oldValue.join(",")}]` : r.oldValue}{" "}
                    <ArrowRight className="w-3 h-3 inline" />{" "}
                    {Array.isArray(r.newValue) ? `[${r.newValue.join(",")}]` : r.newValue}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {report && (
        <div className="mt-4 border-t border-border pt-3 space-y-2">
          <div className="text-xs font-medium">
            {report.blocked ? (
              <span className="text-rose-500">Recovery blocked: {report.blockedReason}</span>
            ) : isPartial ? (
              <span className="text-rose-500 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> Recovery required — partial recovery
              </span>
            ) : isComplete ? (
              <span className="text-emerald-500">Legacy recovery complete</span>
            ) : null}
          </div>

          {(report.remapped.length > 0 || report.deleted.length > 0) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <LegacyStat label="Deleted" value={report.deleted.length} tone="rose" icon={XCircle} />
              <LegacyStat label="Remapped" value={report.remapped.length} tone="sky" icon={CheckCircle2} />
            </div>
          )}

          {report.deleted.length > 0 && (
            <div>
              <div className="text-xs font-medium text-rose-500 mb-1">Deleted duplicate IDs</div>
              <ul className="space-y-0.5 max-h-32 overflow-auto">
                {report.deleted.map((d, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground">
                    · {d.canonical_id} ({d.entity}): {d.id}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.remapped.length > 0 && (
            <div>
              <div className="text-xs font-medium text-sky-500 mb-1">Remapped records</div>
              <ul className="space-y-0.5 max-h-32 overflow-auto">
                {report.remapped.map((r, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground">
                    · {r.entity} {r.id}: {r.fields.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.unverifiedRemaps && report.unverifiedRemaps.length > 0 && (
            <div>
              <div className="text-xs font-medium text-amber-500 mb-1">Unverified attempted operations (database state uncertain)</div>
              <ul className="space-y-0.5 max-h-32 overflow-auto">
                {report.unverifiedRemaps.map((r, i) => (
                  <li key={i} className="text-xs font-mono text-muted-foreground">
                    · {r.entity} {r.id}: {r.fields.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.failedOperation && (
            <div className="text-xs text-rose-500">
              Failed: {report.failedOperation.phase} — {report.failedOperation.operation}: {report.failedOperation.reason}
            </div>
          )}
          {report.databaseStateUncertain && (
            <div className="text-xs text-rose-500 font-medium">
              Database state uncertain — fresh read failed after partial recovery
            </div>
          )}
          {refreshError && (
            <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <RefreshCw className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{refreshError}</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function LegacyStat({ label, value, tone, icon: Icon }) {
  const tones = {
    emerald: "text-emerald-500", sky: "text-sky-500", zinc: "text-muted-foreground",
    rose: "text-rose-500", amber: "text-amber-500",
  };
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className={`w-3 h-3 ${tones[tone]}`} />}
        {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}