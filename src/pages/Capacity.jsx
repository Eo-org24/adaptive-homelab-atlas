import React, { useMemo, useState } from "react";
import { useArchitectureDataset } from "@/hooks/useArchitectureDataset";
import { PageHeader, Card } from "@/components/ui-bits";
import { fmtGB, nodeAllocations, nodeStorageRaw, nodeStorageUsable, directHostedWorkloads, environmentUsage, scorePlacement, aggregateKnown, nodeMemoryCapacity, fmtMemValue, memoryCapacityGB } from "@/lib/homelab";
import { realDataset } from "@/lib/provenance";
import { EligibilityBadge, ConstraintRow, PriorityRow } from "@/components/PlacementBits";
import { Cpu, MemoryStick, Monitor, HardDrive, Database } from "lucide-react";

const LOAD = ["Node", "Workload", "ExecutionEnvironment", "StorageDevice", "StoragePool"];

function ResBar({ allocated, total, tone = "sky" }) {
  const tones = { sky: "bg-sky-500", emerald: "bg-emerald-500", amber: "bg-amber-500", violet: "bg-violet-500" };
  if (total == null) return null;
  const pct = total > 0 ? Math.min(100, (allocated / total) * 100) : 0;
  return <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className={`h-full ${tones[tone]}`} style={{ width: `${pct}%` }} /></div>;
}

export default function Capacity() {
  const { data: rawData, complete, incompleteEntities, loading } = useArchitectureDataset(LOAD);
  // Exclude sample AND fixture records from operational capacity calculations.
  const data = useMemo(() => realDataset(rawData), [rawData]);
  const nodes = data.Node || [];
  const workloads = data.Workload || [];
  const envs = data.ExecutionEnvironment || [];
  const pools = data.StoragePool || [];
  const storageDevices = data.StorageDevice || [];
  const [hypWL, setHypWL] = useState("");
  const [hypNode, setHypNode] = useState("");

  const rows = useMemo(() => nodes.map((n) => {
    const alloc = nodeAllocations(n, workloads, envs);
    return {
      node: n, alloc,
      envsOnNode: envs.filter((e) => e.current_host === n.id),
      direct: directHostedWorkloads(n, workloads, envs),
      raw: nodeStorageRaw(n, storageDevices),
      usable: nodeStorageUsable(n, pools),
    };
  }), [nodes, workloads, envs, pools, storageDevices]);

  const hypResult = useMemo(() => {
    if (!hypWL || !hypNode) return null;
    const wl = workloads.find((w) => w.id === hypWL);
    const node = nodes.find((n) => n.id === hypNode);
    if (!wl || !node) return null;
    return { wl, node, res: scorePlacement(wl, node, { envs, workloads, pools }) };
  }, [hypWL, hypNode, workloads, nodes, envs, pools]);

  const cpuCap = (n) => (n.logical_cpus != null ? n.logical_cpus : n.physical_cores);
  const cpuAgg = useMemo(() => nodes.map((n) => ({ v: cpuCap(n) })), [nodes]);
  const cpuKnown = useMemo(() => aggregateKnown(cpuAgg, "v"), [cpuAgg]);
  // Normalize to GB for the aggregate sum (memoryCapacityGB converts GiB -> GB).
  const ramAgg = useMemo(() => aggregateKnown(nodes.map((n) => ({ v: memoryCapacityGB(n) })), "v"), [nodes]);
  const vramAgg = useMemo(() => aggregateKnown(nodes, "gpu_vram_gb"), [nodes]);
  const poolAgg = useMemo(() => aggregateKnown(pools, "usable_capacity_gb"), [pools]);

  if (loading) return <div className="p-6"><div className="w-8 h-8 border-4 border-muted border-t-foreground rounded-full animate-spin mx-auto mt-20" /></div>;

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <PageHeader title="Capacity" description="Documented capacity versus allocation across physical nodes and execution environments. No remote control — documented state only." />

      {!complete && (
        <Card className="p-4 mb-4 border-rose-500/30 bg-rose-500/5">
          <div className="flex items-start gap-2">
            <Database className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-rose-600 dark:text-rose-400">DATASET INCOMPLETE</div>
              <p className="text-xs text-muted-foreground mt-1">Capacity totals may be understated due to an incomplete dataset load. Results are not authoritative.</p>
              {incompleteEntities.length > 0 && <p className="text-[11px] text-muted-foreground mt-1">Affected: {incompleteEntities.join(", ")}</p>}
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Cpu className="w-3.5 h-3.5" /> Total CPU</div><div className="text-2xl font-semibold mt-1">{cpuKnown.sum}</div><div className="text-xs text-muted-foreground">{cpuKnown.unknownCount > 0 ? `${cpuKnown.unknownCount} node${cpuKnown.unknownCount !== 1 ? "s" : ""} undocumented` : "logical CPUs"}</div></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><MemoryStick className="w-3.5 h-3.5" /> Total RAM</div><div className="text-2xl font-semibold mt-1">{fmtGB(ramAgg.sum)}</div><div className="text-xs text-muted-foreground">{ramAgg.unknownCount > 0 ? `${ramAgg.unknownCount} node${ramAgg.unknownCount !== 1 ? "s" : ""} undocumented` : "documented capacity (GB)"}</div></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><Monitor className="w-3.5 h-3.5" /> GPU VRAM</div><div className="text-2xl font-semibold mt-1">{fmtGB(vramAgg.sum)}</div><div className="text-xs text-muted-foreground">{vramAgg.unknownCount > 0 ? `${vramAgg.unknownCount} node${vramAgg.unknownCount !== 1 ? "s" : ""} undocumented` : "documented capacity"}</div></Card>
        <Card className="p-4"><div className="flex items-center gap-2 text-muted-foreground text-xs"><HardDrive className="w-3.5 h-3.5" /> Pools usable</div><div className="text-2xl font-semibold mt-1">{fmtGB(poolAgg.sum)}</div><div className="text-xs text-muted-foreground">{poolAgg.unknownCount > 0 ? `${poolAgg.unknownCount} pool${poolAgg.unknownCount !== 1 ? "s" : ""} undocumented` : "documented capacity"}</div></Card>
      </div>

      <div className="space-y-4">
        {rows.map((r) => {
          const n = r.node;
          const mem = nodeMemoryCapacity(n);
          const memAlloc = mem.unit === "GiB" ? r.alloc.ram * 0.9313225746 : r.alloc.ram;
          const memFmt = (v) => fmtMemValue(v, mem.unit);
          return (
            <Card key={n.id} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-medium">{n.hostname}</div>
                  <div className="text-[11px] text-muted-foreground capitalize">{n.node_type} · {n.lifecycle_state}</div>
                </div>
                {r.direct.length > 0 && <span className="text-[11px] text-amber-600 dark:text-amber-400">{r.direct.length} direct-hosted (legacy)</span>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <ResCell label="CPU (cores)" allocated={r.alloc.cpu} total={cpuCap(n)} tone="emerald" />
                <ResCell label={`RAM (${mem.unit || "—"})`} allocated={memAlloc} total={mem.value} tone="sky" fmt={memFmt} />
                <ResCell label="GPU VRAM" allocated={r.alloc.vram} total={n.gpu_vram_gb} tone="violet" fmt={fmtGB} />
                <StorageCell raw={r.raw} usable={r.usable} allocated={r.alloc.storage} />
              </div>

              {r.envsOnNode.length > 0 && (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">Execution environments ({r.envsOnNode.length})</div>
                  <div className="space-y-1.5">
                    {r.envsOnNode.map((e) => {
                      const usage = environmentUsage(e, workloads);
                      return (
                        <div key={e.id} className="text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-medium">{e.name}</span>
                          <span className="text-muted-foreground">CPU {usage.cpu}/{e.cpu_allocation ?? "?"}</span>
                          <span className="text-muted-foreground">RAM {fmtGB(usage.ram)}/{fmtGB(e.ram_allocation_gb)}</span>
                          <span className="text-muted-foreground">Storage {fmtGB(usage.storage)}/{fmtGB(e.storage_allocation_gb)}</span>
                          <span className="text-muted-foreground">· {usage.count} workload{usage.count !== 1 ? "s" : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {r.direct.length > 0 && (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="text-[11px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-medium mb-2">Direct-hosted workloads (legacy — normalize to an environment)</div>
                  <div className="flex flex-wrap gap-1.5">{r.direct.map((w) => <span key={w.id} className="text-xs rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2 py-0.5">{w.name}</span>)}</div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card title="Hypothetical workload placement" className="mt-4 p-4">
        <p className="text-xs text-muted-foreground mb-3">Preview placement of a workload on a candidate node. Nothing is saved. Hard constraints determine eligibility; priorities rank eligible candidates lexicographically.</p>
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <select value={hypWL} onChange={(e) => setHypWL(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm flex-1">
            <option value="">Select workload…</option>
            {workloads.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <select value={hypNode} onChange={(e) => setHypNode(e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm flex-1">
            <option value="">Select candidate node…</option>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.hostname}</option>)}
          </select>
        </div>
        {hypResult && (
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm">Placing <span className="font-medium">{hypResult.wl.name}</span> on <span className="font-medium">{hypResult.node.hostname}</span></div>
              <div className="flex items-center gap-2"><EligibilityBadge eligibility={hypResult.res.eligibility} /><span className="text-[11px] text-muted-foreground">confidence: {hypResult.res.confidence}</span></div>
            </div>
            {hypResult.res.hardConstraints.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mb-3">{hypResult.res.hardConstraints.map((c) => <ConstraintRow key={c.key} c={c} />)}</div>
            )}
            {hypResult.res.priorities.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{hypResult.res.priorities.map((p) => <PriorityRow key={p.key} p={p} />)}</div>
            )}
            {hypResult.res.unverified.length > 0 && (
              <ul className="mt-2 space-y-1">{hypResult.res.unverified.map((u, i) => <li key={i} className="text-[11px] text-amber-600 dark:text-amber-400 italic">⚠ unverified: {u}</li>)}</ul>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function ResCell({ label, allocated, total, tone, fmt }) {
  const f = fmt || ((v) => v);
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="text-xs tabular-nums mt-0.5">
        {total == null ? <span className="italic text-muted-foreground">capacity unknown</span> : <>{f(allocated)} / {f(total)} <span className="text-muted-foreground">({f(Math.max(0, total - allocated))} free)</span></>}
      </div>
      <div className="mt-1"><ResBar allocated={allocated} total={total} tone={tone} /></div>
    </div>
  );
}

function StorageCell({ raw, usable, allocated }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Storage</div>
      <div className="text-xs mt-0.5">
        {usable.known ? <>usable {fmtGB(usable.usable)} · alloc {fmtGB(allocated)}</> : raw.known ? <>raw {fmtGB(raw.raw)} · <span className="italic text-muted-foreground">usable not modeled</span></> : <span className="italic text-muted-foreground">not modeled</span>}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{raw.known ? `raw devices ${fmtGB(raw.raw)}` : "no devices documented"}</div>
    </div>
  );
}