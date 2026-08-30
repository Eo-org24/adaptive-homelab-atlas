import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Renders a select whose options depend on a sibling "type" field, and writes
// both the id field and a denormalized name field. For types in `freeFor`,
// renders a free-text input (name only, id set to the same value so required
// constraints are satisfied).
export default function RefByType({ value, typeValue, idField, nameField, optionsFor, freeFor = [], onChange, label, isReq, placeholder }) {
  const opts = optionsFor(typeValue) || [];
  const isFree = freeFor.includes(typeValue);
  return (
    <div className="space-y-1.5">
      {label && <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>}
      {isFree ? (
        <Input
          value={value[nameField] || ""}
          onChange={(e) => onChange({ [idField]: e.target.value, [nameField]: e.target.value })}
          placeholder={placeholder || "Free-text name"}
        />
      ) : (
        <select
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={value[idField] || ""}
          onChange={(e) => onChange({ [idField]: e.target.value, [nameField]: "" })}
        >
          <option value="">—</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}

// An enum select that, on change, resets the paired id + name fields so a
// stale reference from the previous type doesn't linger.
export function TypeSelect({ value, set, field, fieldKey, label, isReq, idField, nameField }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>
      <select
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm capitalize"
        value={value[fieldKey] || field.default || ""}
        onChange={(e) => {
          set(fieldKey, e.target.value);
          if (idField) set(idField, "");
          if (nameField) set(nameField, "");
        }}
      >
        {(field.enum || []).map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
      </select>
    </div>
  );
}