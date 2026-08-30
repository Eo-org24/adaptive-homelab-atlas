import React, { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import EntityCrudPage from "@/components/EntityCrudPage";
import { useAllEntities } from "@/hooks/useEntities";
import { RelatedList, SpecGrid, Section } from "@/components/Related";
import { fmtDate, badgeClass, StatusBadge } from "@/lib/homelab";
import { Scale } from "lucide-react";

const STATUS_TONE = { proposed: "amber", accepted: "emerald", rejected: "rose", deprecated: "zinc", superseded: "violet" };

export default function Decisions() {
  const { data } = useAllEntities(["Node", "Workload"]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const navigate = useNavigate();

  const detailRender = (d, { goTo }) => (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{d.decision_id}</span>
        <StatusBadge value={d.status} tone={STATUS_TONE[d.status] || "zinc"} />
        <span className="text-xs text-muted-foreground ml-auto">{fmtDate(d.date)}</span>
      </div>
      <Section title="Context"><p className="text-sm whitespace-pre-wrap">{d.context || "—"}</p></Section>
      <Section title="Decision"><p className="text-sm whitespace-pre-wrap">{d.decision || "—"}</p></Section>
      <Section title="Rationale"><p className="text-sm whitespace-pre-wrap">{d.rationale || "—"}</p></Section>
      {d.alternatives && <Section title="Alternatives considered"><p className="text-sm whitespace-pre-wrap">{d.alternatives}</p></Section>}
      {d.consequences && <Section title="Consequences"><p className="text-sm whitespace-pre-wrap">{d.consequences}</p></Section>}
      {(d.supersedes || d.superseded_by) && (
        <SpecGrid fields={[
          { label: "Supersedes", value: d.supersedes },
          { label: "Superseded by", value: d.superseded_by },
        ]} />
      )}
      {(d.related_nodes || []).length > 0 && (
        <Section title="Related nodes"><RelatedList items={nodes.filter((n) => (d.related_nodes || []).includes(n.id))} route="/nodes" label={(n) => n.hostname} goTo={goTo} /></Section>
      )}
      {(d.related_workloads || []).length > 0 && (
        <Section title="Related workloads"><RelatedList items={workloads.filter((w) => (d.related_workloads || []).includes(w.id))} route="/workloads" label={(w) => w.name} goTo={goTo} /></Section>
      )}
      {(d.tags || []).length > 0 && <div className="flex flex-wrap gap-1.5">{d.tags.map((t) => <span key={t} className={badgeClass("zinc")}>{t}</span>)}</div>}
    </div>
  );

  return (
    <EntityCrudPage
      entityName="Decision"
      title="Decisions"
      description="Architecture Decision Records. Accepted decisions carry strong visual prominence."
      columns={[
        { key: "decision_id", label: "ID", className: "font-mono text-xs" },
        { key: "title", label: "Title", className: "font-medium" },
        { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} tone={STATUS_TONE[r.status] || "zinc"} /> },
        { key: "date", label: "Date", render: (r) => <span className="text-xs">{fmtDate(r.date)}</span> },
      ]}
      searchKeys={["decision_id", "title", "context", "decision", "rationale"]}
      filters={[
        { key: "status", label: "Status", options: ["proposed", "accepted", "rejected", "deprecated", "superseded"].map((v) => ({ value: v })) },
      ]}
      exportColumns={[
        { label: "ID", get: (r) => r.decision_id },
        { label: "Title", get: (r) => r.title },
        { label: "Status", get: (r) => r.status },
        { label: "Date", get: (r) => r.date },
      ]}
      detailRender={detailRender}
    />
  );
}