// R5, F6, R7/F8: Frontend regression tests for the final defect-correction pass.
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
const mockArtifactPreviewKey = vi.hoisted(() => vi.fn((env) => env?.source?.content_digest || ""));

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
  artifactPreviewKey: mockArtifactPreviewKey,
}));

// ---- Imports ----
import CanonicalImport from "@/pages/CanonicalImport";
import { REAL_CROSSOVER_ARTIFACT, COMPREHENSIVE_V1_FIXTURE } from "@/lib/canonicalImport";

const REAL_STR = REAL_CROSSOVER_ARTIFACT;
const COMP_STR = COMPREHENSIVE_V1_FIXTURE;
const REAL = JSON.parse(REAL_CROSSOVER_ARTIFACT);
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
    writesOccurred: false,
    ...overrides,
  };
}

function renderPage() { return render(<CanonicalImport />); }
function setTextarea(text) {
  fireEvent.change(screen.getByPlaceholderText(/Paste a canonical snapshot/), { target: { value: text } });
}
function clickRun() { fireEvent.click(screen.getByText(/Run import/i).closest("button")); }
function clickExecuteRepair() { fireEvent.click(screen.getByText(/Execute repair/i).closest("button")); }
function clickPreviewRepair() { fireEvent.click(screen.getByText(/Preview repair/i).closest("button")); }

async function setupWithParsedEnv(text = COMP_STR) {
  renderPage();
  setTextarea(text);
  clickRun();
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

// =========================================================================
// F5: PREVIEW ARTIFACT BINDING
// =========================================================================
describe("F5: preview Artifact A, replace with B, Execute disabled, preview B, Execute enabled", () => {
  it("Execute is disabled after artifact change until a new preview is run", async () => {
    // mockArtifactPreviewKey returns content_digest, so different artifacts have different keys
    await setupWithParsedEnv(REAL_STR);

    // Preview repair for Artifact A
    clickPreviewRepair();
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
    });

    // Replace with Artifact B (different content_digest → different previewKey)
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => expect(screen.getByText("Import complete")).toBeInTheDocument());

    // F5: Execute repair should be disabled — preview is bound to Artifact A, current is B
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).toBeDisabled();
    });

    // Preview repair for Artifact B
    clickPreviewRepair();
    await waitFor(() => {
      expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
    });
  });
});

// =========================================================================
// F6: POST-REPAIR RENDERING READS counts.ambiguous
// =========================================================================
describe("F6: post-repair rendering reads counts.ambiguous", () => {
  it("a nonzero ambiguous count is rendered accurately", async () => {
    await setupWithParsedEnv();
    clickPreviewRepair();

    // Mock runRepair to return a successful repair (deleted > 0)
    mockRunRepair.mockResolvedValueOnce(makeRepairReport({
      deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }],
      writesOccurred: true,
    }));

    // Mock runImport (re-import) to return a report with counts.ambiguous = 3
    mockRunImport.mockResolvedValueOnce(makeReport({
      sync_state: "synchronized",
      ambiguous: [{}, {}, {}],
    }));

    clickExecuteRepair();

    // Wait for the post-repair import result to show ambiguous identities = 3
    await waitFor(() => {
      expect(screen.getByText(/ambiguous identities.*3/)).toBeInTheDocument();
    });
  });

  it("zero ambiguous count renders as 0", async () => {
    await setupWithParsedEnv();
    clickPreviewRepair();

    mockRunRepair.mockResolvedValueOnce(makeRepairReport({
      deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }],
      writesOccurred: true,
    }));
    mockRunImport.mockResolvedValueOnce(makeReport({ sync_state: "synchronized" }));

    clickExecuteRepair();

    await waitFor(() => {
      expect(screen.getByText(/ambiguous identities.*0/)).toBeInTheDocument();
    });
  });
});

// =========================================================================
// R7/F8: REFRESH FAILURE WORDING — HONEST FOR PARTIAL MUTATIONS
// =========================================================================
describe("R7/F8: successful import + refresh rejection", () => {
  it("wording says the import itself succeeded", async () => {
    mockRunImport.mockResolvedValueOnce(makeReport({ sync_state: "synchronized" }));
    mockRefresh.mockRejectedValueOnce(new Error("network timeout"));

    renderPage();
    setTextarea(COMP_STR);
    clickRun();

    await waitFor(() => {
      expect(screen.getByText(/import itself succeeded/i)).toBeInTheDocument();
    });
    // Must NOT say authoritative/partial
    expect(screen.queryByText(/authoritative/i)).not.toBeInTheDocument();
  });
});

describe("R7/F8: partial import + refresh rejection", () => {
  it("wording says authoritative/partial, NOT 'import itself succeeded'", async () => {
    mockRunImport.mockResolvedValueOnce(makeReport({ sync_state: "partial_failure", partial: true }));
    mockRefresh.mockRejectedValueOnce(new Error("network timeout"));

    renderPage();
    setTextarea(COMP_STR);
    clickRun();

    // Wait for the partial failure status
    await waitFor(() => {
      expect(screen.getByText(/PARTIAL IMPORT FAILURE/i)).toBeInTheDocument();
    });

    // Wait for the refresh error with honest wording
    await waitFor(() => {
      expect(screen.getByText(/authoritative.*partial\/recovery-required/i)).toBeInTheDocument();
    });
    // Must NOT say "import itself succeeded"
    expect(screen.queryByText(/import itself succeeded/i)).not.toBeInTheDocument();
  });
});

describe("R7/F8: successful repair + refresh rejection", () => {
  it("wording says the repair itself succeeded", async () => {
    await setupWithParsedEnv();
    clickPreviewRepair();

    mockRunRepair.mockResolvedValueOnce(makeRepairReport({
      deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }],
      writesOccurred: true,
    }));
    mockRunImport.mockResolvedValueOnce(makeReport({ sync_state: "synchronized" }));
    mockRefresh.mockRejectedValueOnce(new Error("network timeout"));

    clickExecuteRepair();

    await waitFor(() => {
      expect(screen.getByText(/repair itself succeeded/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/authoritative/i)).not.toBeInTheDocument();
  });
});

describe("R7/F8: partial/recovery repair + refresh rejection", () => {
  it("wording says authoritative/partial, NOT 'repair itself succeeded'", async () => {
    await setupWithParsedEnv();
    clickPreviewRepair();

    mockRunRepair.mockResolvedValueOnce(makeRepairReport({
      partial: true,
      recoveryRequired: true,
      deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }],
      writesOccurred: true,
      failedOperation: { phase: "delete", operation: "delete node:test dup-2", reason: "timeout" },
    }));
    mockRefresh.mockRejectedValueOnce(new Error("network timeout"));

    clickExecuteRepair();

    // Wait for recovery-required status
    await waitFor(() => {
      expect(screen.getByText(/Recovery required/i)).toBeInTheDocument();
    });

    // Wait for the refresh error with honest wording
    await waitFor(() => {
      expect(screen.getByText(/authoritative.*partial\/recovery-required/i)).toBeInTheDocument();
    });
    // Must NOT say "repair itself succeeded"
    expect(screen.queryByText(/repair itself succeeded/i)).not.toBeInTheDocument();
  });

  it("mutation result remains visible after refresh failure", async () => {
    await setupWithParsedEnv();
    clickPreviewRepair();

    mockRunRepair.mockResolvedValueOnce(makeRepairReport({
      partial: true,
      recoveryRequired: true,
      deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }],
      writesOccurred: true,
      failedOperation: { phase: "delete", operation: "delete node:test dup-2", reason: "timeout" },
    }));
    mockRefresh.mockRejectedValueOnce(new Error("network timeout"));

    clickExecuteRepair();

    // The repair result (deleted records) remains visible
    await waitFor(() => {
      expect(screen.getByText(/Deleted duplicate IDs/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/dup-1/).length).toBeGreaterThan(0);
  });

  it("controls unlock safely after repair + refresh failure", async () => {
    await setupWithParsedEnv();
    clickPreviewRepair();

    mockRunRepair.mockResolvedValueOnce(makeRepairReport({
      deleted: [{ canonical_id: "node:test", entity: "Node", id: "dup-1" }],
      writesOccurred: true,
    }));
    mockRunImport.mockResolvedValueOnce(makeReport({ sync_state: "synchronized" }));
    mockRefresh.mockRejectedValueOnce(new Error("network timeout"));

    clickExecuteRepair();

    // Wait for repair complete and refresh error
    await waitFor(() => {
      expect(screen.getByText(/Repair complete/i)).toBeInTheDocument();
    });

    // Controls should be re-enabled (lock released)
    await waitFor(() => {
      expect(screen.getByText(/Run import/i).closest("button")).not.toBeDisabled();
    });
    expect(screen.getByText(/Execute repair/i).closest("button")).not.toBeDisabled();
  });
});