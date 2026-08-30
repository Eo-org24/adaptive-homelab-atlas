import React from "react";
import { StatusBadge } from "@/lib/homelab";

export function RelatedList({ title, items, route, label, sub, status, tone, goTo, emptyMsg, idFor, routeFor }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">{title}</div>
      {(!items || items.length === 0) ? (
        <p className="text-xs text-muted-foreground">{emptyMsg || "None recorded"}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => {
            const r = routeFor ? routeFor(it) : route;
            const id = idFor ? idFor(it) : it.id;
            return (
              <li key={it.id || id || i} className="flex items-center gap-2 group">
                {r && goTo ? (
                  <button
                    onClick={() => goTo(r, id)}
                    className="text-sm hover:text-sky-500 truncate flex-1 text-left"
                    title={label(it)}
                  >
                    {label(it)}
                  </button>
                ) : (
                  <span className="text-sm truncate flex-1" title={label(it)}>{label(it)}</span>
                )}
                {sub && <span className="text-[11px] text-muted-foreground truncate hidden sm:block">{sub(it)}</span>}
                {status && <StatusBadge value={status(it)} tone={tone ? tone(it) : "zinc"} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SpecGrid({ fields }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      {fields.map((f) => (
        <div key={f.label}>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{f.label}</div>
          <div className="text-sm mt-0.5">{f.value == null || f.value === "" ? "—" : f.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Section({ title, children }) {
  return (
    <div className="border-t border-border pt-4 mt-4 first:border-0 first:pt-0 first:mt-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}