import { describe, it, expect } from "vitest";
import { previewImport, validateEnvelope, SAMPLE_ENVELOPE } from "@/lib/canonicalImport";
import { overrideConflicts } from "@/lib/provenance";

const V = "adaptive-homelab-atlas/v1";
const env = (sections, extra = {}) => ({ schema_version: V, source: { repository: "homelab-foundation", commit: "c1" }, ...sections, ...extra });

describe("canonical import: validation", () => {
  it("rejects unsupported schema major version", () => {
    const r = validateEnvelope({ schema_version: "adaptive-homelab-atlas/v2" });
    expect(r.valid).toBe(false);
    const r2 = validateEnvelope({ schema_version: "other/v1" });
    expect(r2.valid).toBe(false);
  });
  it("rejects non-object envelope", () => {
    expect(validateEnvelope(null).valid).toBe(false);
    expect(validateEnvelope([]).valid).toBe(false);
    expect(validateEnvelope("x").valid).toBe(false);
  });
  it("accepts a valid envelope", () => {
    expect(validateEnvelope({ schema_version: V }).valid).toBe(true);
  });
});

describe("canonical import: idempotency & upsert", () => {
  it("same snapshot imported twice is idempotent (second run all unchanged)", () => {
    const data = { Node: [{ id: "n1", canonical_id: "node:rig9", hostname: "rig9" }] };
    const e = env({ nodes: [{ canonical_id: "node:rig9", hostname: "rig9" }] });
    const r1 = previewImport(e, data);
    expect(r1.counts.unchanged).toBe(1);
    expect(r1.counts.created).toBe(0);
    const r2 = previewImport(e, data);
    expect(r2.counts.unchanged).toBe(1);
    expect(r2.counts.created).toBe(0);
    expect(r2.counts.updated).toBe(0);
  });

  it("existing canonical record with changed values is updated, not duplicated", () => {
    const data = { Node: [{ id: "n1", canonical_id: "node:rig9", hostname: "rig9", lifecycle_state: "active" }] };
    const e = env({ nodes: [{ canonical_id: "node:rig9", hostname: "rig9", lifecycle_state: "degraded" }] });
    const r = previewImport(e, data);
    expect(r.counts.updated).toBe(1);
    expect(r.counts.created).toBe(0);
    expect(r.updated[0].canonical_id).toBe("node:rig9");
  });

  it("duplicate canonical_id within input is reported as a conflict", () => {
    const e = env({ nodes: [
      { canonical_id: "node:x", hostname: "a" },
      { canonical_id: "node:x", hostname: "b" },
    ] });
    const r = previewImport(e, {});
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0].canonical_id).toBe("node:x");
  });
});

describe("canonical import: relationships", () => {
  it("unresolved relationship is reported, no fabricated record", () => {
    const e = env({ workloads: [{ canonical_id: "workload:w1", name: "w1", category: "storage", current_environment: "execution-provider:ghost" }] });
    const r = previewImport(e, {});
    expect(r.unresolved.length).toBe(1);
    expect(r.unresolved[0].ref).toBe("execution-provider:ghost");
    expect(r.counts.created).toBe(1); // the workload itself is still created
  });

  it("references arriving before referenced object resolve on a phased run", () => {
    const e = env({
      nodes: [{ canonical_id: "node:n1", hostname: "n1" }],
      execution_environments: [{ canonical_id: "execution-provider:e1", name: "e1", type: "lxc", current_host: "node:n1" }],
    });
    const r = previewImport(e, {});
    // env references node:n1 which is being created in the same import -> warning, not unresolved
    expect(r.unresolved.length).toBe(0);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0].note).toMatch(/will resolve on run/);
  });

  it("malformed relationship fails safely (no throw, reported unresolved)", () => {
    const e = env({ dependencies: [{ canonical_id: "dep:d1", source_type: "workload", source_id: "workload:ghost", target_type: "workload", target_id: "workload:ghost2" }] });
    expect(() => previewImport(e, {})).not.toThrow();
    const r = previewImport(e, {});
    expect(r.unresolved.length).toBeGreaterThanOrEqual(1);
  });
});

describe("canonical import: preservation", () => {
  it("Atlas-local record absent from canonical import is not deleted", () => {
    const data = { Node: [{ id: "local1", hostname: "my-local-node" }] }; // no canonical_id
    const e = env({ nodes: [{ canonical_id: "node:rig9", hostname: "rig9" }] });
    const r = previewImport(e, data);
    expect(r.counts.created).toBe(1);
    // preview is non-destructive; local record remains in data
    expect(data.Node.find((n) => n.id === "local1")).toBeTruthy();
  });

  it("canonical object absent from a newer import is not silently deleted", () => {
    const data = { Node: [{ id: "n1", canonical_id: "node:old", hostname: "old" }] };
    const e = env({ nodes: [{ canonical_id: "node:new", hostname: "new" }] });
    const r = previewImport(e, data);
    expect(r.counts.created).toBe(1);
    expect(data.Node.find((n) => n.canonical_id === "node:old")).toBeTruthy();
  });

  it("partially invalid import produces a clear report, not silent half-corruption", () => {
    const e = env({ nodes: [
      { canonical_id: "node:good", hostname: "good" },
      { hostname: "no-cid" }, // missing canonical_id -> failed
    ] });
    const r = previewImport(e, {});
    expect(r.failed.length).toBe(1);
    expect(r.counts.created).toBe(1);
  });
});

describe("canonical import: local override conflict", () => {
  it("local override + canonical update surfaces an explicit conflict", () => {
    const existing = { id: "n1", canonical_id: "node:x", ram_capacity_gb: 96, source_kind: "canonical",
      field_provenance: JSON.stringify({ ram_capacity_gb: { local: 96 } }) };
    const envelope = env({ nodes: [{ canonical_id: "node:x", ram_capacity_gb: 128 }] });
    const conflicts = overrideConflicts(envelope, { Node: [existing] });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].field).toBe("ram_capacity_gb");
    expect(conflicts[0].localValue).toBe(96);
    expect(conflicts[0].canonicalValue).toBe(128);
  });
  it("no conflict when canonical value matches existing (no local override)", () => {
    const existing = { id: "n1", canonical_id: "node:x", ram_capacity_gb: 64, source_kind: "canonical" };
    const envelope = env({ nodes: [{ canonical_id: "node:x", ram_capacity_gb: 64 }] });
    expect(overrideConflicts(envelope, { Node: [existing] })).toHaveLength(0);
  });
});

describe("canonical import: sample envelope parses", () => {
  it("SAMPLE_ENVELOPE is valid JSON with the supported schema prefix", () => {
    const parsed = JSON.parse(SAMPLE_ENVELOPE);
    expect(validateEnvelope(parsed).valid).toBe(true);
  });
});