import React, { useState, useEffect } from "react";
import { previewRepair, runRepair, artifactPreviewKey } from "@/lib/duplicateRepair";
import { runImport, createBase44Adapter } from "@/lib/canonicalImport";
import { Card } from "@/components/ui-bits";
import { Wrench, Play, AlertTriangle, CheckCircle2, XCircle, Loader2, ArrowRight, AlertCircle, RefreshCw } from "lucide-react";

// Operator-initiated duplicate-repair panel.
// C5: Uses the PARENT's shared mutation lock — no independent mutation authority.
// C4: Honest partial failure — shows successful writes even when partial,
//     never displays "Repair complete" for a partial repair,
//     refreshes parent dataset after ANY repair attempt that may have written.
export default function DuplicateRepair({ envelope, data, complete, disabled, busy, acquireLock, releaseLock, onAfterRepair }) {
  const [preview, setPreview] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  // F5: Track the artifact key that the current preview/report is bound to.
  const [previewKey, setPreviewKey] = useState("");
  const currentKey = envelope ? artifactPreviewKey(envelope) : "";

  // F5: When the artifact changes, clear old preview and report.
  // The new artifact requires its own dry-run preview before Execute Repair.
  useEffect(() => {
    if (previewKey && previewKey !== currentKey) {
      setPreview(null);
      setReport(null);
      setError("");
      setRefreshError("");
    }
  }, [currentKey, previewKey]);

  const onPreview = () => {
    if (!envelope || busy || disabled) return;
    setError(""); setReport(null); setRefreshError("");
    try {
      const p = previewRepair(envelope, data);
      setPreview(p);
      // F5: Bind preview to the current artifact key
      setPreviewKey(currentKey);
    } catch (e) {
      setError(`Repair preview failed: ${e.message}`);
    }
  };

  const onExecute = async () => {
    if (!envelope || busy || disabled) return;
    // F5: Verify preview key corresponds to the current artifact
    if (previewKey !== currentKey) return;
    // C5: Acquire the shared lock synchronously before the first await
    if (!acquireLock()) return;
    setError(""); setReport(null); setRefreshError("");
    try {
      const adapter = createBase44Adapter();
      const r = await runRepair(envelope, { adapter });

      // If repair succeeded (not blocked, not partial), run re-import to normalize
      if (!r.blocked && !r.partial && r.deleted.length > 0) {
        try {
          const reimport = await runImport(envelope, data, { adapter, complete: true });
          r.reimport = reimport;
          // C4: If re-import failed, mark recovery-required — do NOT report success
          if (reimport.blocked || reimport.partial || reimport.sync_state === "import_blocked" || reimport.sync_state === "partial_failure") {
            r.recoveryRequired = true;
          }
        } catch (e) {
          r.reimportError = e.message;
          r.recoveryRequired = true;
        }
      }

      setReport(r);
      // F8: Separate mutation from page-dataset refresh. If the mutation succeeded
      // but the refresh fails, show a distinct warning — do NOT label it "Repair failed".
      if (!r.blocked || r.remapped.length > 0 || r.deleted.length > 0) {
        if (onAfterRepair) {
          try {
            await onAfterRepair();
          } catch (e) {
            setRefreshError(`Page dataset refresh failed: ${e.message}. The repair itself succeeded — please reload the page to see updated data.`);
          }
        }
      }
    } catch (e) {
      setError(`Repair failed: ${e.message}`);
    } finally {
      // C5: Release the shared lock in finally
      releaseLock();
    }
  };

  if (!envelope) return null;

  // F5: hasEligible requires the preview to be bound to the current artifact key
  const hasEligible = preview && preview.ready && preview.ready.length > 0 && previewKey === currentKey;
  const isPartial = report && (report.partial || report.recoveryRequired);
  const isComplete = report && !report.blocked && !report.partial && !report.recoveryRequired;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <Wrench className="w-4 h-4 text-amber-500" />
        <h3 className="text-sm font-medium">Duplicate repair</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Operator-initiated recovery for duplicate canonical records. Only canonical IDs in the loaded artifact
        are eligible. Normal import remains fail-closed while duplicates exist.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onPreview}
          disabled={busy || disabled}
          className="inline-flex items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <AlertTriangle className="w-3.5 h-3.5" /> Preview repair (dry-run)
        </button>
        <button
          onClick={onExecute}
          disabled={busy || disabled || !hasEligible}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary/90 disabled:opacity-50"
          title={!hasEligible ? "Preview first to verify eligible groups" : ""}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Execute repair + re-import
        </button>
      </div>
      {error && (
        <div className="mt-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {preview && preview.validationErrors && (
        <div className="mt-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          <span className="font-medium">Artifact validation failed:</span>
          <ul className="mt-1 space-y-0.5">
            {preview.validationErrors.slice(0, 5).map((e, i) => <li key={i}>· {e}</li>)}
          </ul>
        </div>
      )}

      {preview && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <RepairStat label="Duplicate groups" value={preview.groups.length} tone="amber" />
            <RepairStat label="Eligible" value={preview.ready.length} tone="emerald" />
            <RepairStat label="Blocked" value={preview.blocked.length} tone="rose" />
            <RepairStat label="Reference remaps" value={preview.remaps.length} tone="sky" />
          </div>

          {preview.ready.length > 0 && (
            <div>
              <div className="text-xs font-medium text-emerald-500 mb-1">Eligible groups (ready for repair)</div>
              <ul className="space-y-1 max-h-40 overflow-auto">
                {preview.ready.map((g) => (
                  <li key={g.canonical_id} className="text-xs font-mono text-muted-foreground">
                    · {g.canonical_id} ({g.entity}) — {g.memberCount} records → keeper:{" "}
                    <span className="text-emerald-500">{g.keeper.id}</span>, delete:{" "}
                    {g.deletions.map((d) => d.id).join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.blocked.length > 0 && (
            <div>
              <div className="text-xs font-medium text-rose-500 mb-1">Blocked groups (unsafe — not repaired)</div>
              <ul className="space-y-1 max-h-40 overflow-auto">
                {preview.blocked.map((g) => (
                  <li key={g.canonical_id} className="text-xs font-mono text-muted-foreground">
                    · {g.canonical_id} ({g.entity}) — {g.memberCount} records —{" "}
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
          {/* C4: Honest status — never "Repair complete" for partial */}
          <div className="text-xs font-medium">
            {report.blocked ? (
              <span className="text-rose-500">Repair blocked: {report.blockedReason}</span>
            ) : isPartial ? (
              <span className="text-rose-500 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> Recovery required — repair was partial
              </span>
            ) : isComplete ? (
              <span className="text-emerald-500">Repair complete</span>
            ) : null}
          </div>

          {/* C4: Show successful remaps/deletes even when partial */}
          {(report.remapped.length > 0 || report.deleted.length > 0) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <RepairStat label="Deleted" value={report.deleted.length} tone="rose" icon={XCircle} />
              <RepairStat label="Remapped" value={report.remapped.length} tone="sky" icon={CheckCircle2} />
              {report.reimport && (
                <RepairStat label="Re-import created" value={report.reimport.counts?.created || 0} tone="emerald" icon={CheckCircle2} />
              )}
            </div>
          )}

          {report.deleted.length > 0 && (
            <div>
              <div className="text-xs font-medium text-rose-500 mb-1">Deleted duplicate IDs</div>
              <ul className="space-y-0.5 max-h-32 overflow-auto">
                {report.deleted.map((d) => (
                  <li key={d.id} className="text-xs font-mono text-muted-foreground">
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

          {/* C4: Show failed operation details */}
          {report.failedOperation && (
            <div className="text-xs text-rose-500">
              Failed: {report.failedOperation.phase} — {report.failedOperation.operation}: {report.failedOperation.reason}
            </div>
          )}

          {/* C4: Database state uncertain */}
          {report.databaseStateUncertain && (
            <div className="text-xs text-rose-500 font-medium">
              Database state uncertain — fresh read failed after partial repair
            </div>
          )}

          {/* F6: Re-import result — use counts.ambiguous (not conflicts) for remaining duplicate identities */}
          {report.reimport && (
            <div className="text-xs text-muted-foreground">
              Post-repair import: created={report.reimport.counts?.created || 0}, updated={report.reimport.counts?.updated || 0},
              unchanged={report.reimport.counts?.unchanged || 0}, ambiguous identities={report.reimport.counts?.ambiguous || 0}
            </div>
          )}
          {report.reimportError && (
            <div className="text-xs text-rose-500">
              Post-repair import failed: {report.reimportError}
            </div>
          )}

          {/* F8: Separate page-dataset refresh failure from mutation failure */}
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

function RepairStat({ label, value, tone, icon: Icon }) {
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