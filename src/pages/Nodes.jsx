import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import MaintenanceList from "@/components/MaintenanceList";
import { fmtGB, lifecycleTone, badgeClass, StatusBadge, fmtDate } from "@/lib/homelab";
import { nodeHostedWorkloads } from "@/lib/relationships";

const COLUMNS = [
  { key: "hostname", label: "Hostname", className: "font-medium", mono: true },
  { key: "node_type", label: "Type", render: (r) => <span className="capitalize">{r.node_type}</span> },
  { key: "lifecycle_state", label: "State", tone: (r) => lifecycleTone(r.lifecycle_state), render: (r) => <StatusBadge value={r.lifecycle_state} tone={lifecycleTone(r.lifecycle_state)} /> },
  { key: "cpu", label: "CPU", get: (r) => r.cpu_model, render: (r) => <span className="text-xs text-muted-foreground">{r.cpu_model || "—"}</span> },
  { key: "ram", label: "RAM", get: (r) => fmtGB(r.ram_capacity_gb), render: (r) => fmtGB(r.ram_capacity_gb) },
  { key: "gpu", label: "GPU VRAM", get: (r) => fmtGB(r.gpu_vram_gb), render: (r) => fmtGB(r.gpu_vram_gb) },
  { key: "availability", label: "Availability", render: (r) => <span className="capitalize text-xs">{(r.availability_expectation || "").replace(/_/g, " ")}</span> },
];

export default function Nodes() {
  const { data } = useAllEntities(["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "NetworkDevice", "Maintenance", "Decision", "PlannedChange", "Dependency"]);
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const storage = data.StorageDevice || [];
  const maintenance = data.Maintenance || [];
  const decisions = data.Decision || [];
  const changes = data.PlannedChange || [];

  const detailRender = (n, { goTo }) => (
    <div className="space-y-4">
      {n.description && <p className="text-sm text-muted-foreground">{n.description}</p>}
      <SpecGrid fields={[
        { label: "Type", value: n.node_type },
        { label: "Manufacturer", value: n.manufacturer },
        { label: "Model", value: n.model },
        { label: "Motherboard", value: n.motherboard },
        { label: "CPU", value: n.cpu_model },
        { label: "Sockets / Cores / Logical", value: `${n.socket_count || 1} / ${n.physical_cores || 0} / ${n.logical_cpus || 0}` },
        { label: "RAM", value: `${fmtGB(n.ram_capacity_gb)}${n.ram_configuration ? ` · ${n.ram_configuration}` : ""}` },
        { label: "GPU VRAM", value: fmtGB(n.gpu_vram_gb) },
        { label: "GPUs", value: (n.gpus || []).join(", ") },
        { label: "NICs", value: (n.nics || []).join(", ") },
        { label: "Power supply", value: n.power_supply },
        { label: "Idle / Max power", value: `${n.idle_power_w || 0}W / ${n.max_power_w || 0}W` },
        { label: "OS / Hypervisor", value: n.os_hypervisor },
        { label: "Management addr", value: n.management_address, },
        { label: "Availability", value: (n.availability_expectation || "").replace(/_/g, " ") },
        { label: "Location", value: n.physical_location },
      ]} />
      {n.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{n.notes}</p></Section>}
      {(n.tags || []).length > 0 && <div className="flex flex-wrap gap-1.5">{n.tags.map((t) => <span key={t} className={badgeClass("zinc")}>{t}</span>)}</div>}

      <Section title={`Workloads hosted (${nodeHostedWorkloads(n, workloads, envs).length})`}>
        <RelatedList items={nodeHostedWorkloads(n, workloads, envs)} route="/workloads" label={(w) => w.name} sub={(w) => w.category.replace(/_/g, " ")} status={(w) => w.lifecycle} tone={(w) => lifecycleTone(w.lifecycle)} goTo={goTo} />
      </Section>
      <Section title={`Execution environments (${envs.filter((e) => e.current_host === n.id).length})`}>
        <RelatedList items={envs.filter((e) => e.current_host === n.id)} route="/environments" label={(e) => e.name} sub={(e) => (e.type || "").replace(/_/g, " ")} status={(e) => e.lifecycle} tone={(e) => lifecycleTone(e.lifecycle)} goTo={goTo} />
      </Section>
      <Section title={`Storage devices (${storage.filter((s) => s.current_node === n.id).length})`}>
        <RelatedList items={storage.filter((s) => s.current_node === n.id)} route="/storage" label={(s) => `${s.model} · ${fmtGB(s.capacity_gb)}`} sub={(s) => s.media_type} status={(s) => s.health} goTo={goTo} />
      </Section>
      <Section title="Maintenance history">
        <MaintenanceList items={maintenance.filter((m) => m.target_id === n.id)} data={data} goTo={goTo} emptyMsg="No maintenance logged" />
      </Section>
      <Section title="Related decisions">
        <RelatedList items={decisions.filter((d) => (d.related_nodes || []).includes(n.id))} route="/decisions" label={(d) => `${d.decision_id} · ${d.title}`} status={(d) => d.status} goTo={goTo} />
      </Section>
      <Section title="Affected by changes">
        <RelatedList items={changes.filter((c) => (c.affected_nodes || []).includes(n.id))} route="/change-planner" label={(c) => c.title} status={(c) => c.status} tone={(c) => lifecycleTone(c.status)} goTo={goTo} />
      </Section>
    </div>
  );

  return (
    <EntityCrudPage
      entityName="Node"
      title="Physical Nodes"
      description="Canonical hardware inventory. No remote control — documented state only."
      columns={COLUMNS}
      searchKeys={["hostname", "manufacturer", "model", "cpu_model", "notes"]}
      filters={[
        { key: "lifecycle_state", label: "State", options: ["planned", "onboarding", "active", "experimental", "maintenance", "degraded", "retiring", "retired"].map((v) => ({ value: v, label: v })) },
        { key: "node_type", label: "Type", options: ["workstation", "server", "hypervisor", "utility", "appliance", "other"].map((v) => ({ value: v })) },
        { key: "availability_expectation", label: "Availability", options: ["always_on", "business_hours", "on_demand", "best_effort"].map((v) => ({ value: v })) },
      ]}
      exportColumns={[
        { label: "Hostname", get: (r) => r.hostname },
        { label: "Type", get: (r) => r.node_type },
        { label: "State", get: (r) => r.lifecycle_state },
        { label: "CPU", get: (r) => r.cpu_model },
        { label: "Cores", get: (r) => r.physical_cores },
        { label: "Logical", get: (r) => r.logical_cpus },
        { label: "RAM GB", get: (r) => r.ram_capacity_gb },
        { label: "GPU VRAM GB", get: (r) => r.gpu_vram_gb },
        { label: "Idle W", get: (r) => r.idle_power_w },
        { label: "Max W", get: (r) => r.max_power_w },
        { label: "OS", get: (r) => r.os_hypervisor },
        { label: "Availability", get: (r) => r.availability_expectation },
      ]}
      detailRender={detailRender}
    />
  );
}