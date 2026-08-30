import React from "react";
import { badgeClass } from "@/lib/homelab";
import { CheckCircle2, XCircle, HelpCircle, MinusCircle } from "lucide-react";

export const ELIG_TONE = { eligible: "emerald", unknown: "amber", ineligible: "rose" };
export const ELIG_LABEL = { eligible: "ELIGIBLE", unknown: "ELIGIBILITY UNKNOWN", ineligible: "INELIGIBLE" };

export function EligibilityBadge({ eligibility }) {
  return <span className={badgeClass(ELIG_TONE[eligibility])}>{ELIG_LABEL[eligibility]}</span>;
}

export function ConstraintRow({ c }) {
  const Icon = c.state === "pass" ? CheckCircle2 : c.state === "fail" ? XCircle : c.state === "unknown" ? HelpCircle : MinusCircle;
  const color = c.state === "pass" ? "text-emerald-500" : c.state === "fail" ? "text-rose-500" : c.state === "unknown" ? "text-amber-500" : "text-muted-foreground";
  return (
    <div className="flex items-start gap-1.5 text-xs">
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${color}`} />
      <span><span className="font-medium">{c.label}</span> <span className="uppercase text-[10px] text-muted-foreground">{c.state}</span> <span className="text-muted-foreground">— {c.detail}</span></span>
    </div>
  );
}

export function PriorityRow({ p }) {
  const stateColor = p.state === "pass" ? "text-emerald-500" : p.state === "warn" ? "text-amber-500" : p.state === "bad" ? "text-rose-500" : "text-muted-foreground";
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">{p.label}</span>
        <span className={`tabular-nums ${stateColor}`}>{p.score}/5 · {p.state}</span>
      </div>
      <div className="text-muted-foreground mt-1">{p.reason}</div>
    </div>
  );
}