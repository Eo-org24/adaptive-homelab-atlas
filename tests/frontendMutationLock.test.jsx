import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---- Mock setup (hoisted) ----
const mockState = vi.hoisted(() => ({
  data: {}, complete: true, errors: {}, incompleteEntities: [], loading: false,
}));
const mockSyncList = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockRunImport = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunRepair = vi.hoisted(() => vi.fn());
const mockPreviewRepair = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useArchitectureDataset", () => ({
  useArchitectureDataset: () => ({ ...mockState, refresh: mockRefresh }),
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
vi.mock("@/lib/canonicalImport", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runImport: mockRunImport };
});
vi.mock("@/lib/duplicateRepair", () => ({
  previewRepair: mockPreviewRepair,
  runRepair: mockRunRepair,
  selectKeeper: () => ({ id: "keeper-1", created_date: "2026-01-01T00:00:00Z" }),
  artifactCanonicalIds: () => new Set(),
}));

// ---- Imports ----
import CanonicalImport from "@/pages/CanonicalImport";
import { COMPREHENSIVE_V1_FIXTURE } from "@/lib/canonicalImport";

const COMP_STR = COMPREHENSIVE_V1_FIXTURE;
const COMP = JSON.parse(COMPREHENSIVE_V1_FIXTURE);

// ---- Helpers ----
function makeReport(overrides = {}) {
  const base = {
    created: [], updated: [], unchanged: [], failed: [], unresolved: [],
    conflicts: [], warnings: [], ambiguous: [], relationships: [],
    capability_findings: [], dependencies_created: [], dependencies_updated: [],
    dependencies_deleted: [], blocked: false, blockedReasons: [], sync_state: "",
    partial: false,
  };
  const r = { ...base, ...overrides };
  r.counts = {
    created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length,
    failed: r.failed.length, unresolved: r.unresolved.length, conflicts: r.conflicts.length,
    warnings: r.warnings.length, ambiguous: r.ambiguous.length,
    relationships: r.relationships.length, capability_findings: r.capability_findings.length,
    dependencies_created: r.dependencies_created.length, dependencies_updated: r.dependencies_updated.length,
    dependencies_deleted: r.dependencies_deleted.length,
  };
  return r;
}

function makeRepairReport(overrides = {}) {
  return {
    blocked: false, blockedReason: "",
    partial: false, recoveryRequired: false,
    phase: "complete", groups: [], remaps: [],
    deleted: [], remapped: [],
    failedOperation: null,
    databaseStateUncertain: false,
    ...overrides,
  };
}

function renderPage() {
  return render(<CanonicalImport />);
}
function setTextarea(text) {
  fireEvent.change(screen.getByPlaceholderText(/Paste a canonical snapshot/), { target: { value: text } });
}
function clickRun() {
  fireEvent.click(screen.getByText(/Run import/i).closest("button"));
}
function clickExecuteRepair() {
  fireEvent.click(screen.getByText(/Execute repair/i).closest("button"));
}
function clickPreviewRepair() {
  fireEvent.click(screen.getByText(/Preview repair/i).closest("button"));
}
// Helper: set up the page with a parsed envelope so DuplicateRepair is visible
async function setupWithParsedEnv() {
  renderPage();
  setTextarea(COMP_STR);
  clickRun();
  // Wait for import to complete — this sets parsedEnv and releases the lock
  await waitFor(() => expect(screen.getByText("Import complete")).toBeInTheDocument());
}

beforeEach(() => {
  mockRunImport.mockReset();
  mockRunImport.mockResolvedValue(makeReport({ sync_state: "synchronized" }));
  mockRunRepair.mockReset();
  mockRunRepair.mockResolvedValue(makeRepairReport({ deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }] }));
  mockPreviewRepair.mockReset();
  mockPreviewRepair.mockReturnValue({
    groups: [{ canonical_id: "node:test", entity: "Node", memberCount: 2, eligible: true, keeper: { id: "keeper-1" }, deletions: [{ id: "dup-1" }] }],
    ready: [{ canonical_id: "node:test", entity: "Node", memberCount: 2, eligible: true, keeper: { id: "keeper-1" }, deletions: [{ id: "dup-1" }] }],
    blocked: [],
    remaps: [],
  });
  mockSyncList.mockReset();
  mockSyncList.mockResolvedValue([]);
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue(undefined);
  Object.assign(mockState, { data: {}, complete: true, errors: {}, incompleteEntities: [], loading: false });
});

// ---- C5: ONE SYNCHRONOUS MUTATION LOCK ----
describe("C5: One synchronous mutation lock for import and repair", () => {
  it("active repair prevents normal import (Run Import disabled)", async () => {
    // Make runRepair hang so the lock stays held
    let resolveRepair;
    mockRunRepair.mockReturnValue(new Promise((resolve) => { resolveRepair = resolve; }));

    await setupWithParsedEnv();
    clickPreviewRepair();
    clickExecuteRepair();

    // Wait for repair to start (lock acquired)
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).toBeDisabled();
    });

    // Run Import should also be disabled
    expect(screen.getByText(/Run import/i).closest("button")).toBeDisabled();

    // Resolve repair — lock released
    resolveRepair(makeRepairReport({ deleted: [] }));
    await waitFor(() => {
      expect(screen.getByText(/Run import/i).closest("button")).not.toBeDisabled();
    });
  });

  it("active repair prevents artifact replacement/editing (textarea disabled)", async () => {
    let resolveRepair;
    mockRunRepair.mockReturnValue(new Promise((resolve) => { resolveRepair = resolve; }));

    await setupWithParsedEnv();
    clickPreviewRepair();
    clickExecuteRepair();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Paste a canonical snapshot/)).toBeDisabled();
    });

    // Sample loaders should be disabled
    expect(screen.getByText(/Load sample/i).closest("button")).toBeDisabled();

    resolveRepair(makeRepairReport({ deleted: [] }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Paste a canonical snapshot/)).not.toBeDisabled();
    });
  });

  it("active normal import prevents repair (Execute Repair disabled)", async () => {
    // First set up with parsed env and preview repair so Execute Repair is enabled
    await setupWithParsedEnv();
    clickPreviewRepair();
    // Verify Execute Repair is enabled
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
    });

    // Now start an import — lock acquired
    let resolveImport;
    mockRunImport.mockReturnValue(new Promise((resolve) => { resolveImport = resolve; }));
    clickRun();

    // Execute Repair should be disabled while import is active
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).toBeDisabled();
    });

    // Resolve import — lock released
    resolveImport(makeReport({ sync_state: "synchronized" }));
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
    });
  });

  it("failure releases the guard and permits a safe retry", async () => {
    mockRunRepair.mockRejectedValueOnce(new Error("First repair fails"));

    await setupWithParsedEnv();
    clickPreviewRepair();
    clickExecuteRepair();

    // Wait for error
    await waitFor(() => {
      expect(screen.getByText(/Repair failed/i)).toBeInTheDocument();
    });

    // Lock released — controls re-enabled
    expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
    expect(screen.getByText(/Run import/i).closest("button")).not.toBeDisabled();

    // Retry succeeds
    mockRunRepair.mockResolvedValueOnce(makeRepairReport({ deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }] }));
    clickExecuteRepair();
    await waitFor(() => {
      expect(screen.getByText(/Repair complete/i)).toBeInTheDocument();
    });
  });

  it("rapid repair clicks still execute once", async () => {
    let resolveRepair;
    mockRunRepair.mockReturnValue(new Promise((resolve) => { resolveRepair = resolve; }));

    await setupWithParsedEnv();
    clickPreviewRepair();

    // Click Execute Repair multiple times rapidly
    clickExecuteRepair();
    clickExecuteRepair();
    clickExecuteRepair();

    // Only one runRepair call should have been made
    expect(mockRunRepair).toHaveBeenCalledTimes(1);

    resolveRepair(makeRepairReport({ deleted: [] }));
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
    });
  });
});