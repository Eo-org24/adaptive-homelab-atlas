import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import { fmtDate, fmtDateTime, outcomeTone, StatusBadge } from "@/lib/homelab";

const COLUMNS = [
  { key: "type", label: "Type", render: (r) => <span className="capitalize text-xs">{r.type}</span> },
  { key: "target_name", label: "Target", className: "font-medium" },
  { key: "timestamp", label: "When", render: (r) => <span className="text-xs">{fmtDate(r.timestamp)}</span> },
  { key: "outcome", label: "Outcome", render: (r) => <StatusBadge value={r.outcome} tone={outcomeTone(r.outcome)} /> },
  { key: "description", label: "Description", render: (r) => <span className="text-xs text-muted-foreground truncate max-w-xs block">{r.description}</span> },
];

export default function Maintenance() {
  const { data } = useAllEntities(["Node", "Workload", "StorageDevice", "NetworkDevice"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const storage = data.StorageDevice || [];
  const network = data.NetworkDevice || [];

  const refOptions = useMemo(() => {
    const byType = (type) => {
      if (type === "node") return nodes.map((n) => ({ value: n.id, label: n.hostname }));
      if (type === "workload") return workloads.map((w) => ({ value: w.id, label: w.name }));
      if (type === "storage") return storage.map((s) => ({ value: s.id, label: `${s.model}` }));
      if (type === "network_device") return network.map((d) => ({ value: d.id, label: d.name }));
      return [];
    };
    return { target_id: byType("node") };
  }, [nodes, workloads, storage, network]);

  const detailRender = (m, { goTo }) => (
    <div className="space-y-4">
      <SpecGrid fields={[
        { label: "Type", value: m.type },
        { label: "Target", value: m.target_name },
        { label: "When", value: fmtDateTime(m.timestamp) },
        { label: "Outcome", value: <StatusBadge value={m.outcome} tone={outcomeTone(m.outcome)} /> },
      ]} />
      {m.description && <Section title="Description"><p className="text-sm whitespace-pre-wrap">{m.description}</p></Section>}
      {m.before_state && <Section title="Before state"><p className="text-sm whitespace-pre-wrap">{m.before_state}</p></Section>}
      {m.actions && <Section title="Actions performed"><p className="text-sm whitespace-pre-wrap">{m.actions}</p></Section>}
      {m.after_state && <Section title="After state"><p className="text-sm whitespace-pre-wrap">{m.after_state}</p></Section>}
      {m.operator_notes && <Section title="Operator notes"><p className="text-sm whitespace-pre-wrap">{m.operator_notes}</p></Section>}
      {(m.attachments || []).length > 0 && (
        <Section title="Attachments">
          <ul className="space-y-1">{m.attachments.map((a, i) => <li key={i}><a href={a} target="_blank" rel="noreferrer" className="text-sm text-sky-500 hover:underline truncate block">{a}</a></li>)}</ul>
        </Section>
      )}
    </div>
  );

  return (
    <EntityCrudPage
      entityName="Maintenance"
      title="Maintenance"
      description="Installation, configuration, firmware, repair, migration and decommissioning records."
      columns={COLUMNS}
      searchKeys={["target_name", "description", "actions", "operator_notes"]}
      filters={[
        { key: "type", label: "Type", options: ["installation", "configuration", "firmware", "diagnostics", "repair", "upgrade", "migration", "cleaning", "decommissioning"].map((v) => ({ value: v })) },
        { key: "outcome", label: "Outcome", options: ["success", "partial", "failed", "aborted", "pending"].map((v) => ({ value: v })) },
      ]}
      exportColumns={[
        { label: "Type", get: (r) => r.type },
        { label: "Target", get: (r) => r.target_name },
        { label: "When", get: (r) => r.timestamp },
        { label: "Outcome", get: (r) => r.outcome },
        { label: "Description", get: (r) => r.description },
      ]}
      detailRender={detailRender}
    />
  );
}