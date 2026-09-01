import React, { useState, useRef, useCallback } from "react";
import { useArchitectureDataset } from "@/hooks/useArchitectureDataset";
import { validateEnvelope, previewImport, runImport, SAMPLE_ENVELOPE, GOLDEN_CROSSOVER, COMPREHENSIVE_V1_FIXTURE, REAL_CROSSOVER_ARTIFACT } from "@/lib/canonicalImport";
import { overrideConflicts } from "@/lib/provenance";
import SyncStatusPanel from "@/components/SyncStatusPanel";
import DuplicateRepair from "@/components/DuplicateRepair";
import { PageHeader, Card } from "@/components/ui-bits";
import { Upload, Play, FileWarning, CheckCircle2, AlertTriangle, XCircle, Loader2, Database, RefreshCw } from "lucide-react";

const LOAD = ["Node", "ExecutionEnvironment", "Workload", "Decision", "Dependency", "StorageDevice", "NetworkDevice", "StoragePool", "SwitchPort", "Task", "Maintenance", "PlannedChange"];

const STATUS_LABEL = {
  synchronized: "Import complete",
  local_additions: "Import complete · local additions retained",
  import_warnings: "Import completed with warnings",
  import_blocked: "Import blocked · no writes performed",
  partial_failure: "PARTIAL IMPORT FAILURE · recovery required",
  never_imported: "",
};
const STATUS_TONE = {
  synchronized: "text-emerald-500",
  local_additions: "text-sky-500",
  import_warnings: "text-amber-500",
  import_blocked: "text-rose-500",
  partial_failure: "text-rose-500 font-semibold",
  never_imported: "",
};

export default function CanonicalImport() {
  const { data, complete, errors, incompleteEntities, loading, refresh } = useArchitectureDataset(LOAD);
  const [text, setText] = useState("");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState([]);
  const [phase, setPhase] = useState(""); // "preview" | "imported"
  const [parsedEnv, setParsedEnv] = useState(null);
  const [refreshError, setRefreshError] = useState("");
  // C5: One shared synchronous mutation lock for normal import AND repair.
  // Acquired synchronously before the first await; released in finally.
  const busyRef = useRef(false);
  const acquireLock = useCallback(() => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);
  const releaseLock = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  const clearStale = () => { setReport(null); setError(""); setConflicts([]); setPhase(""); setParsedEnv(null); setRefreshError(""); };
  const loadText = (t) => { setText(t); clearStale(); };

  const parse = () => {
    setError(""); setReport(null);
    let env;
    try { env = JSON.parse(text); } catch (e) { setError(`Invalid JSON: ${e.message}`); return null; }
    const v = validateEnvelope(env);
    if (!v.valid) { setError(v.errors.join(" ")); return null; }
    setParsedEnv(env);
    return env;
  };

  const onPreview = () => {
    if (busy || loading || incomplete) return;
    const env = parse(); if (!env) return;
    const r = previewImport(env, data, { complete });
    setReport(r); setPhase("preview"); setConflicts(overrideConflicts(env, data));
  };

  const onRun = async () => {
    if (busyRef.current || busy || loading || incomplete) return;
    const env = parse(); if (!env) return;
    if (!acquireLock()) return;
    setPhase(""); setRefreshError("");
    try {
      const r = await runImport(env, data, { complete });
      setReport(r); setPhase("imported"); setConflicts(overrideConflicts(env, data));
      // F8/R7: Separate mutation from page-dataset refresh. If the mutation
      // succeeded but the refresh fails, show a distinct warning. The wording
      // MUST be honest about the mutation result: if the import was partial or
      // recovery-required, the warning MUST NOT say "the import itself succeeded"
      // — instead it says the mutation result above is authoritative, it is
      // partial/recovery-required, and the page refresh additionally failed.
      if (!r.blocked) {
        try {
          await refresh();
        } catch (e) {
          if (r.partial || r.sync_state === "partial_failure") {
            setRefreshError(`Page dataset refresh failed: ${e.message}. The import result above is authoritative (partial/recovery-required). Please reload or retry refresh before trusting the displayed page dataset.`);
          } else {
            setRefreshError(`Page dataset refresh failed: ${e.message}. The import itself succeeded — please reload the page to see updated data.`);
          }
        }
      }
    } catch (e) {
      setError(`Import failed: ${e.message}`);
    } finally {
      releaseLock();
    }
  };

  const onFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result));
    reader.readAsText(f);
  };

  const c = report?.counts || {};
  const syncState = report?.sync_state || "";
  const incomplete = !loading && !complete;

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-5">
      <PageHeader title="Canonical Import" description="One-way projection from the homelab-foundation canonical repository. Idempotent: upserts by canonical_id — never duplicates, never mutates infrastructure." />

      <SyncStatusPanel />

      {incomplete && (
        <Card className="p-4 border-rose-500/30 bg-rose-500/5">
          <div className="flex items-start gap-2">
            <Database className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-rose-600 dark:text-rose-400">DATASET INCOMPLETE</div>
              <p className="text-xs text-muted-foreground mt-1">
                The existing-dataset load is incomplete — canonical synchronization cannot proceed safely.
                A failed or truncated fetch must never be interpreted as zero existing records.
              </p>
              {incompleteEntities.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Affected entity classes: {incompleteEntities.join(", ")}
                </p>
              )}
              {Object.keys(errors).length > 0 && (
                <ul className="text-[11px] text-muted-foreground mt-1 space-y-0.5">
                  {Object.entries(errors).map(([k, v]) => <li key={k}>· {k}: {v}</li>)}
                </ul>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium">Canonical snapshot envelope</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={busy} onClick={() => loadText(SAMPLE_ENVELOPE)} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">Load sample</button>
            <button disabled={busy} onClick={() => loadText(GOLDEN_CROSSOVER)} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">Load golden crossover</button>
            <button disabled={busy} onClick={() => loadText(COMPREHENSIVE_V1_FIXTURE)} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">Load comprehensive V1</button>
            <button disabled={busy} onClick={() => loadText(REAL_CROSSOVER_ARTIFACT)} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">Load real artifact</button>
            <label className={`text-xs flex items-center gap-1 ${busy ? "opacity-50 pointer-events-none" : "cursor-pointer text-muted-foreground hover:text-foreground"}`}>
              <Upload className="w-3.5 h-3.5" /> Upload file
              <input type="file" accept=".json,application/json" className="hidden" onChange={onFile} disabled={busy} />
            </label>
          </div>
        </div>
        <textarea
          value={text}
          onChange={(e) => loadText(e.target.value)}
          disabled={busy}
          placeholder='Paste a canonical snapshot envelope here. Must include "schema_version": "adaptive-homelab-atlas/v1".'
          className={`w-full h-64 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ${busy ? "opacity-60 cursor-not-allowed" : ""}`}
        />
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button onClick={onPreview} disabled={busy || loading || incomplete} className="inline-flex items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50" title={incomplete ? "Dataset incomplete — preview disabled" : ""}>
            <FileWarning className="w-3.5 h-3.5" /> Preview (dry-run)
          </button>
          <button onClick={onRun} disabled={busy || loading || incomplete} className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary/90 disabled:opacity-50" title={incomplete ? "Dataset incomplete — import disabled" : ""}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run import
          </button>
          {phase === "preview" && <span className="text-xs text-muted-foreground">Dry-run only — nothing was written.</span>}
          {phase === "imported" && syncState && <span className={`text-xs ${STATUS_TONE[syncState] || "text-muted-foreground"}`}>{STATUS_LABEL[syncState] || syncState}</span>}
        </div>
        {report?.blocked && report.blockedReasons?.length > 0 && (
          <div className="mt-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
            <span className="font-medium">Import blocked:</span> {report.blockedReasons.join("; ")}
          </div>
        )}
        {error && <div className="mt-3 rounded-md bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{error}</div>}
        {refreshError && (
          <div className="mt-3 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
            <RefreshCw className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{refreshError}</span>
          </div>
        )}
      </Card>

      {report && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3">Import report {phase === "preview" && "(dry-run)"}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4">
            <Count label="Created" value={c.created} tone="emerald" icon={CheckCircle2} />
            <Count label="Updated" value={c.updated} tone="sky" icon={CheckCircle2} />
            <Count label="Unchanged" value={c.unchanged} tone="zinc" icon={CheckCircle2} />
            <Count label="Failed" value={c.failed} tone="rose" icon={XCircle} />
            <Count label="Unresolved" value={c.unresolved} tone="amber" icon={AlertTriangle} />
            <Count label="Conflicts" value={c.conflicts} tone="rose" icon={XCircle} />
            <Count label="Warnings" value={c.warnings} tone="amber" icon={AlertTriangle} />
            <Count label="Relationships" value={c.relationships} tone="sky" icon={CheckCircle2} />
            <Count label="Deps created" value={c.dependencies_created} tone="emerald" icon={CheckCircle2} />
            <Count label="Deps updated" value={c.dependencies_updated} tone="sky" icon={CheckCircle2} />
            <Count label="Deps deleted" value={c.dependencies_deleted} tone="rose" icon={XCircle} />
            <Count label="Capability ambiguity" value={c.capability_findings} tone="amber" icon={AlertTriangle} />
          </div>
          <ReportSection title="Created" items={report.created} tone="emerald" render={(i) => `${i.entity}: ${i.canonical_id}`} />
          <ReportSection title="Updated" items={report.updated} tone="sky" render={(i) => `${i.entity}: ${i.canonical_id}`} />
          <ReportSection title="Unchanged" items={report.unchanged} tone="zinc" render={(i) => `${i.entity}: ${i.canonical_id}`} />
          <ReportSection title="Failed" items={report.failed} tone="rose" render={(i) => i.reason || `${i.entity}: ${i.canonical_id || ""} ${i.reason || ""}`} />
          <ReportSection title="Unresolved references" items={report.unresolved} tone="amber" render={(i) => `${i.entity} ${i.canonical_id}: ${i.field} → ${Array.isArray(i.refs) ? i.refs.join(", ") : i.ref} (${i.target || "external"})`} />
          <ReportSection title="Duplicate canonical IDs (conflicts)" items={report.conflicts} tone="rose" render={(i) => `${i.canonical_id} (first at ${Array.isArray(i.first) ? i.first.join(":") : i.first}, duplicate at ${Array.isArray(i.duplicate) ? i.duplicate.join(":") : i.duplicate})`} />
          <ReportSection title="Warnings" items={report.warnings} tone="amber" render={(i) => `${i.entity} ${i.canonical_id || ""}: ${i.field || ""} ${i.note || i.ref || ""}`} />
          <ReportSection title="Relationships resolved" items={report.relationships} tone="sky" render={(i) => `${i.source} —${i.type}→ ${i.target}`} />
          <ReportSection title="Dependencies created" items={report.dependencies_created} tone="emerald" render={(i) => i.relationship_key} />
          <ReportSection title="Dependencies updated" items={report.dependencies_updated} tone="sky" render={(i) => i.relationship_key} />
          <ReportSection title="Dependencies deleted (stale canonical)" items={report.dependencies_deleted} tone="rose" render={(i) => i.relationship_key} />
          <ReportSection title="Capability resolution (preserved, not resolved)" items={report.capability_findings} tone="amber" render={(i) => `${i.canonical_id}: required ${i.type} instance "${i.instance}" — ${i.resolution} (${i.note})`} />
          {conflicts.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-xs font-medium text-rose-500 mb-1">CANONICAL_LOCAL_OVERRIDE_CONFLICT ({conflicts.length})</div>
              <p className="text-[11px] text-muted-foreground mb-2">Canonical snapshot changes a field that has an Atlas-local override. The local override is preserved — operator attention required.</p>
              <ul className="space-y-1 max-h-48 overflow-auto">
                {conflicts.map((c, i) => <li key={i} className="text-xs font-mono text-muted-foreground">· {c.entity} {c.canonical_id}: <span className="text-rose-500">{c.field}</span> canonical={String(c.canonicalValue)} vs local override={String(c.localValue)}</li>)}
              </ul>
            </div>
          )}
        </Card>
      )}

      <DuplicateRepair
        envelope={parsedEnv}
        data={data}
        complete={complete}
        disabled={busy || loading || incomplete}
        busy={busy}
        acquireLock={acquireLock}
        releaseLock={releaseLock}
        onAfterRepair={refresh}
      />
    </div>
  );
}

function Count({ label, value, tone, icon: Icon }) {
  const tones = { emerald: "text-emerald-500", sky: "text-sky-500", zinc: "text-muted-foreground", rose: "text-rose-500", amber: "text-amber-500" };
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted-foreground"><Icon className={`w-3 h-3 ${tones[tone]}`} />{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

function ReportSection({ title, items, tone, render }) {
  if (!items || items.length === 0) return null;
  const tones = { emerald: "text-emerald-500", sky: "text-sky-500", zinc: "text-muted-foreground", rose: "text-rose-500", amber: "text-amber-500" };
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className={`text-xs font-medium ${tones[tone]} mb-1`}>{title} ({items.length})</div>
      <ul className="space-y-1 max-h-48 overflow-auto">
        {items.map((i, idx) => <li key={idx} className="text-xs font-mono text-muted-foreground">· {render(i)}</li>)}
      </ul>
    </div>
  );
}