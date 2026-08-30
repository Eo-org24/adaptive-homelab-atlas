import React, { useState, useMemo } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import EntityForm from "@/components/EntityForm";
import { base44 } from "@/api/base44Client";
import { badgeClass } from "@/lib/homelab";

const PORT_FILTERS = [
  { key: "connected", label: "Connected", test: (p) => p.connected_device || p.connected_interface },
  { key: "unused", label: "Unused", test: (p) => !p.connected_device && p.admin_state === "enabled" },
  { key: "planned", label: "Planned", test: (p) => p.admin_state === "planned" || p.observed_link_state === "planned" },
  { key: "management", label: "Management", test: (p) => /mgmt|manage|bmc|idrac|ipmi/i.test(p.description || "") },
  { key: "high-speed", label: "High-speed", test: (p) => ["10G", "25G", "40G", "100G"].includes(p.speed) },
  { key: "uplink", label: "Uplink", test: (p) => /uplink|trunk|wan/i.test(p.description || "") },
];

export default function PortManager({ device, ports, onRefresh }) {
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const devicePorts = useMemo(() => ports.filter((p) => p.device === device.id), [ports, device.id]);
  const filtered = useMemo(() => {
    if (filter === "all") return devicePorts;
    const f = PORT_FILTERS.find((x) => x.key === filter);
    return f ? devicePorts.filter(f.test) : devicePorts;
  }, [devicePorts, filter]);

  const submit = async (vals) => {
    if (editing.id) await base44.entities.SwitchPort.update(editing.id, { ...vals, device: device.id, device_name: device.name });
    else await base44.entities.SwitchPort.create({ ...vals, device: device.id, device_name: device.name });
    setOpen(false); setEditing(null); onRefresh();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChip label="All" active={filter === "all"} onClick={() => setFilter("all")} />
          {PORT_FILTERS.map((f) => (
            <FilterChip key={f.key} label={f.label} active={filter === f.key} onClick={() => setFilter(f.key)} />
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={() => { setEditing({}); setOpen(true); }}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Port
        </Button>
      </div>

      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4">No ports match this filter.</p>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
          {filtered.map((p) => (
            <div
              key={p.id}
              className={`rounded-md border p-2 text-center cursor-pointer hover:border-foreground/30 ${portTone(p)}`}
              onClick={() => { setEditing(p); setOpen(true); }}
              title={`${p.port_identifier} — ${p.description || ""}`}
            >
              <div className="text-[10px] font-mono font-medium truncate">{p.port_identifier}</div>
              <div className="text-[9px] text-muted-foreground mt-0.5">{p.speed}</div>
              <div className="flex justify-center gap-0.5 mt-1">
                <span className={`w-1.5 h-1.5 rounded-full ${p.observed_link_state === "up" ? "bg-emerald-500" : p.observed_link_state === "planned" ? "bg-violet-400" : "bg-zinc-400"}`} />
                <span className={`w-1.5 h-1.5 rounded-full ${p.admin_state === "enabled" ? "bg-sky-500" : "bg-zinc-600"}`} />
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing?.id ? "Edit" : "Add"} port</DialogTitle></DialogHeader>
          {editing && (
            <EntityForm
              entityName="SwitchPort"
              initial={editing}
              onSubmit={submit}
              onCancel={() => { setOpen(false); setEditing(null); }}
              hidden={["device", "device_name"]}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
        active ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"
      }`}
    >{label}</button>
  );
}

function portTone(p) {
  if (p.observed_link_state === "up") return "border-emerald-500/40 bg-emerald-500/5";
  if (p.observed_link_state === "planned" || p.admin_state === "planned") return "border-violet-500/40 bg-violet-500/5";
  if (p.admin_state === "disabled") return "border-zinc-600/40 bg-zinc-500/5";
  return "border-border";
}