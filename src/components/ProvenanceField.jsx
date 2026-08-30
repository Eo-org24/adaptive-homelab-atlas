import React from "react";
import { truthLayers } from "@/lib/provenance";
import TruthBadge from "@/components/TruthBadge";

// Renders all truth layers for a field (canonical + observed/planned/local/inferred overlays).
// Never overwrites one value with another; coexisting layers are shown side by side.
export default function ProvenanceField({ record, field, label, format }) {
  const flat = record?.[field];
  const layers = truthLayers(record, field, flat);
  const fmt = (v) => (format ? format(v) : (v == null || v === "" ? "—" : String(v)));
  return (
    <div className="py-1.5 border-b border-border last:border-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label || field}</div>
      <div className="mt-1 space-y-1">
        {layers.map((l, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <span className={`text-sm tabular-nums ${l.kind === "planned" || l.kind === "inferred" ? "italic text-muted-foreground" : ""} ${l.kind === "local" ? "font-medium" : ""}`}>{fmt(l.value)}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {l.meta?.observed_at && <span className="text-[10px] text-muted-foreground">{new Date(l.meta.observed_at).toLocaleDateString()}</span>}
              <TruthBadge kind={l.kind} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}