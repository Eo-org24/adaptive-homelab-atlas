import React from "react";
import { badgeClass } from "@/lib/homelab";

// Visually distinguishes provenance / truth-state of a record.
// declared (solid) · observed · imported · inferred (italic) · planned (dashed) · sample (dashed + italic + SAMPLE)
const LABELS = { documented: "Declared", observed: "Observed", imported: "Imported", inferred: "Inferred", planned: "Planned", sample: "Sample" };
const TONE = { documented: "zinc", observed: "sky", imported: "violet", inferred: "amber", planned: "fuchsia", sample: "zinc" };

export default function ProvenanceBadge({ value }) {
  if (!value) return null;
  const cls = badgeClass(TONE[value] || "zinc");
  const dashed = value === "planned" || value === "sample" ? "border border-dashed border-current" : "";
  const italic = value === "inferred" || value === "sample" ? "italic" : "";
  return (
    <span className={`${cls} ${dashed} ${italic}`} title={`Provenance: ${LABELS[value] || value}`}>
      {LABELS[value] || value}
    </span>
  );
}