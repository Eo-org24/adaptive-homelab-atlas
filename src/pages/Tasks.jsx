import React, { useState, useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import RefByType, { TypeSelect } from "@/components/RefByType";
import { fmtDate, lifecycleTone, criticalityTone, StatusBadge, typedRefName } from "@/lib/homelab";

const VIEWS = [
  { key: "all", label: "All" },
  { key: "immediate", label: "Immediate" },
  { key: "blocked", label: "Blocked" },
  { key: "experiments", label: "Experiments" },
  { key: "hardware", label: "Hardware" },
  { key: "network", label: "Network" },
  { key: "ai", label: "AI" },
  { key: "foundation", label: "Foundation" },
];

const COLUMNS = [
  { key: "task", label: "Task", className: "font-medium" },
  { key: "category", label: "Category", render: (r) => <span className="capitalize text-xs">{r.category}</span> },
  { key: "priority", label: "Priority", render: (r) => <StatusBadge value={r.priority} tone={criticalityTone(r.priority)} /> },
  { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} tone={lifecycleTone(r.status === "blocked" ? "degraded" : r.status === "completed" ? "active" : r.status)} /> },
  { key: "related_object_name", label: "Related", render: (r) => <span className="text-xs text-muted-foreground">{r.related_object_name || "—"}</span> },
  { key: "effort", label: "Effort", render: (r) => <span className="capitalize text-xs">{r.effort}</span> },
  { key: "target_date", label: "Target", render: (r) => <span className="text-xs">{fmtDate(r.target_date)}</span> },
];

export default function Tasks() {
  const [view, setView] = useState("all");
  const { data } = useAllEntities(["Node", "Workload", "ExecutionEnvironment", "NetworkDevice", "StorageDevice", "PlannedChange", "Decision"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const network = data.NetworkDevice || [];
  const storage = data.StorageDevice || [];
  const changes = data.PlannedChange || [];
  const decisions = data.Decision || [];

  const optionsFor = useMemo(() => ({
    node: nodes.map((n) => ({ value: n.id, label: n.hostname })),
    workload: workloads.map((w) => ({ value: w.id, label: w.name })),
    environment: envs.map((e) => ({ value: e.id, label: e.name })),
    network_device: network.map((d) => ({ value: d.id, label: d.name })),
    storage: storage.map((s) => ({ value: s.id, label: s.model })),
    change: changes.map((c) => ({ value: c.id, label: c.title })),
    decision: decisions.map((d) => ({ value: d.id, label: `${d.decision_id} · ${d.title}` })),
  }), [nodes, workloads, envs, network, storage, changes, decisions]);

  const fieldOverrides = {
    related_object_type: (ctx) => <TypeSelect {...ctx} idField="related_object_id" nameField="related_object_name" />,
    related_object_id: ({ value, set, label, isReq }) => (
      <RefByType value={value} typeValue={value.related_object_type || "node"} idField="related_object_id" nameField="related_object_name"
        optionsFor={(t) => optionsFor[t] || []}
        onChange={(patch) => Object.entries(patch).forEach(([k, v]) => set(k, v))}
        label={label} isReq={isReq} />
    ),
  };

  const enrich = useMemo(() => (t) => ({
    ...t,
    related_object_name: typedRefName(t.related_object_type, t.related_object_id, data),
  }), [data]);

  const detailRender = (t, { goTo }) => (
    <div className="space-y-4">
      <SpecGrid fields={[
        { label: "Category", value: t.category },
        { label: "Priority", value: <StatusBadge value={t.priority} tone={criticalityTone(t.priority)} /> },
        { label: "Status", value: <StatusBadge value={t.status} tone={lifecycleTone(t.status)} /> },
        { label: "Effort", value: t.effort },
        { label: "Target date", value: fmtDate(t.target_date) },
        { label: "Related object", value: t.related_object_name || "—" },
        { label: "Dependency", value: t.dependency },
      ]} />
      {t.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{t.notes}</p></Section>}
    </div>
  );

  return (
    <div>
      <div className="px-6 pt-4 max-w-[1600px] mx-auto">
        <div className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                view === v.key ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >{v.label}</button>
          ))}
        </div>
      </div>
      <EntityCrudPage
        key={view}
        entityName="Task"
        title="Tasks"
        description="Lightweight homelab task tracker with focused working views."
        columns={COLUMNS}
        searchKeys={["task", "notes", "related_object_name"]}
        filters={[
          { key: "status", label: "Status", options: ["backlog", "ready", "blocked", "active", "verify", "completed", "abandoned"].map((v) => ({ value: v })) },
          { key: "priority", label: "Priority", options: ["low", "medium", "high", "critical"].map((v) => ({ value: v })) },
        ]}
        initialFilters={view === "all" ? {} : { category: view }}
        exportColumns={[
          { label: "Task", get: (r) => r.task },
          { label: "Category", get: (r) => r.category },
          { label: "Priority", get: (r) => r.priority },
          { label: "Status", get: (r) => r.status },
          { label: "Related", get: (r) => r.related_object_name },
          { label: "Effort", get: (r) => r.effort },
          { label: "Target", get: (r) => r.target_date },
        ]}
        fieldOverrides={fieldOverrides}
        enrich={enrich}
        detailRender={detailRender}
      />
    </div>
  );
}