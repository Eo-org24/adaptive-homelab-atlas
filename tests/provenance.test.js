import { describe, it, expect } from "vitest";
import { normalizeSourceKind, staleStatus, readFieldProvenance, hasLocalOverride, truthLayers, overrideConflicts, STALE_CONFIG } from "@/lib/provenance";

const fp = (o) => JSON.stringify(o);

describe("normalizeSourceKind", () => {
  it("maps legacy kinds to the canonical vocabulary", () => {
    expect(normalizeSourceKind("manual")).toBe("local");
    expect(normalizeSourceKind("imported")).toBe("canonical");
    expect(normalizeSourceKind("documented")).toBe("canonical");
    expect(normalizeSourceKind("canonical")).toBe("canonical");
    expect(normalizeSourceKind("observed")).toBe("observed");
    expect(normalizeSourceKind("planned")).toBe("planned");
    expect(normalizeSourceKind("inferred")).toBe("inferred");
    expect(normalizeSourceKind("sample")).toBe("sample");
  });
  it("returns unknown for empty/unrecognized", () => {
    expect(normalizeSourceKind("")).toBe("unknown");
    expect(normalizeSourceKind(null)).toBe("unknown");
    expect(normalizeSourceKind("garbage")).toBe("unknown");
  });
});

describe("staleStatus", () => {
  it("returns NO_OBSERVATION for empty and UNKNOWN for bad dates", () => {
    expect(staleStatus(null)).toBe("NO_OBSERVATION");
    expect(staleStatus("")).toBe("NO_OBSERVATION");
    expect(staleStatus("not-a-date")).toBe("UNKNOWN");
  });
  it("classifies freshness by category thresholds", () => {
    const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
    expect(staleStatus(days(10), "hardware")).toBe("FRESH");
    expect(staleStatus(days(200), "hardware")).toBe("AGING");
    expect(staleStatus(days(400), "hardware")).toBe("STALE");
    // service has tighter thresholds
    expect(staleStatus(days(20), "service")).toBe("AGING");
    expect(staleStatus(days(40), "service")).toBe("STALE");
  });
});

describe("truthLayers", () => {
  it("canonical + observed agree -> both layers present, canonical not overwritten", () => {
    const rec = { source_kind: "canonical", ram_capacity_gb: 64, field_provenance: fp({ ram_capacity_gb: { observed: 64, observed_at: "2026-08-01" } }) };
    const L = truthLayers(rec, "ram_capacity_gb", 64);
    expect(L).toHaveLength(2);
    expect(L[0]).toMatchObject({ kind: "canonical", value: 64 });
    expect(L[1]).toMatchObject({ kind: "observed", value: 64 });
  });
  it("canonical + observed disagree -> both coexist, neither overwrites the other", () => {
    const rec = { source_kind: "canonical", ram_capacity_gb: 64, field_provenance: fp({ ram_capacity_gb: { observed: 32 } }) };
    const L = truthLayers(rec, "ram_capacity_gb", 64);
    expect(L[0].value).toBe(64);
    expect(L[1].value).toBe(32);
  });
  it("canonical + planned coexist", () => {
    const rec = { source_kind: "canonical", cpu_model: "A", field_provenance: fp({ cpu_model: { planned: "B" } }) };
    const L = truthLayers(rec, "cpu_model", "A");
    expect(L.find((l) => l.kind === "canonical").value).toBe("A");
    expect(L.find((l) => l.kind === "planned").value).toBe("B");
  });
  it("canonical + inferred coexist", () => {
    const rec = { source_kind: "canonical", x: 1, field_provenance: fp({ x: { inferred: 2, confidence: 0.6 } }) };
    const L = truthLayers(rec, "x", 1);
    expect(L.find((l) => l.kind === "inferred").value).toBe(2);
  });
  it("local override is a separate layer", () => {
    const rec = { source_kind: "canonical", ram_capacity_gb: 64, field_provenance: fp({ ram_capacity_gb: { local: 96 } }) };
    expect(hasLocalOverride(rec, "ram_capacity_gb")).toBe(true);
    const L = truthLayers(rec, "ram_capacity_gb", 64);
    expect(L.find((l) => l.kind === "local").value).toBe(96);
    expect(L[0].value).toBe(64); // canonical flat value unchanged
  });
  it("no overlay -> single canonical layer", () => {
    const rec = { source_kind: "canonical", ram_capacity_gb: 64 };
    expect(truthLayers(rec, "ram_capacity_gb", 64)).toHaveLength(1);
  });
  it("malformed field_provenance is handled safely", () => {
    expect(readFieldProvenance({ field_provenance: "not-json" })).toEqual({});
    expect(readFieldProvenance({ field_provenance: null })).toEqual({});
    expect(hasLocalOverride({ field_provenance: "bad" }, "x")).toBe(false);
  });
});

describe("overrideConflicts", () => {
  it("flags canonical update against an existing local override", () => {
    const existing = { id: "n1", canonical_id: "node:x", ram_capacity_gb: 96, source_kind: "canonical", field_provenance: fp({ ram_capacity_gb: { local: 96 } }) };
    const envelope = { nodes: [{ canonical_id: "node:x", ram_capacity_gb: 128 }] };
    const c = overrideConflicts(envelope, { Node: [existing] });
    expect(c).toHaveLength(1);
    expect(c[0].localValue).toBe(96);
  });
  it("does not flag when there is no local override", () => {
    const existing = { id: "n1", canonical_id: "node:x", ram_capacity_gb: 64, source_kind: "canonical" };
    const envelope = { nodes: [{ canonical_id: "node:x", ram_capacity_gb: 128 }] };
    expect(overrideConflicts(envelope, { Node: [existing] })).toHaveLength(0);
  });
  it("handles null envelope safely", () => {
    expect(overrideConflicts(null, {})).toEqual([]);
  });
});

describe("STALE_CONFIG covers all categories", () => {
  it("has hardware/network/service/storage/default", () => {
    ["hardware", "network", "service", "storage", "default"].forEach((k) => {
      expect(STALE_CONFIG[k].freshDays).toBeGreaterThan(0);
      expect(STALE_CONFIG[k].agingDays).toBeGreaterThan(STALE_CONFIG[k].freshDays);
    });
  });
});