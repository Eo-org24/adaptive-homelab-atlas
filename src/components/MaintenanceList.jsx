import React from "react";
import { RelatedList } from "@/components/Related";
import { fmtDate, typedRefName } from "@/lib/homelab";

// Maintenance history list with target names resolved live from canonical
// records. `data` must include the maintenance target entity types
// (Node, Workload, ExecutionEnvironment, NetworkDevice, StorageDevice).
export default function MaintenanceList({ items, data, goTo, emptyMsg = "No maintenance logged" }) {
  return (
    <RelatedList
      items={items}
      route="/maintenance"
      label={(m) => `${m.type} — ${typedRefName(m.target_type, m.target_id, data) || "—"}`}
      sub={(m) => fmtDate(m.timestamp)}
      status={(m) => m.outcome}
      goTo={goTo}
      emptyMsg={emptyMsg}
    />
  );
}