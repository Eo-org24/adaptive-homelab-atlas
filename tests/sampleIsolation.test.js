import { describe, it, expect } from "vitest";
import { scorePlacement, aggregateKnown } from "@/lib/homelab";
import { realDataset, isSample } from "@/lib/provenance";

const N = (id, o = {}) => ({ id, hostname: id, ...o });
const W = (id, o = {}) => ({ id, name: id, ...o });

describe("sample data isolation", () => {
  it("isSample detects sample records", () => {
    expect(isSample(W("a", { source_kind: "sample" }))).toBe(true);
    expect(isSample(W("a", { state_classification: "sample" }))).toBe(true);
    expect(isSample(W("a", { source_kind: "manual" }))).toBe(false);
    expect(isSample(W("a", {}))).toBe(false);
    expect(isSample(null)).toBe(false);
  });

  it("realDataset strips sample records from every entity array", () => {
    const data = {
      Node: [N("real"), N("samp", { source_kind: "sample" })],
      Workload: [W("w1"), W("w2", { state_classification: "sample" })],
      ExecutionEnvironment: [],
    };
    const real = realDataset(data);
    expect(real.Node.length).toBe(1);
    expect(real.Node[0].id).toBe("real");
    expect(real.Workload.length).toBe(1);
    expect(real.Workload[0].id).toBe("w1");
  });

  it("realDataset is a no-op when includeSample is true", () => {
    const data = { Node: [N("real"), N("samp", { source_kind: "sample" })] };
    const out = realDataset(data, { includeSample: true });
    expect(out.Node.length).toBe(2);
  });

  it("a sample workload consuming all node RAM must NOT make a real workload ineligible", () => {
    // A real workload needs 8GB; the node has 16GB. A *sample* workload also
    // claims 16GB. If sample data leaked into placement accounting, the real
    // workload would be marked ineligible (no free RAM). With sample isolation,
    // the sample workload is ignored and placement is eligible.
    const node = N("n", { ram_capacity_gb: 16, logical_cpus: 8, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const real = W("real", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const sample = W("samp", { ram_requirement_gb: 16, source_kind: "sample", availability_requirement: "best_effort" });

    // Without filtering (the bug): sample inflates node allocation -> fail.
    const raw = scorePlacement(real, node, { workloads: [real, sample], envs: [], pools: [] });
    // With defensive filtering inside scorePlacement (others excludes sample):
    expect(raw.eligibility).toBe("eligible");
    expect(raw.hardConstraints.find((c) => c.key === "ram").state).toBe("pass");
  });

  it("a sample workload must not appear in node allocation even via realDataset path", () => {
    const node = N("n", { ram_capacity_gb: 16, logical_cpus: 8, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const real = W("real", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const sample = W("samp", { ram_requirement_gb: 16, state_classification: "sample", availability_requirement: "best_effort" });
    const data = { Node: [node], Workload: [real, sample], ExecutionEnvironment: [] };
    const filtered = realDataset(data);
    const res = scorePlacement(real, node, { workloads: filtered.Workload, envs: filtered.ExecutionEnvironment, pools: [] });
    expect(res.eligibility).toBe("eligible");
  });
});

describe("completeness-aware aggregates", () => {
  it("aggregateKnown sums documented values and counts undocumented separately", () => {
    const rows = [{ ram_capacity_gb: 16 }, { ram_capacity_gb: 32 }, { ram_capacity_gb: null }, {}];
    const agg = aggregateKnown(rows, "ram_capacity_gb");
    expect(agg.sum).toBe(48);
    expect(agg.unknownCount).toBe(2);
    expect(agg.knownCount).toBe(2);
  });

  it("aggregateKnown handles NaN as unknown", () => {
    const rows = [{ ram_capacity_gb: 16 }, { ram_capacity_gb: NaN }];
    const agg = aggregateKnown(rows, "ram_capacity_gb");
    expect(agg.sum).toBe(16);
    expect(agg.unknownCount).toBe(1);
  });

  it("aggregateKnown handles empty/null input", () => {
    expect(aggregateKnown(null, "x")).toEqual({ sum: 0, unknownCount: 0, knownCount: 0 });
    expect(aggregateKnown([], "x")).toEqual({ sum: 0, unknownCount: 0, knownCount: 0 });
  });
});