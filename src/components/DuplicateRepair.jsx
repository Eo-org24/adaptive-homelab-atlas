import React, { useState, useRef } from "react";
import { previewRepair, runRepair } from "@/lib/duplicateRepair";
import { runImport, createBase44Adapter } from "@/lib/canonicalImport";
import { Card } from "@/components/ui-bits";
import { Wrench, Play, AlertTriangle, CheckCircle2, XCircle, Loader2, ArrowRight } from "lucide-react";

// Operator-initiated duplicate-repair panel.
// Appears when a canonical artifact is loaded. Preview is dry-run only;
// Execute remaps references, deletes verified duplicates, then re-runs the
// normal fresh-read importer to normalize canonical state.
export default function DuplicateRepair({ envelope, data, complete, disabled, onAfterRepair }) {
  const [preview, setPreview] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  const onPreview = () => {
    if (!envelope || busy) return;
    setError(""); setReport(null);
    try {
      setPreview(previewRepair(envelope, data));
    } catch (e) {
      setError(`Repair preview failed: ${e.message}`);
    }
  };

  const onExecute = async () => {
    if (!envelope || busyRef.current || busy || disabled) return;
    busyRef.current = true;
    setBusy(true); setError(""); setReport(null);
    try {
      const adapter = createBase44Adapter();
      const r = await runRepair(envelope, { adapter });
      if (!r.blocked && r.deleted.length > 0) {
        // Re-run the normal fresh-read importer to normalize canonical state.
        const reimport = await runImport(envelope, data, { adapter, complete: true });
        r.reimport = reimport;
      }
      setReport(r);
      if (!r.blocked && onAfterRepair) await onAfterRepair();
    } catch (e) {
      setError(`Repair failed: ${e.message}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!envelope) return null;

  const hasEligible = preview && preview.ready && preview.ready.length > 0;

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
          <div className="text-xs font-medium">
            {report.blocked ? (
              <span className="text-rose-500">Repair blocked: {report.blockedReason}</span>
            ) : (
              <span className="text-emerald-500">Repair complete</span>
            )}
          </div>
          {!report.blocked && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <RepairStat label="Deleted" value={report.deleted.length} tone="rose" icon={XCircle} />
                <RepairStat label="Remapped" value={report.remapped.length} tone="sky" icon={CheckCircle2} />
                {report.reimport && (
                  <RepairStat label="Re-import created" value={report.reimport.counts?.created || 0} tone="emerald" icon={CheckCircle2} />
                )}
              </div>
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
              {report.reimport && (
                <div className="text-xs text-muted-foreground">
                  Post-repair import: created={report.reimport.counts?.created || 0}, updated={report.reimport.counts?.updated || 0},
                  unchanged={report.reimport.counts?.unchanged || 0}, duplicates={report.reimport.counts?.conflicts || 0}
                </div>
              )}
            </>
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