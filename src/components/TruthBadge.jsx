import React from "react";
import { badgeClass } from "@/lib/homelab";

// Truth-state badge: canonical, observed, planned, inferred, local, sample, unknown.
const LABELS = { canonical: "CANONICAL", observed: "OBSERVED", planned: "PLANNED", inferred: "INFERRED", local: "LOCAL OVERRIDE", sample: "SAMPLE", unknown: "UNKNOWN" };
const TONE = { canonical: "zinc", observed: "sky", planned: "fuchsia", inferred: "amber", local: "orange", sample: "zinc", unknown: "zinc" };
const DASH = { planned: "border-dashed", sample: "border-dashed", local: "border-dashed" };
const ITALIC = { inferred: "italic", sample: "italic" };

export default function TruthBadge({ kind }) {
  if (!kind || kind === "unknown") return <span className="text-[10px] text-muted-foreground italic">unknown</span>;
  return (
    <span className={`${badgeClass(TONE[kind] || "zinc")} ${DASH[kind] || ""} ${ITALIC[kind] || ""}`} title={`Truth state: ${LABELS[kind]}`}>
      {LABELS[kind] || kind}
    </span>
  );
}