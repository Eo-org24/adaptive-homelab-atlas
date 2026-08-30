import React from "react";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import PortManager from "@/components/PortManager";
import { SpecGrid, Section, RelatedList } from "@/components/Related";
import { lifecycleTone, StatusBadge, fmtDate, badgeClass } from "@/lib/homelab";

const COLUMNS = [
  { key: "name", label: "Name", className: "font-medium" },
  { key: "type", label: "Type", render: (r) => <span className="capitalize">{(r.type || "").replace(/_/g, " ")}</span> },
  { key: "lifecycle_state", label: "State", render: (r) => <StatusBadge value={r.lifecycle_state} tone={lifecycleTone(r.lifecycle_state)} /> },
  { key: "manufacturer", label: "Manufacturer", render: (r) => <span className="text-xs text-muted-foreground">{r.manufacturer || "—"}</span> },
  { key: "model", label: "Model", render: (r) => <span className="text-xs">{r.model || "—"}</span> },
  { key: "management_address", label: "Mgmt addr", render: (r) => <span className="text-xs font-mono">{r.management_address || "—"}</span> },
  { key: "port_count", label: "Ports", get: (r) => r.port_count, render: (r) => r.port_count || "—" },
];

export default function Network() {
  const { data: all, refresh } = useAllEntities(["SwitchPort", "Maintenance"]);
  const ports = all.SwitchPort || [];
  const maintenance = (all.Maintenance || []).filter((m) => m.target_type === "network_device");

  const detailRender = (d, { goTo }) => (
    <div className="space-y-4">
      {d.notes && <p className="text-sm text-muted-foreground">{d.notes}</p>}
      <SpecGrid fields={[
        { label: "Type", value: (d.type || "").replace(/_/g, " ") },
        { label: "Manufacturer", value: d.manufacturer },
        { label: "Model", value: d.model },
        { label: "Port count", value: d.port_count },
        { label: "Management addr", value: d.management_address },
        { label: "Location", value: d.location },
        { label: "Lifecycle", value: <StatusBadge value={d.lifecycle_state} tone={lifecycleTone(d.lifecycle_state)} /> },
      ]} />
      <Section title={`Switch ports (${ports.filter((p) => p.device === d.id).length})`}>
        <PortManager device={d} ports={ports} onRefresh={refresh} />
      </Section>
      {(d.tags || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">{d.tags.map((t) => <span key={t} className={badgeClass("zinc")}>{t}</span>)}</div>
      )}
      <Section title="Maintenance history">
        <RelatedList items={maintenance.filter((m) => m.target_id === d.id)} route="/maintenance" label={(m) => `${m.type} — ${m.target_name}`} sub={(m) => fmtDate(m.timestamp)} status={(m) => m.outcome} goTo={goTo} emptyMsg="No maintenance logged" />
      </Section>
    </div>
  );

  return (
    <EntityCrudPage
      entityName="NetworkDevice"
      title="Network"
      description="Routers, switches, firewalls, NICs and their ports. Documented topology only."
      columns={COLUMNS}
      searchKeys={["name", "manufacturer", "model", "management_address", "notes"]}
      filters={[
        { key: "type", label: "Type", options: ["router", "switch", "firewall", "access_point", "server_nic", "management_controller", "other"].map((v) => ({ value: v, label: v.replace(/_/g, " ") })) },
        { key: "lifecycle_state", label: "State", options: ["planned", "onboarding", "active", "experimental", "maintenance", "degraded", "retiring", "retired"].map((v) => ({ value: v })) },
      ]}
      exportColumns={[
        { label: "Name", get: (r) => r.name },
        { label: "Type", get: (r) => r.type },
        { label: "Manufacturer", get: (r) => r.manufacturer },
        { label: "Model", get: (r) => r.model },
        { label: "Mgmt addr", get: (r) => r.management_address },
        { label: "Ports", get: (r) => r.port_count },
        { label: "State", get: (r) => r.lifecycle_state },
      ]}
      detailRender={detailRender}
    />
  );
}