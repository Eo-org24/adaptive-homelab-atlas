import React, { useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import EntityCrudPage from "@/components/EntityCrudPage";
import PlacementSimulator from "@/components/PlacementSimulator";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import { fmtDate, lifecycleTone, riskTone, StatusBadge, badgeClass, refName } from "@/lib/homelab";
import { AlertTriangle, GitBranch, Sliders } from "lucide-react";

const STATUS_TONE = {
  idea: "zinc", proposed: "amber", accepted: "sky", ready: "violet",
  executing: "orange", verifying: "sky", completed: "emerald", rolled_back: "rose", abandoned: "zinc",
};

function ChangeDetail({ change, nodes, workloads, goTo }) {
  const affectedNodes = nodes.filter((n) => (change.affected_nodes || []).includes(n.id));
  const affectedWorkloads = workloads.filter((w) => (change.affected_workloads || []).includes(w.id));

  const flags = useMemo(() => {
    const f = [];
    if (!change.rollback_strategy && ["accepted", "ready", "executing"].includes(change.status))
      f.push("No rollback strategy recorded for an in-flight change");
    if (change.risk === "high" && ["ready", "executing"].includes(change.status))
      f.push("High-risk change is ready/executing — verify prerequisites");
    affectedWorkloads.forEach((w) => {
      if (w.availability_requirement === "always_on" && affectedNodes.some((n) => ["retiring", "retired", "degraded", "maintenance"].includes(n.lifecycle_state)))
        f.push(`Always-on workload "${w.name}" affected by a node in a non-available state — possible new single point of failure`);
    });
    // concentration: if many critical workloads map to one affected node
    const critical = affectedWorkloads.filter((w) => ["critical", "high"].includes(w.criticality));
    if (critical.length >= 3 && affectedNodes.length === 1)
      f.push(`${critical.length} critical/high workloads concentrated on a single affected node (${affectedNodes[0].hostname})`);
    return f;
  }, [change, affectedNodes, affectedWorkloads]);

  return (
    <div className="space-y-4">
      <SpecGrid fields={[
        { label: "Status", value: <StatusBadge value={change.status} tone={STATUS_TONE[change.status] || "zinc"} /> },
        { label: "Risk", value: <StatusBadge value={change.risk} tone={riskTone(change.risk)} /> },
        { label: "Planned date", value: fmtDate(change.planned_date) },
        { label: "Completed", value: fmtDate(change.actual_completion_date) },
      ]} />
      {change.reason && <Section title="Reason"><p className="text-sm whitespace-pre-wrap">{change.reason}</p></Section>}

      <Section title="What changes?">
        <div className="rounded-lg border border-border divide-y divide-border">
          <div className="px-3 py-2 bg-muted/40">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Affected nodes ({affectedNodes.length})</div>
            <RelatedList items={affectedNodes} route="/nodes" label={(n) => n.hostname} sub={(n) => n.lifecycle_state} status={(n) => n.lifecycle_state} tone={(n) => lifecycleTone(n.lifecycle_state)} goTo={goTo} emptyMsg="None" />
          </div>
          <div className="px-3 py-2 bg-muted/40">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Affected workloads ({affectedWorkloads.length})</div>
            <RelatedList items={affectedWorkloads} route="/workloads" label={(w) => w.name} sub={(w) => `host: ${refName(nodes, w.current_host, "hostname") || "—"}`} status={(w) => w.criticality} goTo={goTo} emptyMsg="None" />
          </div>
        </div>
      </Section>

      {change.proposed_actions && <Section title="Proposed actions"><p className="text-sm whitespace-pre-wrap">{change.proposed_actions}</p></Section>}
      {change.prerequisites && <Section title="Prerequisites"><p className="text-sm whitespace-pre-wrap">{change.prerequisites}</p></Section>}
      {change.expected_result && <Section title="Expected result"><p className="text-sm whitespace-pre-wrap">{change.expected_result}</p></Section>}
      {change.rollback_strategy && <Section title="Rollback strategy"><p className="text-sm whitespace-pre-wrap">{change.rollback_strategy}</p></Section>}

      {flags.length > 0 && (
        <Section title="Architectural flags">
          <ul className="space-y-1.5">
            {flags.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-rose-600 dark:text-rose-400">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{f}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {change.notes && <Section title="Notes"><p className="text-sm whitespace-pre-wrap">{change.notes}</p></Section>}
    </div>
  );
}

export default function ChangePlanner() {
  const [tab, setTab] = useState("changes");
  const { data } = useAllEntities(["Node", "Workload"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];

  const detailRender = (change, { goTo }) => (
    <ChangeDetail change={change} nodes={nodes} workloads={workloads} goTo={goTo} />
  );

  return (
    <div>
      <div className="px-4 xl:px-6 pt-5 max-w-[1760px] mx-auto">
        <div className="flex items-center gap-2 border-b border-border">
          <TabButton active={tab === "changes"} onClick={() => setTab("changes")} icon={GitBranch}>Planned Changes</TabButton>
          <TabButton active={tab === "simulator"} onClick={() => setTab("simulator")} icon={Sliders}>Placement Simulator</TabButton>
        </div>
      </div>
      {tab === "changes" ? (
        <EntityCrudPage
          entityName="PlannedChange"
          title="Change Planner"
          description="Plan, reason about, and track infrastructure changes with risk and rollback."
          columns={[
            { key: "title", label: "Title", className: "font-medium" },
            { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} tone={STATUS_TONE[r.status] || "zinc"} /> },
            { key: "risk", label: "Risk", render: (r) => <StatusBadge value={r.risk} tone={riskTone(r.risk)} /> },
            { key: "planned_date", label: "Planned", render: (r) => <span className="text-xs">{fmtDate(r.planned_date)}</span> },
            { key: "reason", label: "Reason", render: (r) => <span className="text-xs text-muted-foreground truncate max-w-xs block">{r.reason}</span> },
          ]}
          searchKeys={["title", "reason", "proposed_actions", "notes"]}
          filters={[
            { key: "status", label: "Status", options: ["idea", "proposed", "accepted", "ready", "executing", "verifying", "completed", "rolled_back", "abandoned"].map((v) => ({ value: v })) },
            { key: "risk", label: "Risk", options: ["low", "medium", "high"].map((v) => ({ value: v })) },
          ]}
          exportColumns={[
            { label: "Title", get: (r) => r.title },
            { label: "Status", get: (r) => r.status },
            { label: "Risk", get: (r) => r.risk },
            { label: "Planned", get: (r) => r.planned_date },
            { label: "Completed", get: (r) => r.actual_completion_date },
          ]}
          detailRender={detailRender}
        />
      ) : (
        <div className="p-4 xl:p-6 max-w-[1760px] mx-auto">
          <h1 className="text-xl font-semibold tracking-tight mb-1">Workload Placement Simulator</h1>
          <p className="text-sm text-muted-foreground mb-5">Evaluate candidate host nodes for a workload, scored by the homelab's priority principles.</p>
          <PlacementSimulator />
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 -mb-px transition-colors ${
        active ? "border-foreground text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}{children}
    </button>
  );
}