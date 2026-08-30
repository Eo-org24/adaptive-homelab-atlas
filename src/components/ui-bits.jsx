import React from "react";

export function StatCard({ label, value, sub, icon: Icon, tone = "zinc", onClick }) {
  const tones = {
    zinc: "text-foreground",
    emerald: "text-emerald-600 dark:text-emerald-400",
    sky: "text-sky-600 dark:text-sky-400",
    amber: "text-amber-600 dark:text-amber-400",
    rose: "text-rose-600 dark:text-rose-400",
    violet: "text-violet-600 dark:text-violet-400",
    orange: "text-orange-600 dark:text-orange-400",
  };
  return (
    <button
      onClick={onClick}
      className="text-left rounded-xl border border-border bg-card p-4 hover:border-foreground/20 transition-colors group"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</span>
        {Icon && <Icon className={`w-4 h-4 ${tones[tone]}`} />}
      </div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </button>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }) {
  return (
    <div className={`rounded-xl border border-border bg-card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          {title && <h3 className="text-sm font-medium">{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {Icon && <Icon className="w-8 h-8 text-muted-foreground/40 mb-2" />}
      <p className="text-sm font-medium">{title}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}