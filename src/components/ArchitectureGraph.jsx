import React, { useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import TruthBadge from "@/components/TruthBadge";

const NW = 150, NH = 30, HSP = 190, VSP = 120;
const KIND_COLOR = {
  node: "fill-sky-100 dark:fill-sky-950 stroke-sky-400 text-sky-900 dark:text-sky-100",
  env: "fill-violet-100 dark:fill-violet-950 stroke-violet-400 text-violet-900 dark:text-violet-100",
  workload: "fill-emerald-100 dark:fill-emerald-950 stroke-emerald-400 text-emerald-900 dark:text-emerald-100",
  storage: "fill-amber-100 dark:fill-amber-950 stroke-amber-400 text-amber-900 dark:text-amber-100",
  pool: "fill-orange-100 dark:fill-orange-950 stroke-orange-400 text-orange-900 dark:text-orange-100",
  network: "fill-rose-100 dark:fill-rose-950 stroke-rose-400 text-rose-900 dark:text-rose-100",
  external: "fill-muted stroke-muted-foreground text-muted-foreground",
};
const ROUTE = { node: "/nodes", env: "/environments", workload: "/workloads", storage: "/storage", pool: "/storage-pools", network: "/network", external: null };
const EDGE_COLOR = { added: "#10b981", removed: "#f43f5e", unchanged: "#94a3b8" };

// Deterministic layered SVG graph with pan/zoom/fit, node + edge selection, legend.
export default function ArchitectureGraph({ graph, findings }) {
  const navigate = useNavigate();
  const svgRef = useRef(null);
  const [view, setView] = useState({ tx: 40, ty: 30, scale: 1 });
  const [selNode, setSelNode] = useState(null);
  const [selEdge, setSelEdge] = useState(null);
  const [drag, setDrag] = useState(null);

  const positions = useMemo(() => {
    const byLayer = {};
    graph.nodes.forEach((n) => { (byLayer[n.layer] ||= []).push(n); });
    const map = {};
    Object.keys(byLayer).forEach((layer) => {
      const arr = byLayer[layer].sort((a, b) => a.label.localeCompare(b.label));
      const count = arr.length;
      arr.forEach((n, i) => { map[n.id] = { x: (i - (count - 1) / 2) * HSP, y: Number(layer) * VSP }; });
    });
    return map;
  }, [graph.nodes]);

  const bbox = useMemo(() => {
    const ps = Object.values(positions);
    if (!ps.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: Math.min(...ps.map((p) => p.x)) - NW, minY: Math.min(...ps.map((p) => p.y)) - NH, maxX: Math.max(...ps.map((p) => p.x)) + NW, maxY: Math.max(...ps.map((p) => p.y)) + NH };
  }, [positions]);

  const fit = useCallback(() => {
    const el = svgRef.current; if (!el) return;
    const w = el.clientWidth, h = el.clientHeight;
    const gw = (bbox.maxX - bbox.minX) || 1, gh = (bbox.maxY - bbox.minY) || 1;
    const scale = Math.min(1.1, Math.min(w / gw, h / gh) * 0.9);
    setView({ tx: (w - gw * scale) / 2 - bbox.minX * scale, ty: (h - gh * scale) / 2 - bbox.minY * scale, scale });
  }, [bbox]);

  const onWheel = (e) => { e.preventDefault(); const factor = e.deltaY > 0 ? 0.9 : 1.1; setView((v) => ({ ...v, scale: Math.max(0.2, Math.min(3, v.scale * factor)) })); };
  const onDown = (e) => { if (e.target === e.currentTarget || e.target.tagName === "rect" && e.target.dataset.bg) { setDrag({ x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }); setSelNode(null); setSelEdge(null); } };
  const onMove = (e) => { if (drag) setView((v) => ({ ...v, tx: drag.tx + (e.clientX - drag.x), ty: drag.ty + (e.clientY - drag.y) })); };
  const onUp = () => setDrag(null);

  const nodeFindings = useMemo(() => {
    const m = {};
    (findings || []).forEach((f) => { if (f.affected_id) (m[f.affected_id] ||= []).push(f); });
    return m;
  }, [findings]);

  const nodeById = useMemo(() => Object.fromEntries(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
      <div className="relative">
        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <button onClick={fit} className="text-xs rounded-md border border-border bg-card px-2 py-1 hover:bg-accent">Fit</button>
          <button onClick={() => setView({ tx: 40, ty: 30, scale: 1 })} className="text-xs rounded-md border border-border bg-card px-2 py-1 hover:bg-accent">Reset</button>
        </div>
        <svg
          ref={svgRef}
          className="w-full h-[70vh] rounded-lg border border-border bg-card touch-none cursor-grab"
          onWheel={onWheel}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <rect data-bg x={bbox.minX} y={bbox.minY} width={Math.max(1, bbox.maxX - bbox.minX)} height={Math.max(1, bbox.maxY - bbox.minY)} fill="transparent" />
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#94a3b8" /></marker>
              <marker id="arrow-add" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#10b981" /></marker>
              <marker id="arrow-rem" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#f43f5e" /></marker>
            </defs>
            {graph.edges.map((e) => {
              const a = positions[e.source], b = positions[e.target]; if (!a || !b) return null;
              const color = e.status ? EDGE_COLOR[e.status] : "#94a3b8";
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              const dashed = e.status === "removed" ? "4 3" : "";
              return (
                <g key={e.id} className="cursor-pointer" onClick={(ev) => { ev.stopPropagation(); setSelEdge(e); setSelNode(null); }}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={e.flags?.length ? 2 : 1.4} strokeDasharray={dashed} markerEnd={e.status === "added" ? "url(#arrow-add)" : e.status === "removed" ? "url(#arrow-rem)" : "url(#arrow)"} opacity={0.85} />
                  <rect x={mx - 26} y={my - 8} width={52} height={14} rx={3} className="fill-card stroke-border" />
                  <text x={mx} y={my + 2} textAnchor="middle" className="text-[8px] fill-muted-foreground">{e.type.replace(/-/g, " ")}</text>
                </g>
              );
            })}
            {graph.nodes.map((n) => {
              const p = positions[n.id]; if (!p) return null;
              const sel = selNode?.id === n.id;
              const ring = n.flags.includes("cycle") ? "#f43f5e" : n.flags.includes("added") ? "#10b981" : n.flags.includes("affected") ? "#0ea5e9" : sel ? "#000" : null;
              return (
                <g key={n.id} className="cursor-pointer" onClick={(ev) => { ev.stopPropagation(); setSelNode(n); setSelEdge(null); }} transform={`translate(${p.x - NW / 2} ${p.y - NH / 2})`}>
                  {ring && <rect x={-3} y={-3} width={NW + 6} height={NH + 6} rx={7} fill="none" stroke={ring} strokeWidth={2} />}
                  <rect width={NW} height={NH} rx={5} className={KIND_COLOR[n.kind] || KIND_COLOR.external} strokeWidth={1} />
                  <text x={6} y={12} className="text-[8px] uppercase opacity-70">{n.kind}</text>
                  <text x={6} y={24} className="text-[10px] font-medium" clipPath="inset(0 6px 0 6px)">{n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label}</text>
                  {nodeFindings[n.record?.id]?.length > 0 && <circle cx={NW - 6} cy={6} r={3} className="fill-rose-500" />}
                </g>
              );
            })}
          </g>
        </svg>
        <Legend />
      </div>

      <div className="space-y-3">
        {selNode ? <NodePanel node={selNode} findings={nodeFindings[selNode.record?.id] || []} onNavigate={(route, id) => navigate(`${route}?focus=${id}`)} /> :
         selEdge ? <EdgePanel edge={selEdge} nodeById={nodeById} /> :
         <div className="text-xs text-muted-foreground p-3 rounded-md border border-border">Select a node or edge to inspect it. Pan: drag · Zoom: scroll · Fit: top-right.</div>}
      </div>
    </div>
  );
}

function NodePanel({ node, findings, onNavigate }) {
  const route = ROUTE[node.kind];
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium truncate">{node.label}</span>
        <TruthBadge kind={node.state} />
      </div>
      <div className="text-xs space-y-0.5">
        <Row label="Type" value={node.kind} />
        <Row label="Canonical ID" value={node.canonical_id || "—"} mono />
        <Row label="Lifecycle" value={node.lifecycle || "—"} />
        <Row label="Criticality" value={node.criticality || "—"} />
        {node.flags.length > 0 && <Row label="Flags" value={node.flags.join(", ")} />}
      </div>
      {findings.length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-muted-foreground mb-1">Findings ({findings.length})</div>
          <ul className="space-y-1 max-h-40 overflow-auto">
            {findings.map((f, i) => <li key={i} className="text-[11px]"><span className="font-mono text-muted-foreground">{f.code}</span> {f.title}</li>)}
          </ul>
        </div>
      )}
      {route && <button onClick={() => onNavigate(route, node.record.id)} className="text-xs text-sky-500 hover:underline">Open detail →</button>}
    </div>
  );
}

function EdgePanel({ edge, nodeById }) {
  const s = nodeById[edge.source], t = nodeById[edge.target];
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="text-sm font-medium">{edge.type.replace(/-/g, " ")}</div>
      <div className="text-xs space-y-0.5">
        <Row label="From" value={s ? `${s.label} (${s.kind})` : edge.source} />
        <Row label="To" value={t ? `${t.label} (${t.kind})` : edge.target} />
        <Row label="Kind" value={edge.kind || "—"} />
        <Row label="Provenance" value={edge.provenance || "—"} />
        {edge.status && <Row label="Change" value={edge.status} />}
        {edge.flags?.length > 0 && <Row label="Flags" value={edge.flags.join(", ")} />}
      </div>
      <p className="text-[11px] text-muted-foreground">Edge derived from a real relationship field on the source record — not a separate graph store.</p>
    </div>
  );
}

function Row({ label, value, mono }) { return <div className="flex justify-between gap-2"><span className="text-muted-foreground">{label}</span><span className={mono ? "font-mono text-[11px]" : ""}>{value}</span></div>; }

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      {Object.entries(KIND_COLOR).filter(([k]) => k !== "external").map(([k]) => (
        <span key={k} className="flex items-center gap-1"><span className={`inline-block w-3 h-3 rounded ${KIND_COLOR[k].split(" ").find((c) => c.startsWith("fill-"))}`} />{k}</span>
      ))}
      <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-rose-500" />cycle</span>
      <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-emerald-500" />added</span>
      <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5" style={{ borderTop: "2px dashed #f43f5e" }} />removed</span>
    </div>
  );
}