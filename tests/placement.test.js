import { describe, it, expect } from "vitest";
import { scorePlacement } from "@/lib/homelab";

const N = (id, o = {}) => ({ id, hostname: id, ...o });
const W = (id, o = {}) => ({ id, name: id, ...o });

// Rank a set of candidate nodes for a single workload. Lower rankKey = better.
function rank(wl, nodes, opts = {}) {
  return nodes
    .map((n) => ({ node: n, res: scorePlacement(wl, n, { workloads: [wl, ...(opts.others || [])], envs: opts.envs || [], pools: opts.pools || [] }) }))
    .sort((a, b) => String(a.res.rankKey).localeCompare(String(b.res.rankKey)));
}

describe("placement invariants", () => {
  it("an INELIGIBLE candidate can never rank above an ELIGIBLE candidate", () => {
    const wl = W("w1", { ram_requirement_gb: 8, cpu_requirement: 2, availability_requirement: "best_effort" });
    const good = N("good", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const bad = N("bad", { ram_capacity_gb: 4, logical_cpus: 1, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 5 }); // too little RAM -> fail
    const r = rank(wl, [bad, good]);
    expect(r[0].node.id).toBe("good");
    expect(r[0].res.eligibility).toBe("eligible");
    expect(r[1].res.eligibility).toBe("ineligible");
  });

  it("an ELIGIBILITY UNKNOWN candidate cannot become RECOMMENDED while a known-eligible candidate exists", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const known = N("known", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const unknown = N("unknown", { logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // no ram_capacity_gb -> unknown
    const r = rank(wl, [unknown, known]);
    expect(r[0].node.id).toBe("known");
    expect(r[0].res.eligibility).toBe("eligible");
    expect(r[1].res.eligibility).toBe("unknown");
  });

  it("a hard FAIL cannot be offset by performance", () => {
    const wl = W("w1", { ram_requirement_gb: 32, availability_requirement: "best_effort" });
    const tiny = N("tiny", { ram_capacity_gb: 4, logical_cpus: 128, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // huge CPU but RAM fail
    const fit = N("fit", { ram_capacity_gb: 64, logical_cpus: 2, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const r = rank(wl, [tiny, fit]);
    expect(r[0].node.id).toBe("fit");
    expect(r.find((x) => x.node.id === "tiny").res.eligibility).toBe("ineligible");
  });

  it("performance cannot compensate for a materially worse higher-order simplicity outcome", () => {
    const wl = W("w1", { cpu_requirement: 2, availability_requirement: "best_effort", preferred_node: "simple" });
    const simple = N("simple", { ram_capacity_gb: 64, logical_cpus: 4, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const perf = N("perf", { ram_capacity_gb: 64, logical_cpus: 128, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // not preferred
    const r = rank(wl, [perf, simple]);
    expect(r[0].node.id).toBe("simple"); // preferred -> simplicity wins
  });

  it("reliability outranks power efficiency", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const reliable = N("reliable", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 200 }); // bad power
    const flaky = N("flaky", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "degraded", availability_expectation: "best_effort", idle_power_w: 5 }); // great power, bad reliability
    const r = rank(wl, [flaky, reliable]);
    expect(r[0].node.id).toBe("reliable");
  });

  it("power efficiency outranks scalability", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const efficient = N("eff", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // power pass, modest headroom
    const roomy = N("roomy", { ram_capacity_gb: 1024, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 200 }); // huge headroom, bad power
    const r = rank(wl, [roomy, efficient]);
    expect(r[0].node.id).toBe("eff");
  });

  it("scalability outranks performance", () => {
    const wl = W("w1", { ram_requirement_gb: 8, cpu_requirement: 4, availability_requirement: "best_effort" });
    const roomy = N("roomy", { ram_capacity_gb: 1024, logical_cpus: 8, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // big headroom, modest CPU
    const perf = N("perf", { ram_capacity_gb: 16, logical_cpus: 128, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // big CPU, tight headroom
    const r = rank(wl, [perf, roomy]);
    expect(r[0].node.id).toBe("roomy");
  });

  it("identical inputs produce identical ranking", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const nodes = [N("a", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }), N("b", { ram_capacity_gb: 32, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 20 })];
    const r1 = rank(wl, nodes).map((x) => x.node.id);
    const r2 = rank(wl, nodes).map((x) => x.node.id);
    expect(r1).toEqual(r2);
  });

  it("input array order does not change the recommendation", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const a = N("a", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 });
    const b = N("b", { ram_capacity_gb: 32, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 50 });
    const c = N("c", { ram_capacity_gb: 16, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 200 });
    const orders = [[a, b, c], [c, b, a], [b, a, c]];
    const tops = orders.map((o) => rank(wl, o)[0].node.id);
    expect(new Set(tops).size).toBe(1);
  });

  it("missing requirement evidence must not become PASS (unknown -> eligibility unknown)", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const node = N("n", { logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort", idle_power_w: 10 }); // no ram capacity
    const res = scorePlacement(wl, node, { workloads: [wl] });
    expect(res.eligibility).toBe("unknown");
    expect(res.hardConstraints.find((c) => c.key === "ram").state).toBe("unknown");
  });

  it("missing idle power is UNKNOWN, not zero watts", () => {
    const wl = W("w1", { ram_requirement_gb: 8, availability_requirement: "best_effort" });
    const node = N("n", { ram_capacity_gb: 64, logical_cpus: 16, lifecycle_state: "active", availability_expectation: "best_effort" }); // no idle_power_w
    const res = scorePlacement(wl, node, { workloads: [wl] });
    const power = res.priorities.find((p) => p.key === "power");
    expect(power.state).toBe("unknown");
  });
});