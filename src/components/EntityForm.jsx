import React, { useState, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";

const LONG_TEXT = ["notes", "description", "context", "decision", "rationale", "alternatives", "consequences", "proposed_actions", "prerequisites", "expected_result", "rollback_strategy", "reason", "before_state", "actions", "after_state", "operator_notes", "purchase_notes", "ram_configuration", "power_supply", "motherboard", "intended_purpose"];

// Generic schema-driven form. refOptions: { fieldKey: [{value,label}] } forces a select.
export default function EntityForm({ entityName, initial, onSubmit, onCancel, refOptions = {}, hidden = [], fieldOverrides = {} }) {
  const [schema, setSchema] = useState(null);
  const [value, setValue] = useState(initial || {});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    base44.entities[entityName].schema().then((s) => { if (alive) setSchema(s); }).catch(() => { if (alive) setSchema(null); });
    return () => { alive = false; };
  }, [entityName]);

  const props = schema?.properties || {};
  const required = schema?.required || [];

  const set = (k, v) => setValue((p) => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setErr(null);
    try { await onSubmit(cleanValue(value, props)); }
    catch (ex) { setErr(ex?.message || "Save failed"); setSaving(false); }
  };

  if (!schema) return <div className="p-4 text-sm text-muted-foreground">Loading form…</div>;

  const keys = Object.keys(props).filter((k) => !hidden.includes(k));

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {keys.map((key) => {
          const field = props[key];
          const isLong = LONG_TEXT.includes(key) || (field.type === "string" && !field.enum && key.length > 10 && !refOptions[key]);
          const isReq = required.includes(key);
          const label = field.title || key.replace(/_/g, " ");
          if (fieldOverrides[key]) {
            return (
              <div key={key} className="space-y-1.5 sm:col-span-2">
                {fieldOverrides[key]({ value, set, field, fieldKey: key, label, isReq })}
              </div>
            );
          }
          if (refOptions[key]) {
            return (
              <div key={key} className="space-y-1.5">
                <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={value[key] || ""}
                  onChange={(e) => set(key, e.target.value)}
                >
                  <option value="">—</option>
                  {refOptions[key].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            );
          }
          if (field.enum) {
            return (
              <div key={key} className="space-y-1.5">
                <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm capitalize"
                  value={value[key] || field.default || ""}
                  onChange={(e) => set(key, e.target.value)}
                >
                  {field.enum.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
                </select>
              </div>
            );
          }
          if (field.type === "boolean") {
            return (
              <div key={key} className="flex items-center justify-between rounded-md border border-input px-3 py-2.5">
                <Label className="text-xs font-medium">{label}</Label>
                <Switch checked={!!value[key]} onCheckedChange={(v) => set(key, v)} />
              </div>
            );
          }
          if (field.type === "number") {
            return (
              <div key={key} className="space-y-1.5">
                <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>
                <Input type="number" step="any" value={value[key] ?? ""} onChange={(e) => set(key, e.target.value === "" ? "" : Number(e.target.value))} />
              </div>
            );
          }
          if (field.type === "array") {
            return (
              <div key={key} className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs font-medium">{label}</Label>
                <Input
                  placeholder="comma-separated"
                  value={Array.isArray(value[key]) ? value[key].join(", ") : (value[key] || "")}
                  onChange={(e) => set(key, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                />
              </div>
            );
          }
          if (field.format === "date" || field.format === "date-time") {
            return (
              <div key={key} className="space-y-1.5">
                <Label className="text-xs font-medium">{label}</Label>
                <Input type={field.format === "date-time" ? "datetime-local" : "date"} value={(value[key] || "").slice(0, field.format === "date-time" ? 16 : 10)} onChange={(e) => set(key, e.target.value)} />
              </div>
            );
          }
          if (isLong) {
            return (
              <div key={key} className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>
                <Textarea rows={3} value={value[key] || ""} onChange={(e) => set(key, e.target.value)} />
              </div>
            );
          }
          return (
            <div key={key} className="space-y-1.5">
              <Label className="text-xs font-medium">{label}{isReq && <span className="text-rose-500"> *</span>}</Label>
              <Input value={value[key] || ""} onChange={(e) => set(key, e.target.value)} />
            </div>
          );
        })}
      </div>
      {err && <div className="text-sm text-rose-500">{err}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}

function cleanValue(v, props) {
  const out = { ...v };
  Object.keys(out).forEach((k) => {
    const f = props[k];
    if (f?.type === "number" && out[k] === "") out[k] = null;
  });
  return out;
}