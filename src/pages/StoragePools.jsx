import React, { useMemo } from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import { fmtGB, StatusBadge } from "@/lib/homelab";

const STATE_TONE = { active: "emerald", degraded: "amber", maintenance: "amber", planned: "violet", retired: "zinc" };
const COLUMNS = [
  { key: "name", label: "Pool", className: "font-medium" },
  { key: "node_name", label: "Node", render: (r) => <span className="text-xs">{r.node_name || "—"}</span> },
  { key: "raid_level", label: "RAID", render: (r) => <span className="text-xs uppercase">{(r.raid_level || "").replace(/_/g, " ")}</span> },
  { key: "usable_capacity_gb", label: "Usable", render: (r) => fmtGB(r.usable_capacity_gb) },
  { key: "state", label: "State", render: (r) => <StatusBadge value={r.state} tone={STATE_TONE[r.state] || "zinc"} /> },
];

export default function StoragePools() {
  const { data } = useAllEntities(["Node", "StorageDevice", "Maintenance"]);
  const nodes = data.Node || [];
  const devices = data.StorageDevice || [];
  const maintenance = data.Maintenance || [];

  const refOptions = useMemo(() => ({
    node: nodes.map((n) => ({ value: n.id, label: n.hostname })),
  }), [nodes]);

  const detailRender = (p, { goTo }) => {
    const members = (p.device_ids || []).map((id) => devices.find((d) => d.id === id)).filter(Boolean);
    return (
      <div className="space-y-4">
        <SpecGrid fields={[
          { label: "Node", value: p.node_name || "—" },
          { label: "RAID level", value: (p.raid_level || "").replace(/_/g, " ").toUpperCase() },
          { label: "Usable capacity", value: fmtGB(p.usable_capacity_gb) },
          { label: "State", value: <StatusBadge value={p.state} tone={STATE_TONE[p.state] || "zinc"} /> },
          { label: "Devices", value: (p.device_ids || []).length },
        ]} />
        {p.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{p.notes}</p></Section>}
        <Section title={`Member devices (${members.length})`}>
          <RelatedList items={members} route="/storage" label={(d) => `${d.model} · ${fmtGB(d.capacity_gb)}`} sub={(d) => d.media_type} status={(d) => d.health} goTo={goTo} emptyMsg="No devices assigned" />
        </Section>
        <Section title="Maintenance history">
          <RelatedList items={maintenance.filter((m) => m.target_id === p.id)} route="/maintenance" label={(m) => `${m.type} — ${m.target_name}`} status={(m) => m.outcome} goTo={goTo} emptyMsg="No maintenance" />
        </Section>
      </div>
    );
  };

  return (
    <EntityCrudPage
      entityName="StoragePool"
      title="Storage Pools"
      description="RAID/ZFS pools aggregating storage devices into usable capacity."
      columns={COLUMNS}
      searchKeys={["name", "notes", "node_name"]}
      filters={[
        { key: "raid_level", label: "RAID", options: ["single", "raid0", "raid1", "raid5", "raid6", "raid10", "zfs_mirror", "zfs_raidz1", "zfs_raidz2", "other"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
        { key: "state", label: "State", options: ["active", "degraded", "maintenance", "planned", "retired"].map((v) => ({ value: v })) },
      ]}
      refOptions={refOptions}
      nameFields={{ node: "node_name" }}
      hidden={["node_name"]}
      exportColumns={[
        { label: "Name", get: (r) => r.name },
        { label: "Node", get: (r) => r.node_name },
        { label: "RAID", get: (r) => r.raid_level },
        { label: "Usable GB", get: (r) => r.usable_capacity_gb },
        { label: "State", get: (r) => r.state },
      ]}
      detailRender={detailRender}
    />
  );
}