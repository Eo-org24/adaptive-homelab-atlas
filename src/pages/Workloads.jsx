import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import MaintenanceList from "@/components/MaintenanceList";
import { fmtGB, lifecycleTone, criticalityTone, stateClassTone, badgeClass, StatusBadge, fmtDate, refName, typedRefName } from "@/lib/homelab";
import { workloadPhysicalNode } from "@/lib/relationships";
import ObjectFindings from "@/components/ObjectFindings";
import ProvenanceSection from "@/components/ProvenanceSection";

const ROUTE_BY_TYPE = { workload: "/workloads", environment: "/environments", node: "/nodes", storage: "/storage", network_service: "/network", external: null };

const COLUMNS = [
  { key: "name", label: "Name", className: "font-medium", mono: true },
  { key: "category", label: "Category", render: (r) => <span className="capitalize text-xs">{(r.category || "").replace(/_/g, " ")}</span> },
  { key: "criticality", label: "Criticality", render: (r) => <StatusBadge value={r.criticality} tone={criticalityTone(r.criticality)} /> },
  { key: "host", label: "Host", get: (r) => r.current_host_name, render: (r) => <span className="text-xs">{r.current_host_name || "—"}</span> },
  { key: "lifecycle", label: "Lifecycle", render: (r) => <StatusBadge value={r.lifecycle} tone={lifecycleTone(r.lifecycle)} /> },
  { key: "state", label: "State class", render: (r) => <StatusBadge value={r.state_classification} tone={stateClassTone(r.state_classification)} /> },
  { key: "ram", label: "RAM", get: (r) => fmtGB(r.ram_requirement_gb), render: (r) => fmtGB(r.ram_requirement_gb) },
];

export default function Workloads() {
  const { data } = useAllEntities(["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "NetworkDevice", "Dependency", "Maintenance", "PlannedChange", "Decision"]);
  const nodes = data.Node || [];
  const envs = data.ExecutionEnvironment || [];
  const deps = data.Dependency || [];
  const maintenance = data.Maintenance || [];
  const changes = data.PlannedChange || [];

  const refOptions = useMemo(() => ({
    current_host: nodes.map((n) => ({ value: n.id, label: n.hostname })),
    preferred_node: nodes.map((n) => ({ value: n.id, label: n.hostname })),
    current_environment: envs.map((e) => ({ value: e.id, label: `${e.name} (${e.type})` })),
  }), [nodes, envs]);

  const enrich = useMemo(() => (w) => {
    const env = envs.find((e) => e.id === w.current_environment);
    const phys = workloadPhysicalNode(w, envs, nodes);
    return {
      ...w,
      current_host_name: phys ? phys.hostname : "",
      current_environment_name: env ? `${env.name} (${env.type})` : "",
      preferred_node_name: refName(nodes, w.preferred_node, "hostname"),
    };
  }, [nodes, envs]);

  const detailRender = (w, { goTo }) => {
    const outDeps = deps.filter((d) => d.source_type === "workload" && d.source_id === w.id);
    const inDeps = deps.filter((d) => d.target_type === "workload" && d.target_id === w.id);
    return (
      <div className="space-y-4">
        {w.description && <p className="text-sm text-muted-foreground">{w.description}</p>}
        <SpecGrid fields={[
          { label: "Category", value: (w.category || "").replace(/_/g, " ") },
          { label: "Criticality", value: <StatusBadge value={w.criticality} tone={criticalityTone(w.criticality)} /> },
          { label: "Lifecycle", value: <StatusBadge value={w.lifecycle} tone={lifecycleTone(w.lifecycle)} /> },
          { label: "State class", value: <StatusBadge value={w.state_classification} tone={stateClassTone(w.state_classification)} /> },
          { label: "Execution environment", value: w.current_environment_name || "—" },
          { label: "Physical realization", value: w.current_host_name ? `${w.current_host_name} (via environment)` : "—" },
          { label: "Preferred node", value: w.preferred_node_name || "—" },
          { label: "Availability", value: (w.availability_requirement || "").replace(/_/g, " ") },
          { label: "CPU req", value: w.cpu_requirement ? `${w.cpu_requirement} cores` : "—" },
          { label: "RAM req", value: fmtGB(w.ram_requirement_gb) },
          { label: "GPU req", value: w.gpu_requirement || "—" },
          { label: "GPU VRAM req", value: fmtGB(w.gpu_vram_requirement_gb) },
          { label: "Storage req", value: fmtGB(w.storage_requirement_gb) },
          { label: "Network req", value: w.network_requirement || "—" },
          { label: "Reconstructable", value: w.reconstructable ? "Yes" : "No" },
          { label: "Backup req", value: w.backup_requirement || "—" },
        ]} />
        {(w.eligible_alternative_nodes || []).length > 0 && (
          <Section title="Eligible alternative nodes">
            <div className="flex flex-wrap gap-1.5">
              {w.eligible_alternative_nodes.map((id) => {
                const n = nodes.find((x) => x.id === id);
                return n ? <span key={id} className={badgeClass("sky")}>{n.hostname}</span> : null;
              })}
            </div>
          </Section>
        )}
        {(w.tags || []).length > 0 && <div className="flex flex-wrap gap-1.5">{w.tags.map((t) => <span key={t} className={badgeClass("zinc")}>{t}</span>)}</div>}
        {w.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{w.notes}</p></Section>}

        <Section title={`Dependencies (outgoing: ${outDeps.length})`}>
          <RelatedList items={outDeps} label={(d) => `${(d.target_type || "").replace(/_/g, " ")} → ${typedRefName(d.target_type, d.target_id, data) || d.target_name || "—"}`} status={(d) => d.kind} goTo={goTo} emptyMsg="No outgoing dependencies" idFor={(d) => d.target_id} routeFor={(d) => ROUTE_BY_TYPE[d.target_type]} />
        </Section>
        <Section title={`Depended on by (incoming: ${inDeps.length})`}>
          <RelatedList items={inDeps} label={(d) => `${typedRefName(d.source_type, d.source_id, data) || "—"} ← depends on this`} status={(d) => d.kind} goTo={goTo} emptyMsg="Nothing depends on this workload" idFor={(d) => d.source_id} routeFor={(d) => ROUTE_BY_TYPE[d.source_type]} />
        </Section>
        <Section title="Maintenance history">
          <MaintenanceList items={maintenance.filter((m) => m.target_id === w.id)} data={data} goTo={goTo} emptyMsg="No maintenance" />
        </Section>
        <Section title="Affected by changes">
          <RelatedList items={changes.filter((c) => (c.affected_workloads || []).includes(w.id))} route="/change-planner" label={(c) => c.title} status={(c) => c.status} tone={(c) => lifecycleTone(c.status)} goTo={goTo} />
        </Section>
        <ProvenanceSection record={w} objectType="workload" fields={[{ label: "CPU requirement", field: "cpu_requirement", format: (v) => (v ? `${v} cores` : "—") }, { label: "RAM requirement", field: "ram_requirement_gb", format: (v) => (v ? `${v} GB` : "—") }, { label: "Storage requirement", field: "storage_requirement_gb", format: (v) => (v ? `${v} GB` : "—") }]} />
        <ObjectFindings type="workload" id={w.id} canonicalId={w.canonical_id} />
      </div>
    );
  };

  return (
    <EntityCrudPage
      entityName="Workload"
      title="Workloads"
      description="Logical services and their resource requirements, dependencies, and lifecycle."
      columns={COLUMNS}
      searchKeys={["name", "description", "category", "notes"]}
      filters={[
        { key: "category", label: "Category", options: ["infrastructure", "networking", "storage", "observability", "ai_inference", "ai_tooling", "automation", "documentation", "development", "experimental", "user_application"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
        { key: "criticality", label: "Criticality", options: ["low", "medium", "high", "critical"].map((v) => ({ value: v })) },
        { key: "lifecycle", label: "Lifecycle", options: ["planned", "onboarding", "active", "experimental", "maintenance", "degraded", "retiring", "retired"].map((v) => ({ value: v })) },
      ]}
      refOptions={refOptions}
      enrich={enrich}
      exportColumns={[
        { label: "Name", get: (r) => r.name },
        { label: "Category", get: (r) => r.category },
        { label: "Criticality", get: (r) => r.criticality },
        { label: "Host", get: (r) => r.current_host_name },
        { label: "Lifecycle", get: (r) => r.lifecycle },
        { label: "CPU", get: (r) => r.cpu_requirement },
        { label: "RAM GB", get: (r) => r.ram_requirement_gb },
        { label: "GPU VRAM GB", get: (r) => r.gpu_vram_requirement_gb },
        { label: "Storage GB", get: (r) => r.storage_requirement_gb },
      ]}
      detailRender={detailRender}
    />
  );
}