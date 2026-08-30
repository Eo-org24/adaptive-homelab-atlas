import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAllEntities } from "@/hooks/useEntities";
import { PageHeader, Card, EmptyState } from "@/components/ui-bits";
import { fmtDateTime, timeAgo, lifecycleTone, StatusBadge } from "@/lib/homelab";
import { Server, Boxes, GitBranch, Wrench, ListTodo, Scale, HardDrive, Network } from "lucide-react";

const SOURCES = [
  { entity: "Maintenance", label: "Maintenance", icon: Wrench, route: "/maintenance", name: (r) => `${r.type} — ${r.target_name}`, date: (r) => r.timestamp || r.updated_date, status: (r) => r.outcome, tone: (r) => r.outcome === "success" ? "emerald" : r.outcome === "failed" ? "rose" : "amber" },
  { entity: "PlannedChange", label: "Change", icon: GitBranch, route: "/change-planner", name: (r) => r.title, date: (r) => r.updated_date, status: (r) => r.status, tone: (r) => lifecycleTone(r.status) },
  { entity: "Task", label: "Task", icon: ListTodo, route: "/tasks", name: (r) => r.task, date: (r) => r.updated_date, status: (r) => r.status, tone: (r) => lifecycleTone(r.status) },
  { entity: "Decision", label: "Decision", icon: Scale, route: "/decisions", name: (r) => `${r.decision_id} — ${r.title}`, date: (r) => r.date || r.updated_date, status: (r) => r.status, tone: (r) => lifecycleTone(r.status) },
  { entity: "Node", label: "Node", icon: Server, route: "/nodes", name: (r) => r.hostname, date: (r) => r.updated_date, status: (r) => r.lifecycle_state, tone: (r) => lifecycleTone(r.lifecycle_state) },
  { entity: "Workload", label: "Workload", icon: Boxes, route: "/workloads", name: (r) => r.name, date: (r) => r.updated_date, status: (r) => r.lifecycle, tone: (r) => lifecycleTone(r.lifecycle) },
  { entity: "StorageDevice", label: "Storage", icon: HardDrive, route: "/storage", name: (r) => `${r.model}`, date: (r) => r.updated_date, status: (r) => r.health, tone: () => "zinc" },
  { entity: "NetworkDevice", label: "Network", icon: Network, route: "/network", name: (r) => r.name, date: (r) => r.updated_date, status: (r) => r.lifecycle_state, tone: (r) => lifecycleTone(r.lifecycle_state) },
];

export default function Activity() {
  const { data, loading } = useAllEntities(SOURCES.map((s) => s.entity));
  const [type, setType] = useState("all");
  const navigate = useNavigate();

  const feed = useMemo(() => {
    const items = [];
    SOURCES.forEach((s) => {
      (data[s.entity] || []).forEach((r) => {
        items.push({ ...r, _type: s.label, _route: s.route, _icon: s.icon, _name: s.name(r), _date: s.date(r), _status: s.status(r), _tone: s.tone(r) });
      });
    });
    return items.sort((a, b) => new Date(b._date || b.updated_date || 0) - new Date(a._date || a.updated_date || 0));
  }, [data]);

  const filtered = type === "all" ? feed : feed.filter((i) => i._type === type);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <PageHeader title="Activity" description="A unified timeline derived from every record type — newest first." />
      <div className="flex flex-wrap gap-1.5 mb-4">
        <Chip active={type === "all"} onClick={() => setType("all")}>All</Chip>
        {SOURCES.map((s) => <Chip key={s.label} active={type === s.label} onClick={() => setType(s.label)}>{s.label}</Chip>)}
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : filtered.length === 0 ? (
        <EmptyState title="No activity" />
      ) : (
        <div className="relative pl-6">
          <div className="absolute left-2 top-2 bottom-2 w-px bg-border" />
          <ul className="space-y-3">
            {filtered.slice(0, 120).map((item) => (
              <li key={item.id} className="relative">
                <span className="absolute -left-[18px] top-2 w-2.5 h-2.5 rounded-full bg-foreground/40 ring-2 ring-background" />
                <button
                  onClick={() => navigate(`${item._route}?focus=${item.id}`)}
                  className="w-full text-left flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 hover:border-foreground/20 transition-colors"
                >
                  <item._icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{item._name}</div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                      <span className="uppercase tracking-wide">{item._type}</span>
                      <span>· {timeAgo(item._date)}</span>
                      <span>· {fmtDateTime(item._date)}</span>
                    </div>
                  </div>
                  {item._status && <StatusBadge value={item._status} tone={item._tone} />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>{children}</button>
  );
}