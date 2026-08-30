import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import { fmtGB, lifecycleTone, StatusBadge } from "@/lib/homelab";

const COLUMNS = [
  { key: "name", label: "Name", className: "font-medium" },
  { key: "type", label: "Type", render: (r) => <span className="text-xs capitalize">{(r.type || "").replace(/_/g, " ")}</span> },
  { key: "current_host_name", label: "Host", render: (r) => <span className="text-xs">{r.current_host_name || "—"}</span> },
  { key: "lifecycle", label: "Lifecycle", render: (r) => <StatusBadge value={r.lifecycle} tone={lifecycleTone(r.lifecycle)} /> },
  { key: "cpu", label: "CPU", get: (r) => r.cpu_allocation, render: (r) => <span className="text-xs">{r.cpu_allocation || "—"}</span> },
  { key: "ram", label: "RAM", get: (r) => fmtGB(r.ram_allocation_gb), render: (r) => fmtGB(r.ram_allocation_gb) },
];

export default function Environments() {
  const { data } = useAllEntities(["Node", "Workload", "Maintenance"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const maintenance = data.Maintenance || [];

  const refOptions = useMemo(() => ({
    current_host: nodes.map((n) => ({ value: n.id, label: n.hostname })),
  }), [nodes]);

  const detailRender = (e, { goTo }) => (
    <div className="space-y-4">
      <SpecGrid fields={[
        { label: "Type", value: (e.type || "").replace(/_/g, " ") },
        { label: "Host", value: e.current_host_name || "—" },
        { label: "Lifecycle", value: <StatusBadge value={e.lifecycle} tone={lifecycleTone(e.lifecycle)} /> },
        { label: "CPU alloc", value: e.cpu_allocation ? `${e.cpu_allocation} cores` : "—" },
        { label: "RAM alloc", value: fmtGB(e.ram_allocation_gb) },
        { label: "Storage alloc", value: fmtGB(e.storage_allocation_gb) },
        { label: "Reconstructable", value: e.reconstructable ? "Yes" : "No" },
        { label: "Persistent state", value: e.persistent_state ? "Yes" : "No" },
      ]} />
      {e.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{e.notes}</p></Section>}
      <Section title={`Workloads using this environment (${workloads.filter((w) => w.current_environment === e.id).length})`}>
        <RelatedList items={workloads.filter((w) => w.current_environment === e.id)} route="/workloads" label={(w) => w.name} sub={(w) => (w.category || "").replace(/_/g, " ")} status={(w) => w.lifecycle} tone={(w) => lifecycleTone(w.lifecycle)} goTo={goTo} />
      </Section>
      <Section title="Maintenance history">
        <RelatedList items={maintenance.filter((m) => m.target_id === e.id)} route="/maintenance" label={(m) => `${m.type} — ${m.target_name}`} status={(m) => m.outcome} goTo={goTo} emptyMsg="No maintenance" />
      </Section>
    </div>
  );

  return (
    <EntityCrudPage
      entityName="ExecutionEnvironment"
      title="Execution Environments"
      description="VMs, containers, pods and external services that host workloads."
      columns={COLUMNS}
      searchKeys={["name", "notes", "type"]}
      filters={[
        { key: "type", label: "Type", options: ["physical_host", "vm", "lxc", "docker", "podman", "kubernetes", "external_service"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
        { key: "lifecycle", label: "Lifecycle", options: ["planned", "onboarding", "active", "experimental", "maintenance", "degraded", "retiring", "retired"].map((v) => ({ value: v })) },
      ]}
      refOptions={refOptions}
      nameFields={{ current_host: "current_host_name" }}
      hidden={["current_host_name"]}
      exportColumns={[
        { label: "Name", get: (r) => r.name },
        { label: "Type", get: (r) => r.type },
        { label: "Host", get: (r) => r.current_host_name },
        { label: "Lifecycle", get: (r) => r.lifecycle },
        { label: "CPU", get: (r) => r.cpu_allocation },
        { label: "RAM GB", get: (r) => r.ram_allocation_gb },
      ]}
      detailRender={detailRender}
    />
  );
}