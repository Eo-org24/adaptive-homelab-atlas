import React from "react";
import ProvenanceField from "@/components/ProvenanceField";
import ObservationPanel from "@/components/ObservationPanel";
import { Section } from "@/components/Related";

// Renders provenance-aware fields for a record + its observation panel.
// fields: [{ label, field, format }]
export default function ProvenanceSection({ record, objectType, fields }) {
  if (!record) return null;
  return (
    <Section title="Truth & provenance">
      <div>
        {fields.map((f) => <ProvenanceField key={f.field} record={record} field={f.field} label={f.label} format={f.format} />)}
      </div>
      <div className="mt-3">
        <ObservationPanel canonicalId={record.canonical_id} objectType={objectType} />
      </div>
    </Section>
  );
}