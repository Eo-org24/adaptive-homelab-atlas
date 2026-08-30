import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import MaintenanceList from "@/components/MaintenanceList";
import { fmtGB, fmtDate, badgeClass, refName } from "@/lib/homelab";
import ObjectFindings from "@/components/ObjectFindings";

const HEALTH_TONE = { healthy: "emerald", warning: "amber", failing: "rose", unknown: "zinc", retired: "zinc" };
const COLUMNS = [
  { key: "model", label: "Model", className: "font-medium" },
  { key: "manufacturer", label: "Manufacturer", render: (r) => <span className="text-xs text-muted-foreground">{r.manufacturer || "—"}</span> },
  { key: "capacity_gb", label: "Capacity", render: (r) => fmtGB(r.capacity_gb) },
  { key: "media_type", label: "Media", render: (r) => <span className="capitalize text-xs">{r.media_type}</span> },
  { key: "protocol", label: "Protocol", render: (r) => <span className="uppercase text-xs">{r.protocol}</span> },
  { key: "current_node_name", label: "Node", render: (r) => <span className="text-xs">{r.current_node_name || "—"}</span> },
  { key: "health", label: "Health", render: (r) => <span className={badgeClass(HEALTH_TONE[r.health] || "zinc")}>{r.health}</span> },
];

export default function Storage() {
  const { data } = useAllEntities(["Node", "Workload", "ExecutionEnvironment", "NetworkDevice", "StoragePool", "Maintenance"]);
  const nodes = data.Node || [];
  const pools = data.StoragePool || [];
  const maintenance = data.Maintenance || [];

  const refOptions = useMemo(() => ({
    current_node: nodes.map((n) => ({ value: n.id, label: n.hostname })),
  }), [nodes]);

  const enrich = useMemo(() => (s) => ({
    ...s,
    current_node_name: refName(nodes, s.current_node, "hostname"),
  }), [nodes]);

  const detailRender = (s, { goTo }) => {
    const devicePools = pools.filter((p) => (p.device_ids || []).includes(s.id));
    return (
      <div className="space-y-4">
        <SpecGrid fields={[
          { label: "Manufacturer", value: s.manufacturer },
          { label: "Model", value: s.model },
          { label: "Serial", value: s.serial_number },
          { label: "Capacity", value: fmtGB(s.capacity_gb) },
          { label: "Media type", value: s.media_type },
          { label: "Protocol", value: (s.protocol || "").toUpperCase() },
          { label: "Firmware", value: s.firmware },
          { label: "Node", value: s.current_node_name },
          { label: "Bay / location", value: s.physical_bay },
          { label: "Health", value: s.health },
          { label: "State class", value: s.state_class },
          { label: "Intended purpose", value: s.intended_purpose },
          { label: "Commissioned", value: fmtDate(s.commissioning_date) },
          { label: "Retired", value: fmtDate(s.retirement_date) },
        ]} />
        {s.purchase_notes && <Section title="Purchase / source"><p className="text-sm">{s.purchase_notes}</p></Section>}
        {s.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{s.notes}</p></Section>}
        <Section title="Member of pools">
          <RelatedList items={devicePools} route="/storage-pools" label={(p) => p.name} sub={(p) => `${(p.raid_level || "").replace(/_/g, " ")} · ${fmtGB(p.usable_capacity_gb)}`} status={(p) => p.state} goTo={goTo} emptyMsg="Not in any pool" />
        </Section>
        <Section title="Maintenance history">
          <MaintenanceList items={maintenance.filter((m) => m.target_id === s.id)} data={data} goTo={goTo} emptyMsg="No maintenance" />
        </Section>
        <ObjectFindings type="storage" id={s.id} canonicalId={s.canonical_id} />
      </div>
    );
  };

  return (
    <EntityCrudPage
      entityName="StorageDevice"
      title="Storage"
      description="Disks, SSDs and pools. Private storage metadata — never exposed publicly."
      columns={COLUMNS}
      searchKeys={["manufacturer", "model", "serial_number", "notes", "intended_purpose"]}
      filters={[
        { key: "media_type", label: "Media", options: ["hdd", "ssd", "nvme", "sd", "other"].map((v) => ({ value: v })) },
        { key: "health", label: "Health", options: ["healthy", "warning", "failing", "unknown", "retired"].map((v) => ({ value: v })) },
      ]}
      refOptions={refOptions}
      enrich={enrich}
      exportColumns={[
        { label: "Manufacturer", get: (r) => r.manufacturer },
        { label: "Model", get: (r) => r.model },
        { label: "Serial", get: (r) => r.serial_number },
        { label: "Capacity GB", get: (r) => r.capacity_gb },
        { label: "Media", get: (r) => r.media_type },
        { label: "Protocol", get: (r) => r.protocol },
        { label: "Node", get: (r) => r.current_node_name },
        { label: "Health", get: (r) => r.health },
      ]}
      detailRender={detailRender}
    />
  );
}