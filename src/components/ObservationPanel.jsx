import React, { useMemo } from "react";
import { useAllEntities } from "@/hooks/useEntities";
import { staleStatus, observationCategory } from "@/lib/provenance";
import { Section } from "@/components/Related";
import TruthBadge from "@/components/TruthBadge";

const STALE_TONE = { FRESH: "text-emerald-500", AGING: "text-amber-500", STALE: "text-rose-500", NO_OBSERVATION: "text-muted-foreground", UNKNOWN: "text-muted-foreground" };

// Shows the latest observation + history for an object, using the Observation entity.
// Observation is distinct from canonical declaration — it never rewrites canonical state.
export default function ObservationPanel({ canonicalId, objectType }) {
  const { data } = useAllEntities(["Observation"]);
  const obs = useMemo(() => {
    const all = (data.Observation || []).filter((o) => o.object_canonical_id && canonicalId && o.object_canonical_id === canonicalId);
    return all.sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at));
  }, [data.Observation, canonicalId]);

  if (!canonicalId) return null;
  const latest = obs[0];
  const cat = observationCategory(objectType);

  return (
    <Section title="Observations">
      {!latest ? (
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <TruthBadge kind="unknown" /> <span>NO OBSERVATION recorded — canonical declaration only.</span>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md border border-border p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Latest observation</span>
              <span className={`text-[11px] font-medium ${STALE_TONE[staleStatus(latest.observed_at, cat)]}`}>
                {staleStatus(latest.observed_at, cat)} · {Math.round((Date.now() - new Date(latest.observed_at).getTime()) / 86400000)}d ago
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-xs">
              <Field label="Source" value={latest.source} />
              <Field label="Confidence" value={latest.confidence != null ? latest.confidence : "—"} />
              <Field label="Version" value={latest.observation_version || "—"} />
              <Field label="Observed at" value={new Date(latest.observed_at).toLocaleString()} />
            </div>
            {latest.fields_observed?.length > 0 && (
              <div className="mt-2"><span className="text-[10px] uppercase text-muted-foreground">Fields observed</span>
                <div className="flex flex-wrap gap-1 mt-1">{latest.fields_observed.map((f) => <span key={f} className="text-[10px] font-mono rounded bg-muted px-1.5 py-0.5">{f}</span>)}</div>
              </div>
            )}
            {latest.notes && <p className="text-[11px] text-muted-foreground mt-2">{latest.notes}</p>}
          </div>
          {obs.length > 1 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">History ({obs.length - 1} more)</summary>
              <ul className="mt-1 space-y-1">
                {obs.slice(1).map((o, i) => <li key={i} className="text-[11px] text-muted-foreground font-mono">{new Date(o.observed_at).toLocaleString()} · {o.source || "—"} · {staleStatus(o.observed_at, cat)}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </Section>
  );
}

function Field({ label, value }) { return <div><span className="text-muted-foreground">{label}:</span> <span className="font-mono">{value}</span></div>; }