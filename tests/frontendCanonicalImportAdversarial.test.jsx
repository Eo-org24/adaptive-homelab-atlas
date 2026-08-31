import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---- Mock setup (hoisted) ----
const mockState = vi.hoisted(() => ({
  data: {}, complete: true, errors: {}, incompleteEntities: [], loading: false,
}));
const mockSyncList = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockRunImport = vi.hoisted(() => vi.fn());

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
vi.mock("@/lib/canonicalImport", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runImport: mockRunImport };
});

// ---- Imports ----
import CanonicalImport from "@/pages/CanonicalImport";
import { COMPREHENSIVE_V1_FIXTURE, GOLDEN_CROSSOVER } from "@/lib/canonicalImport";

const COMP = JSON.parse(COMPREHENSIVE_V1_FIXTURE);
const GOLDEN = JSON.parse(GOLDEN_CROSSOVER);
const COMP_STR = COMPREHENSIVE_V1_FIXTURE;
const GOLDEN_STR = GOLDEN_CROSSOVER;

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

function renderPage() {
  return render(<CanonicalImport />);
}
function setTextarea(text) {
  fireEvent.change(screen.getByPlaceholderText(/Paste a canonical snapshot/), { target: { value: text } });
}
function clickPreview() {
  fireEvent.click(screen.getByText(/Preview \(dry-run\)/i).closest("button"));
}
function clickRun() {
  fireEvent.click(screen.getByText(/Run import/i).closest("button"));
}
function expectNoReport() {
  expect(screen.queryByText(/Import report/i)).not.toBeInTheDocument();
}
function expectNoSuccess() {
  expect(screen.queryByText("Import complete")).not.toBeInTheDocument();
}
function reportText() {
  const card = screen.queryByText(/Import report/i);
  return card ? (card.closest("div").textContent || "") : "";
}
function expectInReport(pattern) { expect(reportText()).toMatch(pattern); }
function expectNotInReport(pattern) { expect(reportText()).not.toMatch(pattern); }

beforeEach(() => {
  mockRunImport.mockReset();
  mockRunImport.mockResolvedValue(makeReport({ sync_state: "synchronized" }));
  mockSyncList.mockReset();
  mockSyncList.mockResolvedValue([]);
  Object.assign(mockState, { data: {}, complete: true, errors: {}, incompleteEntities: [], loading: false });
});

// ---- §1: MALFORMED INPUT ATTACKS ----
describe("§1: Malformed input attacks", () => {
  // Parse-level errors: parse() returns null → error shown, no report
  const parseErrorCases = [
    ["empty string", ""],
    ["whitespace", "   \n\t  "],
    ["malformed JSON", "{bad json"],
    ["JSON array", "[]"],
    ["null", "null"],
    ["wrong schema_version", JSON.stringify({ ...COMP, schema_version: "v2" })],
  ];
  // V1 validation errors: parse() passes → previewImport returns blocked report
  const v1ValidationErrorCases = [
    ["missing producer", JSON.stringify({ ...COMP, producer: undefined })],
    ["missing source", JSON.stringify({ ...COMP, source: undefined })],
    ["missing content_digest", JSON.stringify({ ...COMP, source: { ...COMP.source, content_digest: undefined } })],
    ["malformed digest", JSON.stringify({ ...COMP, source: { ...COMP.source, content_digest: "not-a-digest" } })],
    ["unknown top-level property", JSON.stringify({ ...COMP, evil: true })],
    ["unknown nested property", JSON.stringify({ ...COMP, entities: COMP.entities.map(e => e.kind === "node" ? { ...e, evil: true } : e) })],
    ["invalid entity kind", JSON.stringify({ ...COMP, entities: [{ ...COMP.entities[0], kind: "robot" }] })],
    ["schema/kind mismatch", JSON.stringify({ ...COMP, entities: COMP.entities.map(e => e.kind === "node" ? { ...e, schema: "homelab.workload/v1" } : e) })],
    ["wrong relationship endpoint kind", JSON.stringify({ ...COMP, relationships: [{ source: "node:comp-node-1", type: "hosted_on", target: "node:comp-node-1" }] })],
    ["duplicate canonical entity ID", JSON.stringify({ ...COMP, entities: [...COMP.entities, { ...COMP.entities[0] }] })],
    ["duplicate relationship tuple", JSON.stringify({ ...COMP, relationships: [...COMP.relationships, { ...COMP.relationships[0] }] })],
  ];

  parseErrorCases.forEach(([label, input]) => {
    it(`preview: ${label} — error shown, no report, no success`, () => {
      renderPage();
      setTextarea(input);
      try { clickPreview(); } catch (e) { /* should not throw */ }
      expectNoReport();
      expectNoSuccess();
    });
    it(`run: ${label} — no silent success, no write`, async () => {
      renderPage();
      setTextarea(input);
      try { clickRun(); } catch (e) { /* should not throw */ }
      await waitFor(() => expectNoSuccess());
      expect(mockRunImport).not.toHaveBeenCalled();
    });
  });

  v1ValidationErrorCases.forEach(([label, input]) => {
    it(`preview: ${label} — blocked report shown, no success`, () => {
      renderPage();
      setTextarea(input);
      try { clickPreview(); } catch (e) { /* should not throw */ }
      expect(screen.getByText(/Import report/i)).toBeInTheDocument();
      expect(screen.getAllByText(/Import blocked/i).length).toBeGreaterThan(0);
      expectNoSuccess();
    });
    it(`run: ${label} — no silent success`, async () => {
      mockRunImport.mockResolvedValue(makeReport({ sync_state: "import_blocked", blocked: true, blockedReasons: ["validation failed"] }));
      renderPage();
      setTextarea(input);
      try { clickRun(); } catch (e) { /* should not throw */ }
      await waitFor(() => expectNoSuccess());
    });
  });

  it("previous successful report is not misleadingly left visible after malformed input", async () => {
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => expect(screen.getByText("Import complete")).toBeInTheDocument());
    setTextarea("{bad");
    expect(screen.queryByText("Import complete")).not.toBeInTheDocument();
    expectNoReport();
  });
});

// ---- §2: DATASET INCOMPLETE FAIL CLOSED ----
describe("§2: Dataset incomplete must fail closed", () => {
  it("DATASET INCOMPLETE is visible when complete=false", () => {
    mockState.complete = false;
    mockState.loading = false;
    mockState.incompleteEntities = ["Node", "Workload"];
    renderPage();
    expect(screen.getByText("DATASET INCOMPLETE")).toBeInTheDocument();
    expect(screen.getByText(/Node, Workload/)).toBeInTheDocument();
  });

  it("Preview and Run are disabled when incomplete", () => {
    mockState.complete = false;
    mockState.loading = false;
    renderPage();
    expect(screen.getByText(/Preview \(dry-run\)/i).closest("button")).toBeDisabled();
    expect(screen.getByText(/Run import/i).closest("button")).toBeDisabled();
  });

  it("clicking Run via event dispatch does not trigger runImport when incomplete", () => {
    mockState.complete = false;
    mockState.loading = false;
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    expect(mockRunImport).not.toHaveBeenCalled();
  });

  it("empty record array with complete=false is not presented as safe zero-record dataset", () => {
    mockState.complete = false;
    mockState.loading = false;
    mockState.data = {};
    renderPage();
    expect(screen.getByText("DATASET INCOMPLETE")).toBeInTheDocument();
  });

  it("buttons become available only after complete state is rendered", () => {
    mockState.complete = false;
    mockState.loading = false;
    const { rerender } = renderPage();
    expect(screen.getByText(/Run import/i).closest("button")).toBeDisabled();
    // Transition to complete
    mockState.complete = true;
    rerender(<CanonicalImport />);
    expect(screen.getByText(/Run import/i).closest("button")).not.toBeDisabled();
    expect(screen.getByText(/Preview \(dry-run\)/i).closest("button")).not.toBeDisabled();
  });
});

// ---- §3: DOUBLE-SUBMIT / RAPID CLICK ----
describe("§3: Double-submit prevention", () => {
  it("rapidly clicking Run Import executes exactly once", async () => {
    let resolveImport;
    mockRunImport.mockReturnValue(new Promise(r => { resolveImport = r; }));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    clickRun();
    clickRun();
    expect(mockRunImport).toHaveBeenCalledTimes(1);
    // Button is disabled while busy
    expect(screen.getByText(/Run import/i).closest("button")).toBeDisabled();
    // Resolve
    resolveImport(makeReport({ sync_state: "synchronized" }));
    await waitFor(() => {
      expect(screen.getByText(/Run import/i).closest("button")).not.toBeDisabled();
    });
  });

  it("upload and sample-load are disabled during active import", async () => {
    let resolveImport;
    mockRunImport.mockReturnValue(new Promise(r => { resolveImport = r; }));
    const { container } = renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      expect(container.querySelector('input[type="file"]')).toBeDisabled();
    });
    expect(screen.getByText(/Load sample/i).closest("button")).toBeDisabled();
    expect(screen.getByText(/Load golden crossover/i).closest("button")).toBeDisabled();
    resolveImport(makeReport({ sync_state: "synchronized" }));
    await waitFor(() => {
      expect(container.querySelector('input[type="file"]')).not.toBeDisabled();
    });
  });
});

// ---- §4: PREVIEW IS NOT AUTHORIZATION ----
describe("§4: Preview is not authorization", () => {
  it("Run Import uses current textarea content, not previous preview", async () => {
    renderPage();
    // Preview artifact A (COMP)
    setTextarea(COMP_STR);
    clickPreview();
    expect(screen.getByText(/Import report/i)).toBeInTheDocument();
    // Change to artifact B (GOLDEN) — old report cleared
    setTextarea(GOLDEN_STR);
    expect(screen.queryByText(/Import report/i)).not.toBeInTheDocument();
    // Run — should use GOLDEN, not COMP
    clickRun();
    await waitFor(() => expect(mockRunImport).toHaveBeenCalled());
    const calledEnv = mockRunImport.mock.calls[0][0];
    expect(calledEnv.source.commit).toBe("unknown"); // GOLDEN has commit "unknown"
  });

  it("Run fails closed if dataset becomes incomplete after valid preview", () => {
    mockState.complete = true;
    const { rerender } = renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    expect(screen.getByText(/Import report/i)).toBeInTheDocument();
    // Dataset becomes incomplete
    mockState.complete = false;
    mockState.incompleteEntities = ["Node"];
    rerender(<CanonicalImport />);
    // Run is disabled
    expect(screen.getByText(/Run import/i).closest("button")).toBeDisabled();
    clickRun();
    expect(mockRunImport).not.toHaveBeenCalled();
  });
});

// ---- §5: BLOCKED IMPORT UI ----
describe("§5: Blocked import UI", () => {
  it("shows prominent Import blocked state with reasons, no success language", async () => {
    mockRunImport.mockResolvedValue(makeReport({
      sync_state: "import_blocked",
      blocked: true,
      blockedReasons: ["malformed records (strict V1 validation failed)", "duplicate canonical IDs"],
      failed: [{ entity: "Node", canonical_id: "node:bad", reason: "unknown kind" }],
    }));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      expect(screen.getAllByText(/Import blocked/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/malformed records/i)).toBeInTheDocument();
    expect(screen.getByText(/duplicate canonical IDs/i)).toBeInTheDocument();
    expectNoSuccess();
  });
});

// ---- §6: PARTIAL FAILURE UI ----
describe("§6: Partial failure UI", () => {
  it("shows partial failure status, recovery language, no success", async () => {
    mockRunImport.mockResolvedValue(makeReport({
      sync_state: "partial_failure",
      partial: true,
      created: [
        { entity: "Node", canonical_id: "node:n1" },
        { entity: "Node", canonical_id: "node:n2" },
      ],
      failed: [{ entity: "Workload", canonical_id: "workload:wl1", reason: "create failed" }],
      warnings: [{ entity: "Node", canonical_id: "node:n1", field: "ref", note: "unresolved" }],
      unresolved: [{ entity: "Workload", canonical_id: "workload:wl1", field: "current_environment", ref: "execution-provider:missing", target: "ExecutionEnvironment" }],
    }));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      expect(screen.getByText(/PARTIAL IMPORT FAILURE/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/recovery required/i)).toBeInTheDocument();
    // Failed section visible
    expect(screen.getByText(/Failed \(1\)/i)).toBeInTheDocument();
    // Warnings section visible
    expect(screen.getByText(/Warnings \(1\)/i)).toBeInTheDocument();
    // Unresolved section visible
    expect(screen.getByText(/Unresolved references \(1\)/i)).toBeInTheDocument();
    // No success language
    expectNoSuccess();
  });
});

// ---- §7: LOCAL OVERRIDE CONFLICT UI ----
describe("§7: Local override conflict UI", () => {
  it("CANONICAL_LOCAL_OVERRIDE_CONFLICT is visible with canonical vs local values", () => {
    mockState.data = {
      Node: [{
        id: "existing-1",
        hostname: "old-name",
        canonical_id: "node:comp-node-1",
        lifecycle_state: "maintenance",
        field_provenance: JSON.stringify({ lifecycle_state: { local: "maintenance" } }),
        source_kind: "canonical",
      }],
    };
    renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    expect(screen.getByText(/CANONICAL_LOCAL_OVERRIDE_CONFLICT/i)).toBeInTheDocument();
    expect(screen.getByText(/canonical=active/i)).toBeInTheDocument();
    expect(screen.getByText(/local override=maintenance/i)).toBeInTheDocument();
  });

  it("multiple simultaneous conflicts are all visible", () => {
    mockState.data = {
      Node: [{
        id: "existing-1",
        hostname: "old-name",
        canonical_id: "node:comp-node-1",
        lifecycle_state: "maintenance",
        availability_expectation: "best_effort",
        field_provenance: JSON.stringify({
          lifecycle_state: { local: "maintenance" },
          availability_expectation: { local: "best_effort" },
        }),
        source_kind: "canonical",
      }],
    };
    renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    expect(screen.getByText(/CANONICAL_LOCAL_OVERRIDE_CONFLICT \(2\)/i)).toBeInTheDocument();
  });

  it("long values do not break the page", () => {
    const longVal = "x".repeat(500);
    mockState.data = {
      Node: [{
        id: "existing-1",
        hostname: "old-name",
        canonical_id: "node:comp-node-1",
        lifecycle_state: longVal,
        field_provenance: JSON.stringify({ lifecycle_state: { local: longVal } }),
        source_kind: "canonical",
      }],
    };
    renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    expect(screen.getByText(/CANONICAL_LOCAL_OVERRIDE_CONFLICT/i)).toBeInTheDocument();
  });
});

// ---- §8: REALIZATION VS ELIGIBILITY ----
describe("§8: Current realization vs eligibility — visual semantic", () => {
  it("report uses relationship language, not realization language", () => {
    renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    // Should show relationship types in the report (not the textarea)
    expectInReport(/placement_allowed_on_provider/i);
    expectInReport(/placement_allowed_on_node/i);
    // Must NOT show realization language
    expectNotInReport(/Current environment/i);
    expectNotInReport(/Current node/i);
    expectNotInReport(/Runs on/i);
  });
});

// ---- §9: PLACEMENT ALLOWED IS NOT PREFERRED ----
describe("§9: Placement allowed on node is not preferred node", () => {
  it("report does not label nodes as Preferred, Current, Selected, or Primary", () => {
    renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    expect(screen.queryByText(/Preferred/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Selected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Primary/i)).not.toBeInTheDocument();
  });
});

// ---- §10: MULTI-TARGET DISPLAY ----
describe("§10: Multi-target display", () => {
  const MULTI = JSON.stringify({
    ...COMP,
    entities: [
      { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" } },
      { schema: "homelab.node/v1", kind: "node", id: "n2", provenance: { source_class: "canonical" } },
      { schema: "homelab.node/v1", kind: "node", id: "n3", provenance: { source_class: "canonical" } },
      { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" } },
      { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep2", provenance: { source_class: "canonical" } },
      { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep3", provenance: { source_class: "canonical" } },
      { schema: "homelab.workload/v1", kind: "workload", id: "wl1", provenance: { source_class: "canonical" } },
    ],
    relationships: [
      { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n1" },
      { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
      { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n3" },
      { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
      { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep2" },
      { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep3" },
    ],
  });
  const MULTI_REORDERED = JSON.stringify({
    ...JSON.parse(MULTI),
    relationships: [
      { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep3" },
      { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n3" },
      { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep1" },
      { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n1" },
      { source: "workload:wl1", type: "placement_allowed_on_provider", target: "execution-provider:ep2" },
      { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
    ],
  });

  it("all 6 relationships are visible in the report", () => {
    renderPage();
    setTextarea(MULTI);
    clickPreview();
    expect(screen.getByText(/Relationships resolved \(6\)/i)).toBeInTheDocument();
    expectInReport(/node:n1/i);
    expectInReport(/node:n2/i);
    expectInReport(/node:n3/i);
    expectInReport(/execution-provider:ep1/i);
    expectInReport(/execution-provider:ep2/i);
    expectInReport(/execution-provider:ep3/i);
  });

  it("reordering source tuples produces identical frontend semantics", () => {
    renderPage();
    setTextarea(MULTI);
    clickPreview();
    const firstCount = screen.getByText(/Relationships resolved \(6\)/i);
    expect(firstCount).toBeInTheDocument();
    // Clear and load reordered
    setTextarea(MULTI_REORDERED);
    clickPreview();
    expect(screen.getByText(/Relationships resolved \(6\)/i)).toBeInTheDocument();
    // All targets still present
    ["node:n1", "node:n2", "node:n3", "execution-provider:ep1", "execution-provider:ep2", "execution-provider:ep3"].forEach(id => {
      expectInReport(new RegExp(id));
    });
  });
});

// ---- §11: RELATIONSHIP REMOVAL VISUAL TEST ----
describe("§11: Relationship removal visual test", () => {
  const baseEntities = [
    { schema: "homelab.node/v1", kind: "node", id: "n1", provenance: { source_class: "canonical" } },
    { schema: "homelab.node/v1", kind: "node", id: "n2", provenance: { source_class: "canonical" } },
    { schema: "homelab.execution-provider/v1", kind: "execution-provider", id: "ep1", provenance: { source_class: "canonical" } },
    { schema: "homelab.workload/v1", kind: "workload", id: "wl1", provenance: { source_class: "canonical" } },
  ];
  const REL_A = JSON.stringify({ ...COMP, entities: baseEntities, relationships: [
    { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n1" },
    { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
  ]});
  const REL_B = JSON.stringify({ ...COMP, entities: baseEntities, relationships: [
    { source: "workload:wl1", type: "placement_allowed_on_node", target: "node:n2" },
  ]});
  const REL_C = JSON.stringify({ ...COMP, entities: baseEntities, relationships: [] });

  it("N1 disappears when removed from snapshot", () => {
    renderPage();
    setTextarea(REL_A);
    clickPreview();
    expect(screen.getByText(/Relationships resolved \(2\)/i)).toBeInTheDocument();
    setTextarea(REL_B);
    clickPreview();
    expect(screen.getByText(/Relationships resolved \(1\)/i)).toBeInTheDocument();
    // N1 should not appear in the report
    const reportSection = screen.getByText(/Relationships resolved/i).closest("div").parentElement;
    expect(reportSection.textContent).not.toMatch(/node:n1/i);
  });

  it("all allowed nodes disappear when snapshot has none", () => {
    renderPage();
    setTextarea(REL_B);
    clickPreview();
    expect(screen.getByText(/Relationships resolved \(1\)/i)).toBeInTheDocument();
    setTextarea(REL_C);
    clickPreview();
    // No relationships resolved section (0 relationships)
    expect(screen.queryByText(/Relationships resolved/i)).not.toBeInTheDocument();
  });

  it("hosted_on removal: host disappears when removed from snapshot", () => {
    const HOST_A = JSON.stringify({ ...COMP, entities: baseEntities, relationships: [
      { source: "execution-provider:ep1", type: "hosted_on", target: "node:n1" },
    ]});
    const HOST_B = JSON.stringify({ ...COMP, entities: baseEntities, relationships: [] });
    renderPage();
    setTextarea(HOST_A);
    clickPreview();
    expectInReport(/hosted_on/i);
    setTextarea(HOST_B);
    clickPreview();
    expectNotInReport(/hosted_on/i);
  });
});

// ---- §12: CAPABILITY AMBIGUITY UI ----
describe("§12: Capability ambiguity UI", () => {
  it("type-only requirement does NOT produce ambiguity finding", () => {
    const typeOnly = JSON.stringify({
      ...COMP,
      entities: COMP.entities.map(e =>
        e.kind === "workload" && e.requirements
          ? { ...e, requirements: { capabilities: [{ type: "hw-accel" }] } }
          : e
      ),
    });
    renderPage();
    setTextarea(typeOnly);
    clickPreview();
    expect(screen.queryByText(/Capability resolution/i)).not.toBeInTheDocument();
  });

  it("named instance requirement produces UNRESOLVED ambiguity finding", () => {
    const namedInstance = JSON.stringify({
      ...COMP,
      entities: COMP.entities.map(e =>
        e.kind === "workload" && e.requirements
          ? { ...e, requirements: { capabilities: [{ type: "hw-accel", instance: "accel0" }] } }
          : e
      ),
    });
    renderPage();
    setTextarea(namedInstance);
    clickPreview();
    expect(screen.getByText(/Capability resolution/i)).toBeInTheDocument();
    expectInReport(/unresolved/i);
    expectInReport(/accel0/i);
  });
});

// ---- §15: HOSTILE STRINGS / XSS ----
describe("§15: Hostile strings / XSS safety", () => {
  it("script tags render as text, not as HTML", () => {
    const xssFixture = JSON.stringify({
      ...COMP,
      entities: COMP.entities.map(e =>
        e.kind === "workload"
          ? { ...e, display_name: '<script>alert(1)</script><img src=x onerror=alert(1)>' }
          : e
      ),
    });
    const { container } = renderPage();
    setTextarea(xssFixture);
    clickPreview();
    // The hostile string should appear as text
    expect(screen.getByText(/alert\(1\)/i)).toBeInTheDocument();
    // No script element should be injected into the component DOM
    expect(container.querySelector("script")).not.toBeInTheDocument();
  });

  it("event handler attributes do not execute", () => {
    const xssFixture = JSON.stringify({
      ...COMP,
      entities: COMP.entities.map(e =>
        e.kind === "workload"
          ? { ...e, display_name: '"><svg/onload=alert(1)>' }
          : e
      ),
    });
    const { container } = renderPage();
    setTextarea(xssFixture);
    clickPreview();
    expect(container.querySelector("svg[onload]")).not.toBeInTheDocument();
  });

  it("unicode bidi characters and emoji render without breaking layout", () => {
    const unicodeFixture = JSON.stringify({
      ...COMP,
      entities: COMP.entities.map(e =>
        e.kind === "workload"
          ? { ...e, display_name: '\u202E\u200Btest \u200F \uD83D\uDE00' }
          : e
      ),
    });
    renderPage();
    setTextarea(unicodeFixture);
    clickPreview();
    // Page didn't crash
    expect(screen.getByText(/Import report/i)).toBeInTheDocument();
  });
});

// ---- §16: IDENTITY SPOOFING ----
describe("§16: Canonical ID vs display name spoofing", () => {
  it("report uses canonical identity, not display name, for relationship resolution", () => {
    const spoof = JSON.stringify({
      ...COMP,
      entities: [
        { schema: "homelab.node/v1", kind: "node", id: "real-a", provenance: { source_class: "canonical" }, identity: { physical_name: "node:real-b" } },
        { schema: "homelab.node/v1", kind: "node", id: "real-b", provenance: { source_class: "canonical" }, identity: { physical_name: "node:real-a" } },
      ],
      relationships: [],
    });
    renderPage();
    setTextarea(spoof);
    clickPreview();
    // Both canonical IDs should be visible in the Created section (report, not textarea)
    expectInReport(/node:real-a/i);
    expectInReport(/node:real-b/i);
  });
});

// ---- §17: LARGE REPORT ----
describe("§17: Extreme length / large report", () => {
  it("hundreds of entries render without crashing or duplicate keys", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRunImport.mockResolvedValue(makeReport({
      sync_state: "import_warnings",
      created: Array.from({ length: 200 }, (_, i) => ({ entity: "Node", canonical_id: `node:n${i}` })),
      failed: Array.from({ length: 100 }, (_, i) => ({ entity: "Node", canonical_id: `node:bad${i}`, reason: `error ${i}` })),
      unresolved: Array.from({ length: 100 }, (_, i) => ({ entity: "Node", canonical_id: `node:unres${i}`, field: "ref", ref: `node:missing${i}`, target: "Node" })),
    }));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      expect(screen.getByText(/Created \(200\)/i)).toBeInTheDocument();
    });
    // No duplicate key warnings
    expect(consoleSpy.mock.calls.some(c => /unique.*key/i.test(String(c[0])))).toBe(false);
    consoleSpy.mockRestore();
  });
});

// ---- §18: RAPID ARTIFACT REPLACEMENT ----
describe("§18: Rapid artifact replacement", () => {
  it("state corresponds only to current textarea contents", async () => {
    renderPage();
    // Load golden
    setTextarea(GOLDEN_STR);
    // Immediately load comprehensive
    setTextarea(COMP_STR);
    // Immediately paste malformed JSON
    setTextarea("{bad");
    // No report should be visible (cleared by textarea change)
    expectNoReport();
    // Restore valid JSON
    setTextarea(COMP_STR);
    // Preview
    clickPreview();
    expect(screen.getByText(/Import report/i)).toBeInTheDocument();
    // Run
    clickRun();
    await waitFor(() => expect(mockRunImport).toHaveBeenCalled());
    const calledEnv = mockRunImport.mock.calls[0][0];
    expect(calledEnv.source.commit).toBe("comp1234"); // COMP, not GOLDEN
  });
});

// ---- §20: DELETE / ABSENCE SEMANTICS ----
describe("§20: Delete/absence semantics", () => {
  it("absent entity is not claimed as deleted from canon", () => {
    mockState.data = {
      Node: [{ id: "old-1", hostname: "old-node", canonical_id: "node:old", source_kind: "canonical" }],
    };
    renderPage();
    setTextarea(COMP_STR);
    clickPreview();
    // Report should not contain "deleted" for entities
    expect(screen.queryByText(/deleted from canon/i)).not.toBeInTheDocument();
    // The old record should not appear in the report at all
    const reportCard = screen.getByText(/Import report/i).closest("div");
    expect(reportCard.textContent).not.toMatch(/node:old/i);
  });
});

// ---- §21: ERROR-BOUNDARY BEHAVIOR ----
describe("§21: Error-boundary style behavior", () => {
  it("runImport throwing shows visible error, not blank page or spinner", async () => {
    mockRunImport.mockRejectedValue(new Error("Network failure"));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      expect(screen.getByText(/Import failed/i)).toBeInTheDocument();
    });
    // Button re-enables
    expect(screen.getByText(/Run import/i).closest("button")).not.toBeDisabled();
  });
});

// ---- §22: ACCESSIBILITY / OPERATOR SAFETY ----
describe("§22: Accessibility / operator safety basics", () => {
  it("disabled buttons are actually disabled when incomplete", () => {
    mockState.complete = false;
    renderPage();
    expect(screen.getByText(/Preview \(dry-run\)/i).closest("button")).toBeDisabled();
    expect(screen.getByText(/Run import/i).closest("button")).toBeDisabled();
  });

  it("status messages are readable in DOM text", async () => {
    mockRunImport.mockResolvedValue(makeReport({ sync_state: "synchronized" }));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      expect(screen.getByText("Import complete")).toBeInTheDocument();
    });
  });

  it("file input remains reachable", () => {
    const { container } = renderPage();
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).not.toBeDisabled();
  });

  it("import result is not communicated solely by color", async () => {
    mockRunImport.mockResolvedValue(makeReport({ sync_state: "partial_failure", partial: true }));
    renderPage();
    setTextarea(COMP_STR);
    clickRun();
    await waitFor(() => {
      // Text content communicates the state, not just CSS color
      expect(screen.getByText(/PARTIAL IMPORT FAILURE/i)).toBeInTheDocument();
      expect(screen.getByText(/recovery required/i)).toBeInTheDocument();
    });
  });
});