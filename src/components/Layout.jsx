import React, { useState, useEffect, useRef } from "react";
import { NavLink, useNavigate, Outlet } from "react-router-dom";
import {
  LayoutDashboard, Server, Boxes, Network, HardDrive, Gauge, GitBranch,
  Scale, Wrench, ListTodo, Activity, Settings, Search, Sun, Moon, LogOut, X,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { globalSearch } from "@/lib/homelab";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/nodes", label: "Nodes", icon: Server },
  { to: "/workloads", label: "Workloads", icon: Boxes },
  { to: "/network", label: "Network", icon: Network },
  { to: "/storage", label: "Storage", icon: HardDrive },
  { to: "/capacity", label: "Capacity", icon: Gauge },
  { to: "/change-planner", label: "Change Planner", icon: GitBranch },
  { to: "/decisions", label: "Decisions", icon: Scale },
  { to: "/maintenance", label: "Maintenance", icon: Wrench },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function Layout() {
  const [dark, setDark] = useState(() => localStorage.getItem("aha-theme") === "dark");
  const [searchOpen, setSearchOpen] = useState(false);
  const [user, setUser] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("aha-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-border bg-sidebar/40">
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sky-500 to-violet-600 flex items-center justify-center">
              <Server className="w-4 h-4 text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Homelab Atlas</div>
              <div className="text-[10px] text-muted-foreground">Adaptive Operations</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                }`
              }
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-3 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
              {(user?.full_name || user?.email || "U").charAt(0).toUpperCase()}
            </div>
            <div className="text-xs min-w-0 flex-1">
              <div className="truncate font-medium">{user?.full_name || "Operator"}</div>
              <div className="truncate text-muted-foreground">{user?.role || ""}</div>
            </div>
            <button onClick={() => base44.auth.logout()} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground" title="Sign out">
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-3 px-4 md:px-6 h-14 border-b border-border bg-background/80 backdrop-blur">
          <button className="md:hidden p-2 rounded-md hover:bg-muted">
            <Server className="w-4 h-4" />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 hover:bg-muted rounded-md px-3 py-1.5 w-full max-w-md transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search nodes, workloads, decisions…</span>
            <kbd className="ml-auto text-[10px] bg-background border border-border rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setDark((d) => !d)}
              className="p-2 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Toggle theme"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Mobile nav */}
        <div className="md:hidden border-b border-border overflow-x-auto">
          <div className="flex gap-1 px-3 py-2">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap ${
                    isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`
                }
              >
                <item.icon className="w-3.5 h-3.5" />
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>

        <main className="flex-1 overflow-y-auto"><Outlet /></main>
      </div>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onNavigate={(r) => { setSearchOpen(false); navigate(r.route + (r.id ? `?focus=${r.id}` : "")); }} />
    </div>
  );
}

function SearchModal({ open, onClose, onNavigate }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setQ(""); setResults([]); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await globalSearch(q);
      setResults(r); setLoading(false);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search across the whole homelab…"
            className="flex-1 bg-transparent outline-none text-sm"
          />
          <button onClick={onClose} className="p-1 rounded-md hover:bg-muted"><X className="w-4 h-4" /></button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {loading && <div className="px-4 py-6 text-sm text-muted-foreground text-center">Searching…</div>}
          {!loading && q.trim().length >= 2 && results.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">No matches.</div>
          )}
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => onNavigate(r)}
              className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-muted/60 border-b border-border/50 last:border-0"
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted rounded px-1.5 py-0.5 w-24 text-center shrink-0">{r.entity}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">{r.name}</span>
                {r.sub && <span className="block text-xs text-muted-foreground truncate">{r.sub}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}