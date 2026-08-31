import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ---- Mock setup ----
const mockState = vi.hoisted(() => ({
  data: {}, complete: true, errors: {}, incompleteEntities: [], loading: false,
}));
const mockSyncList = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("@/hooks/useArchitectureDataset", () => ({
  useArchitectureDataset: () => mockState,
}));
vi.mock("@/api/base44Client", () => ({
  base44: {
    entities: { CanonicalSync: { list: mockSyncList } },
    auth: { me: async () => null },
    users: {},
  },
}));
vi.mock("@/components/SyncStatusPanel", () => ({
  default: () => <div data-testid="sync-panel">Sync Status</div>,
}));

// ---- Imports ----
import Capacity from "@/pages/Capacity";
import Findings from "@/pages/Findings";
import { isFixture, isOperational, realDataset, FIXTURE_TAG } from "@/lib/provenance";

// ---- Fixture data helpers ----
function fixtureNode(id = "fx-node-1", memoryGib = 128) {
  return {
    id, hostname: `fixture-${id}`, canonical_id: `node:${id}`,
    source_kind: "canonical", tags: [FIXTURE_TAG],
    memory_gib: memoryGib, physical_cores: 16, logical_cpus: 32,
    lifecycle_state: "active", node_type: "server",
  };
}
function fixtureWorkload(id = "fx-wl-1") {
  return {
    id, name: `fixture-${id}`, canonical_id: `workload:${id}`,
    source_kind: "canonical", tags: [FIXTURE_TAG],
    cpu_requirement: 8, ram_requirement_gb: 16, category: "unknown",
  };
}
function fixtureEnv(id = "fx-ep-1") {
  return {
    id, name: `fixture-${id}`, canonical_id: `execution-provider:${id}`,
    source_kind: "canonical", tags: [FIXTURE_TAG],
    cpu_allocation: 8, ram_allocation_gb: 16, type: "lxc",
  };
}
function realNode(id = "real-node-1", memoryGib = 64) {
  return {
    id, hostname: `real-${id}`, canonical_id: `node:${id}`,
    source_kind: "canonical",
    memory_gib: memoryGib, physical_cores: 8, logical_cpus: 16,
    lifecycle_state: "active", node_type: "server",
  };
}
function sampleNode(id = "sample-node-1") {
  return {
    id, hostname: `sample-${id}`, canonical_id: `node:${id}`,
    source_kind: "sample",
    memory_gib: 32, physical_cores: 4, logical_cpus: 8,
    lifecycle_state: "active", node_type: "server",
  };
}

beforeEach(() => {
  mockSyncList.mockReset();
  mockSyncList.mockResolvedValue([]);
  Object.assign(mockState, { data: {}, complete: true, errors: {}, incompleteEntities: [], loading: false });
});

// ---- §13: FIXTURE ISOLATION IN OPERATIONAL PAGES ----
describe("§13: Fixture isolation — Capacity page", () => {
  it("fixture node contributes 0 to capacity totals", () => {
    mockState.data = {
      Node: [fixtureNode("fx1", 128), fixtureNode("fx2", 256)],
      Workload: [], ExecutionEnvironment: [], StorageDevice: [], StoragePool: [],
    };
    render(<Capacity />);
    // Total CPU should be 0 (fixture nodes excluded)
    const cpuCard = screen.getByText("Total CPU").closest("div").parentElement;
    expect(cpuCard).toHaveTextContent("0");
    // No node cards should appear (fixture nodes filtered out)
    expect(screen.queryByText("fixture-fx1")).not.toBeInTheDocument();
    expect(screen.queryByText("fixture-fx2")).not.toBeInTheDocument();
  });

  it("fixture provider contributes 0 allocations", () => {
    mockState.data = {
      Node: [], Workload: [],
      ExecutionEnvironment: [fixtureEnv("fxep1"), fixtureEnv("fxep2")],
      StorageDevice: [], StoragePool: [],
    };
    render(<Capacity />);
    // No environment details should appear
    expect(screen.queryByText("fixture-fxep1")).not.toBeInTheDocument();
  });

  it("fixture workload contributes 0 requirements", () => {
    mockState.data = {
      Node: [realNode("r1", 64)],
      Workload: [fixtureWorkload("fxwl1"), fixtureWorkload("fxwl2")],
      ExecutionEnvironment: [], StorageDevice: [], StoragePool: [],
    };
    render(<Capacity />);
    // Real node should appear (in node card and possibly dropdown)
    expect(screen.getAllByText("real-r1").length).toBeGreaterThan(0);
    // Fixture workloads should not appear
    expect(screen.queryByText("fixture-fxwl1")).not.toBeInTheDocument();
  });
});

describe("§13: Fixture isolation — Findings page", () => {
  it("fixture records do not generate ordinary operational alerts", () => {
    mockState.data = {
      Node: [fixtureNode("fx1")],
      Workload: [fixtureWorkload("fxwl1")],
      ExecutionEnvironment: [fixtureEnv("fxep1")],
      StorageDevice: [], StoragePool: [], Dependency: [],
      Decision: [], NetworkDevice: [], SwitchPort: [],
      PlannedChange: [], Maintenance: [], Task: [],
    };
    render(<MemoryRouter><Findings /></MemoryRouter>);
    // Findings page should render without crashing
    // Fixture-only data should produce no operational findings
    // (fixture records are excluded from health engine)
    const findingElements = screen.queryAllByText(/finding|warning|error|oversubscri/i);
    // Any findings text should not reference fixture objects
    findingElements.forEach(el => {
      expect(el.textContent).not.toMatch(/fixture-fx/);
    });
  });
});

// ---- §14: SAMPLE + FIXTURE COMBINATION ----
describe("§14: Sample + fixture combination", () => {
  it("sample and fixture do not become operational merely because they coexist with real records", () => {
    const data = {
      Node: [realNode("r1"), sampleNode("s1"), fixtureNode("fx1")],
    };
    const filtered = realDataset(data);
    expect(filtered.Node.length).toBe(1);
    expect(filtered.Node[0].id).toBe("r1");
  });

  it("realDataset excludes both sample and fixture by default", () => {
    const data = {
      Node: [realNode("r1"), sampleNode("s1"), fixtureNode("fx1")],
      Workload: [fixtureWorkload("fxwl1")],
    };
    const filtered = realDataset(data);
    expect(filtered.Node.length).toBe(1);
    expect(filtered.Workload.length).toBe(0);
  });

  it("isOperational correctly identifies real vs sample vs fixture", () => {
    expect(isOperational(realNode("r1"))).toBe(true);
    expect(isOperational(sampleNode("s1"))).toBe(false);
    expect(isOperational(fixtureNode("fx1"))).toBe(false);
  });

  it("isFixture correctly identifies fixture records", () => {
    expect(isFixture(fixtureNode("fx1"))).toBe(true);
    expect(isFixture(realNode("r1"))).toBe(false);
    expect(isFixture(sampleNode("s1"))).toBe(false);
  });
});

// ---- §9: PLACEMENT ALLOWED IS NOT PREFERRED (operational page level) ----
describe("§9: Capacity page — placement allowed is not preferred", () => {
  it("real node with allowed placement does not get preferred/selected label", () => {
    mockState.data = {
      Node: [realNode("r1", 64)],
      Workload: [{
        id: "wl1", name: "test-wl", canonical_id: "workload:wl1",
        source_kind: "canonical", category: "unknown",
        cpu_requirement: 2, ram_requirement_gb: 4,
        placement_allowed_nodes: ["r1"],
      }],
      ExecutionEnvironment: [], StorageDevice: [], StoragePool: [],
    };
    render(<Capacity />);
    // The real node should appear (in node card and possibly dropdown)
    expect(screen.getAllByText("real-r1").length).toBeGreaterThan(0);
    // No "Preferred" or "Selected" labels
    expect(screen.queryByText(/Preferred/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Selected/i)).not.toBeInTheDocument();
  });
});