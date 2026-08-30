import React, { useState, useRef } from "react";
import { PageHeader, Card } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { downloadFile, exportJSON, stateClassTone, badgeClass, StatusBadge } from "@/lib/homelab";
import { Download, Upload, Database, ShieldCheck, Layers } from "lucide-react";

const ENTITIES = ["Node", "ExecutionEnvironment", "Workload", "Dependency", "NetworkDevice", "SwitchPort", "StorageDevice", "StoragePool", "PlannedChange", "Decision", "Maintenance", "Task"];

const PROVENANCE = [
  { value: "documented", desc: "Manually entered canonical state" },
  { value: "observed", desc: "Manually observed at a point in time" },
  { value: "imported", desc: "Brought in from an external source" },
  { value: "inferred", desc: "Derived from other recorded facts" },
  { value: "planned", desc: "Intended future state — not yet real" },
];

const PRINCIPLES = [
  "Simplicity", "Reliability", "Power efficiency", "Scalability", "Performance",
];

export default function Settings() {
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef(null);

  const exportAll = async () => {
    setExporting(true);
    const bundle = {};
    await Promise.all(ENTITIES.map(async (e) => {
      try { bundle[e] = await base44.entities[e].list("-updated_date", 1000); }
      catch { bundle[e] = []; }
    }));
    downloadFile(`homelab-atlas-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2), "application/json");
    setExporting(false);
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const results = {};
      for (const entity of ENTITIES) {
        const recs = data[entity];
        if (!Array.isArray(recs) || recs.length === 0) continue;
        const clean = recs.map(({ id, created_date, updated_date, created_by_id, ...rest }) => rest);
        try {
          const created = await base44.entities[entity].bulkCreate(clean);
          results[entity] = created.length;
        } catch (err) {
          results[entity] = `error: ${err.message || "failed"}`;
        }
      }
      setImportResult(results);
    } catch (err) {
      setImportResult({ error: err.message || "Invalid JSON file" });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader title="Settings" description="Data provenance, backup, import, and application principles." />

      <Card title="Priority principles" className="p-4 mb-4">
        <p className="text-sm text-muted-foreground mb-3">The homelab is designed in this priority order. Lower numbers are never sacrificed for higher ones.</p>
        <ol className="space-y-2">
          {PRINCIPLES.map((p, i) => (
            <li key={p} className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center">{i + 1}</span>
              <span className="text-sm font-medium">{p}</span>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Data provenance legend" className="p-4 mb-4">
        <p className="text-sm text-muted-foreground mb-3">Every important state value can identify its source. Planned state is shown differently from observed/current state.</p>
        <div className="space-y-2">
          {PROVENANCE.map((p) => (
            <div key={p.value} className="flex items-center gap-3">
              <StatusBadge value={p.value} tone={stateClassTone(p.value)} />
              <span className="text-sm text-muted-foreground">{p.desc}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Backup & export" className="p-4 mb-4">
        <div className="flex items-start gap-3">
          <Database className="w-4 h-4 text-muted-foreground mt-0.5" />
          <div className="flex-1">
            <p className="text-sm">Download a complete JSON backup of every record across all entities.</p>
            <p className="text-xs text-muted-foreground mt-1">Never make this application the only copy of important architectural data — export regularly.</p>
          </div>
          <Button size="sm" onClick={exportAll} disabled={exporting}>
            <Download className="w-3.5 h-3.5 mr-1.5" />{exporting ? "Exporting…" : "Export all"}
          </Button>
        </div>
      </Card>

      <Card title="Import structured data" className="p-4 mb-4">
        <div className="flex items-start gap-3">
          <Upload className="w-4 h-4 text-muted-foreground mt-0.5" />
          <div className="flex-1">
            <p className="text-sm">Import a previously exported JSON backup. Records are appended (not replaced).</p>
            <p className="text-xs text-muted-foreground mt-1">Expected format: <code className="text-xs bg-muted px-1 py-0.5 rounded">{"{ \"EntityName\": [ { ... } ] }"}</code></p>
            <input ref={fileRef} type="file" accept="application/json" onChange={onImport} className="hidden" />
            <Button size="sm" variant="outline" className="mt-3" onClick={() => fileRef.current?.click()} disabled={importing}>
              <Upload className="w-3.5 h-3.5 mr-1.5" />{importing ? "Importing…" : "Choose JSON file"}
            </Button>
            {importResult && (
              <div className="mt-3 rounded-md border border-border p-3 text-xs">
                {importResult.error ? (
                  <span className="text-rose-500">{importResult.error}</span>
                ) : (
                  <ul className="space-y-0.5">
                    {Object.entries(importResult).map(([k, v]) => <li key={k}><span className="font-medium">{k}:</span> {String(v)}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card title="Security posture" className="p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-4 h-4 text-emerald-500 mt-0.5" />
          <div className="text-sm space-y-1.5">
            <p>Authentication is mandatory. This app contains private infrastructure metadata and exposes no unauthenticated access to inventory records.</p>
            <p className="text-muted-foreground">No passwords, SSH keys, API secrets, hypervisor/BMC/router credentials are stored. No remote infrastructure control is implemented.</p>
          </div>
        </div>
      </Card>

      <div className="mt-6 text-xs text-muted-foreground flex items-center gap-2">
        <Layers className="w-3.5 h-3.5" /> Adaptive Homelab Atlas — documentation, planning & capacity tooling (not remote administration).
      </div>
    </div>
  );
}