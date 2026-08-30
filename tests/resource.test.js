import { describe, it, expect } from "vitest";
import {
  nodeAllocations, environmentUsage, nodeOversubscription, environmentOversubscription,
  nodeStorageRaw, nodeStorageUsable, directHostedWorkloads,
} from "@/lib/homelab";

const N = (id, o = {}) => ({ id, hostname: id, ...o });
const E = (id, o = {}) => ({ id, name: id, ...o });
const W = (id, o = {}) => ({ id, name: id, ...o });

describe("layered resource accounting", () => {
  it("workload inside environment is not double-counted against the node", () => {
    const node = N("n1", { ram_capacity_gb: 32, logical_cpus: 8 });
    const envs = [E("e1", { current_host: "n1", ram_allocation_gb: 16, cpu_allocation: 4 })];
    const wls = [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 8, cpu_requirement: 2 })];
    const alloc = nodeAllocations(node, wls, envs);
    // counted via env reservation (16), NOT 16 + 8
    expect(alloc.ram).toBe(16);
    expect(alloc.cpu).toBe(4);
  });

  it("direct-hosted legacy workload is counted once", () => {
    const node = N("n1", { ram_capacity_gb: 32 });
    const wls = [W("w1", { current_host: "n1", ram_requirement_gb: 8 })];
    const alloc = nodeAllocations(node, wls, []);
    expect(alloc.ram).toBe(8);
  });

  it("two environments can oversubscribe a physical node", () => {
    const node = N("n1", { ram_capacity_gb: 24 });
    const envs = [E("e1", { current_host: "n1", ram_allocation_gb: 16 }), E("e2", { current_host: "n1", ram_allocation_gb: 16 })];
    const over = nodeOversubscription(node, [], envs, []);
    expect(over.ram).toBe(8);
  });

  it("multiple workloads can oversubscribe their environment", () => {
    const env = E("e1", { cpu_allocation: 8, ram_allocation_gb: 8 });
    const wls = [W("w1", { current_environment: "e1", cpu_requirement: 6, ram_requirement_gb: 6 }), W("w2", { current_environment: "e1", cpu_requirement: 6, ram_requirement_gb: 6 })];
    const over = environmentOversubscription(env, wls);
    expect(over.cpu).toBe(4);
    expect(over.ram).toBe(4);
  });

  it("missing capacity is UNKNOWN (undefined), not zero", () => {
    const node = N("n1", {}); // no ram_capacity_gb, no logical_cpus
    const over = nodeOversubscription(node, [], [], []);
    expect(over.ram).toBeUndefined();
    expect(over.cpu).toBeUndefined();
  });

  it("raw storage and pool usable capacity are not double-counted", () => {
    const node = N("n1");
    const devices = [{ id: "d1", current_node: "n1", capacity_gb: 1000, health: "healthy" }];
    const pools = [{ id: "p1", node: "n1", usable_capacity_gb: 500, state: "active" }];
    const raw = nodeStorageRaw(node, devices);
    const usable = nodeStorageUsable(node, pools);
    expect(raw.raw).toBe(1000);
    expect(usable.usable).toBe(500);
    // nodeAllocations storage draws from pools (usable), not raw device capacity
    const wls = [W("w1", { current_host: "n1", storage_requirement_gb: 460 })];
    const alloc = nodeAllocations(node, wls, []);
    expect(alloc.storage).toBe(460);
    const over = nodeOversubscription(node, wls, [], pools);
    expect(over.storage).toBeUndefined(); // 460 < 500 usable
  });

  it("replacement evaluation excludes the current workload at the correct accounting layer", () => {
    const node = N("n1", { ram_capacity_gb: 32 });
    const envs = [E("e1", { current_host: "n1", ram_allocation_gb: 16 })];
    // w1 currently in env e1 on n1; evaluating re-placing w1 itself
    const wls = [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 8 })];
    const allocIncluding = nodeAllocations(node, wls, envs);
    // nodeAllocations counts env reservation (16) regardless; the workload itself is not added on top
    expect(allocIncluding.ram).toBe(16);
  });

  it("stale current_host with env on a different node is not double-counted", () => {
    const nodeA = N("nA", { ram_capacity_gb: 32 });
    const nodeB = N("nB", { ram_capacity_gb: 32 });
    const envs = [E("e1", { current_host: "nB", ram_allocation_gb: 16 })];
    // workload stale current_host says nA but env is on nB
    const wls = [W("w1", { current_environment: "e1", current_host: "nA", ram_requirement_gb: 8 })];
    const allocA = nodeAllocations(nodeA, wls, envs);
    const allocB = nodeAllocations(nodeB, wls, envs);
    expect(allocA.ram).toBe(0); // not counted on stale host
    expect(allocB.ram).toBe(16); // counted via env reservation only
  });

  it("deleted environment: workload is unresolved, not counted on a stale host", () => {
    const node = N("n1", { ram_capacity_gb: 32 });
    const wls = [W("w1", { current_environment: "e1", current_host: "n1", ram_requirement_gb: 8 })]; // e1 missing
    const alloc = nodeAllocations(node, wls, []);
    expect(alloc.ram).toBe(0);
    expect(directHostedWorkloads(node, wls, [])).toHaveLength(0);
  });

  it("environmentUsage counts only workloads in that environment", () => {
    const env = E("e1");
    const wls = [W("w1", { current_environment: "e1", cpu_requirement: 2 }), W("w2", { current_environment: "e2", cpu_requirement: 5 })];
    const u = environmentUsage(env, wls);
    expect(u.cpu).toBe(2);
    expect(u.count).toBe(1);
  });
});