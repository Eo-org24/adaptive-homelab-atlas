import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { SpecGrid, Section } from "@/components/Related";
import RefByType, { TypeSelect } from "@/components/RefByType";
import { StatusBadge } from "@/lib/homelab";

const KIND_TONE = { hard: "rose", soft: "amber", optional: "zinc" };
const COLUMNS = [
  { key: "source_name", label: "Source", render: (r) => <span className="text-xs">{r.source_name || "—"}</span> },
  { key: "source_type", label: "Src type", render: (r) => <span className="text-xs capitalize">{(r.source_type || "").replace(/_/g, " ")}</span> },
  { key: "target_name", label: "Target", className: "font-medium", render: (r) => <span className="text-xs">{r.target_name || "—"}</span> },
  { key: "target_type", label: "Tgt type", render: (r) => <span className="text-xs capitalize">{(r.target_type || "").replace(/_/g, " ")}</span> },
  { key: "kind", label: "Kind", render: (r) => <StatusBadge value={r.kind} tone={KIND_TONE[r.kind] || "zinc"} /> },
];

export default function Dependencies() {
  const { data } = useAllEntities(["Node", "Workload", "ExecutionEnvironment", "NetworkDevice", "StorageDevice"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const network = data.NetworkDevice || [];
  const storage = data.StorageDevice || [];

  const optionsFor = useMemo(() => ({
    workload: workloads.map((w) => ({ value: w.id, label: w.name })),
    environment: envs.map((e) => ({ value: e.id, label: e.name })),
    node: nodes.map((n) => ({ value: n.id, label: n.hostname })),
    network_service: network.map((d) => ({ value: d.id, label: d.name })),
    storage: storage.map((s) => ({ value: s.id, label: `${s.model}` })),
  }), [nodes, workloads, envs, network, storage]);

  const fieldOverrides = {
    source_type: (ctx) => <TypeSelect {...ctx} idField="source_id" nameField="source_name" />,
    source_id: ({ value, set, label, isReq }) => (
      <RefByType value={value} typeValue={value.source_type || "workload"} idField="source_id" nameField="source_name"
        optionsFor={(t) => optionsFor[t] || []}
        onChange={(patch) => Object.entries(patch).forEach(([k, v]) => set(k, v))}
        label={label} isReq={isReq} />
    ),
    target_type: (ctx) => <TypeSelect {...ctx} idField="target_id" nameField="target_name" />,
    target_id: ({ value, set, label, isReq }) => (
      <RefByType value={value} typeValue={value.target_type || "workload"} idField="target_id" nameField="target_name"
        optionsFor={(t) => optionsFor[t] || []} freeFor={["external"]}
        onChange={(patch) => Object.entries(patch).forEach(([k, v]) => set(k, v))}
        label={label} isReq={isReq} placeholder="External service name" />
    ),
  };

  const detailRender = (d) => (
    <div className="space-y-4">
      <SpecGrid fields={[
        { label: "Source", value: `${d.source_name || "—"} (${(d.source_type || "").replace(/_/g, " ")})` },
        { label: "Target", value: `${d.target_name || "—"} (${(d.target_type || "").replace(/_/g, " ")})` },
        { label: "Kind", value: <StatusBadge value={d.kind} tone={KIND_TONE[d.kind] || "zinc"} /> },
      ]} />
      {d.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{d.notes}</p></Section>}
    </div>
  );

  return (
    <EntityCrudPage
      entityName="Dependency"
      title="Dependencies"
      description="Recorded relationships between workloads, environments, nodes, storage and external services."
      columns={COLUMNS}
      searchKeys={["source_name", "target_name", "notes"]}
      filters={[
        { key: "kind", label: "Kind", options: ["hard", "soft", "optional"].map((v) => ({ value: v })) },
        { key: "source_type", label: "Source", options: ["workload", "environment", "node"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
        { key: "target_type", label: "Target", options: ["workload", "environment", "node", "network_service", "storage", "external"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
      ]}
      fieldOverrides={fieldOverrides}
      hidden={["source_name", "target_name"]}
      exportColumns={[
        { label: "Source", get: (r) => r.source_name },
        { label: "Source type", get: (r) => r.source_type },
        { label: "Target", get: (r) => r.target_name },
        { label: "Target type", get: (r) => r.target_type },
        { label: "Kind", get: (r) => r.kind },
      ]}
      detailRender={detailRender}
    />
  );
}