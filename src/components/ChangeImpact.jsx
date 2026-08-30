import React, { useMemo, useState } from "react";
import { analyzeChange, OP_TYPES } from "@/lib/changeSandbox";
import { fmtGB } from "@/lib/homelab";
import { Section } from "@/components/Related";
import { base44 } from "@/api/base44Client";
import { Plus, X, FlaskConical } from "lucide-react";

const SEL = "rounded-md border border-input bg-background px-2 py-1 text-xs";

export default function ChangeImpact({ change, data }) {
  const [ops, setOps] = useState(change.operations || []);
  const [draft, setDraft] = useState({ type: "MOVE_WORKLOAD" });
  const [busy, setBusy] = useState(false);

  const analysis = useMemo(() => analyzeChange(data, { ...change, operations: ops }), [data, change, ops]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];

  const persist = async (newOps) => {
    setBusy(true);
    try { await base44.entities.PlannedChange.update(change.id, { operations: newOps }); setOps(newOps); }
    catch { /* ignore */ }
    setBusy(false);
  };
  const addOp = () => { if (draft.type) { persist([...ops, cleanDraft(draft)]); setDraft({ type: draft.type }); } };
  const removeOp = (i) => persist(ops.filter((_, j) => j !== i));

  return (
    <div className="space-y-4">
      <Section title="Structured operations (proposed state — simulation only)">
        {ops.length === 0 ? <p className="text-xs text-muted-foreground">No structured operations. Add one to simulate impact. Operations are never executed.</p> : (
          <ul className="space-y-1">
            {ops.map((o, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-[10px] text-muted-foreground">{o.type}</span>
                <span className="text-muted-foreground truncate flex-1">{describeOp(o, { nodes, workloads, envs })}</span>
                <button onClick={() => removeOp(i)} className="text-muted-foreground hover:text-rose-500"><X className="w-3 h-3" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <select value={draft.type} onChange={(e) => setDraft({ type: e.target.value })} className={SEL}>
            {OP_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
          {draft.type === "MOVE_WORKLOAD" && <>
            <Labeled label="workload"><select className={SEL} value={draft.workload_id || ""} onChange={(e) => setDraft({ ...draft, workload_id: e.target.value })}><option value="">—</option>{workloads.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Labeled>
            <Labeled label="to env"><select className={SEL} value={draft.to_environment_id || ""} onChange={(e) => setDraft({ ...draft, to_environment_id: e.target.value })}><option value="">—</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Labeled>
          </>}
          {draft.type === "CHANGE_EXECUTION_HOST" && <>
            <Labeled label="env"><select className={SEL} value={draft.environment_id || ""} onChange={(e) => setDraft({ ...draft, environment_id: e.target.value })}><option value="">—</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Labeled>
            <Labeled label="to node"><select className={SEL} value={draft.to_node_id || ""} onChange={(e) => setDraft({ ...draft, to_node_id: e.target.value })}><option value="">—</option>{nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}</option>)}</select></Labeled>
          </>}
          {draft.type === "CHANGE_RESOURCE_ALLOCATION" && <>
            <Labeled label="env"><select className={SEL} value={draft.environment_id || ""} onChange={(e) => setDraft({ ...draft, environment_id: e.target.value })}><option value="">—</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Labeled>
            <Labeled label="RAM GB"><input type="number" className={SEL} value={draft.ram_gb ?? ""} onChange={(e) => setDraft({ ...draft, ram_gb: e.target.value ? Number(e.target.value) : null })} /></Labeled>
          </>}
          {draft.type === "RETIRE_NODE" && <Labeled label="node"><select className={SEL} value={draft.node_id || ""} onChange={(e) => setDraft({ ...draft, node_id: e.target.value })}><option value="">—</option>{nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}</option>)}</select></Labeled>}
          {draft.type === "CHANGE_LIFECYCLE" && <>
            <Labeled label="type"><select className={SEL} value={draft.object_type || "node"} onChange={(e) => setDraft({ ...draft, object_type: e.target.value })}><option value="node">node</option><option value="workload">workload</option><option value="environment">environment</option></select></Labeled>
            <Labeled label="lifecycle"><select className={SEL} value={draft.lifecycle || "retired"} onChange={(e) => setDraft({ ...draft, lifecycle: e.target.value })}>{["planned", "active", "maintenance", "degraded", "retiring", "retired"].map((v) => <option key={v} value={v}>{v}</option>)}</select></Labeled>
          </>}
          <button onClick={addOp} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"><Plus className="w-3 h-3" /> Add</button>
        </div>
      </Section>

      <Section title="Impact analysis (simulated)">
        {analysis.error ? <p className="text-xs text-rose-500">Simulation error: {analysis.error}</p> : (
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-2">
              <Stat label="New findings" value={analysis.newFindings.length} tone="text-rose-500" />
              <Stat label="Resolved" value={analysis.resolvedFindings.length} tone="text-emerald-500" />
              <Stat label="Unchanged" value={analysis.unchanged.length} tone="text-muted-foreground" />
              <Stat label="Unknown impacts" value={analysis.unknownImpacts.length} tone="text-amber-500" />
            </div>
            {analysis.resourceDelta.length > 0 && (
              <div className="text-xs mb-2">
                <div className="text-[11px] uppercase text-muted-foreground mb-1">Resource delta</div>
                {analysis.resourceDelta.map((d) => (
                  <div key={d.node.id} className="font-mono">{d.node.hostname}: RAM {fmtGB(d.before.ram)} → {fmtGB(d.after.ram)} (Δ {d.ramDelta >= 0 ? "+" : ""}{fmtGB(d.ramDelta)}), CPU {d.before.cpu} → {d.after.cpu} (Δ {d.cpuDelta >= 0 ? "+" : ""}{d.cpuDelta})</div>
                ))}
              </div>
            )}
            {analysis.newFindings.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] uppercase text-rose-500 mb-1">New findings in proposed state</div>
                <ul className="space-y-1">{analysis.newFindings.map((f, i) => <li key={i} className="text-xs"><span className="font-mono text-[10px] text-muted-foreground">{f.code}</span> {f.title} <span className="text-muted-foreground">— {f.explanation}</span></li>)}</ul>
              </div>
            )}
            {analysis.resolvedFindings.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] uppercase text-emerald-500 mb-1">Resolved by this change</div>
                <ul className="space-y-1">{analysis.resolvedFindings.map((f, i) => <li key={i} className="text-xs"><span className="font-mono text-[10px] text-muted-foreground">{f.code}</span> {f.title}</li>)}</ul>
              </div>
            )}
            {analysis.unknownImpacts.length > 0 && (
              <div className="mt-2 text-xs text-amber-600 dark:text-amber-400"><span className="font-medium">Unknown impacts:</span> {analysis.unknownImpacts.map((u) => u.type.replace(/_/g, " ")).join(", ")} — not deterministically modelable.</div>
            )}
            <div className="mt-2 text-[11px] text-muted-foreground">Rollback target: {analysis.rollbackTarget || "—"}</div>
            <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><FlaskConical className="w-3 h-3" /> Simulation only — current Atlas data is untouched. The absence of a finding does not prove safety.</p>
          </div>
        )}
      </Section>
    </div>
  );
}

function cleanDraft(d) { const o = { type: d.type }; Object.keys(d).forEach((k) => { if (k !== "type" && d[k] != null && d[k] !== "") o[k] = d[k]; }); return o; }
function describeOp(o, { nodes, workloads, envs }) {
  const wl = workloads.find((w) => w.id === o.workload_id);
  const env = envs.find((e) => e.id === o.environment_id || e.id === o.to_environment_id);
  const node = nodes.find((n) => n.id === o.node_id || n.id === o.to_node_id);
  if (o.type === "MOVE_WORKLOAD") return `${wl ? wl.name : o.workload_id} → env ${env ? env.name : o.to_environment_id || "?"}`;
  if (o.type === "CHANGE_EXECUTION_HOST") return `${env ? env.name : o.environment_id} → node ${node ? node.hostname : o.to_node_id || "?"}`;
  if (o.type === "CHANGE_RESOURCE_ALLOCATION") return `${env ? env.name : o.environment_id} RAM=${o.ram_gb ?? "?"}`;
  if (o.type === "RETIRE_NODE") return `retire ${node ? node.hostname : o.node_id}`;
  return o.type;
}
function Labeled({ label, children }) { return <label className="flex flex-col gap-0.5"><span className="text-[10px] text-muted-foreground">{label}</span>{children}</label>; }
function Stat({ label, value, tone }) { return <div className="rounded-md border border-border p-2"><div className="text-[11px] uppercase text-muted-foreground">{label}</div><div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div></div>; }