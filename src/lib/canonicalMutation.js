// Canonical identity-hardened upsert logic.
//
// Base44 storage capability investigation (2026-09-01):
//   - Backend/server functions: AVAILABLE (base44/functions/{name}/entry.ts)
//   - Atomic transactions: NOT AVAILABLE
//   - Unique field constraint / unique index: NOT AVAILABLE
//   - Conditional create / compare-and-set: NOT AVAILABLE
//   - Actual guarantees: NONE atomic. The strongest guarantee available is
//     fresh-read (filter by canonical_id) -> create/update -> immediate verify.
//
// A cross-session race (both sessions fresh-read 0, both create) cannot be
// PREVENTED atomically. It IS detected immediately after creation and surfaces
// as `canonical_identity_race_detected` / `recovery_required` — never as clean
// success. This is the honest guarantee level.
//
// This pure algorithm is shared by:
//   - createMemoryAdapter (in-process tests) — runs against the memory store.
//   - base44/functions/canonicalMutation/entry.ts (server-side boundary) —
//     replicates the same algorithm against the live Base44 DB via asServiceRole.
//
// The browser importer does NOT call entity.create directly for canonical
// entities. It routes through adapter.canonicalUpsert -> backend function.

// Execute a batch of canonical upsert operations against a store.
//
// store interface:
//   filterByCanonicalId(entity, canonical_id) -> Promise<records[]>
//   create(entity, payload) -> Promise<record>
//   update(entity, id, payload) -> Promise<record>
//
// Each operation: { entity, canonical_id, payload }
//
// Returns: { results, verification, race_detected, recovery_required }
//   results: per-operation { canonical_id, entity, status, id?, count? }
//     status: "created" | "updated" | "canonical_identity_race_detected" |
//             "ambiguous_existing_canonical_identity"
//   verification: per-involved-canonical-id { canonical_id, entity, count, unique }
//   race_detected: true if any post-create count != 1
//   recovery_required: true if race_detected or ambiguous
export async function canonicalUpsertBatch(operations, store) {
  const results = [];

  for (const op of operations) {
    if (!op.canonical_id || !op.entity) {
      results.push({ canonical_id: op.canonical_id || "", entity: op.entity || "", status: "invalid_operation", blocked: true });
      continue;
    }
    try {
      const existing = await store.filterByCanonicalId(op.entity, op.canonical_id);
      if (existing.length === 0) {
        const created = await store.create(op.entity, op.payload);
        const verify = await store.filterByCanonicalId(op.entity, op.canonical_id);
        if (verify.length !== 1) {
          results.push({ canonical_id: op.canonical_id, entity: op.entity, status: "canonical_identity_race_detected", recovery_required: true, id: created && created.id ? created.id : null, count: verify.length });
        } else {
          results.push({ canonical_id: op.canonical_id, entity: op.entity, status: "created", id: created.id });
        }
      } else if (existing.length === 1) {
        await store.update(op.entity, existing[0].id, op.payload);
        results.push({ canonical_id: op.canonical_id, entity: op.entity, status: "updated", id: existing[0].id });
      } else {
        results.push({ canonical_id: op.canonical_id, entity: op.entity, status: "ambiguous_existing_canonical_identity", blocked: true, count: existing.length });
      }
    } catch (e) {
      results.push({ canonical_id: op.canonical_id, entity: op.entity, status: "mutation_error", error: e.message });
    }
  }

  // Post-write uniqueness verification for all involved canonical IDs
  const verification = [];
  const seenCids = new Map(); // cid -> entity
  operations.forEach((op) => {
    if (op.canonical_id && op.entity) seenCids.set(op.canonical_id, op.entity);
  });
  for (const [cid, entity] of seenCids) {
    const recs = await store.filterByCanonicalId(entity, cid);
    verification.push({ canonical_id: cid, entity, count: recs.length, unique: recs.length === 1 });
  }

  const race_detected = results.some((r) => r.status === "canonical_identity_race_detected");
  const recovery_required = race_detected || results.some((r) => r.status === "ambiguous_existing_canonical_identity");

  return { results, verification, race_detected, recovery_required };
}

// Detect Atlas-local records whose display name collides with a canonical
// record's display name. Informational only — name equality is NOT identity
// equality. Does NOT block canonical synchronization.
//
// nameFields: entity -> display field name (e.g., { Node: "hostname", ... })
export const IDENTITY_NAME_FIELDS = {
  Node: "hostname",
  ExecutionEnvironment: "name",
  Workload: "name",
  Decision: "title",
  StorageDevice: "model",
  NetworkDevice: "name",
  StoragePool: "name",
  SwitchPort: "port_identifier",
};

export function detectLocalNameCollisions(data) {
  const collisions = [];
  for (const [entity, nameField] of Object.entries(IDENTITY_NAME_FIELDS)) {
    const recs = data[entity] || [];
    const canonical = recs.filter((r) => r.canonical_id && r.source_kind === "canonical");
    const local = recs.filter((r) => !r.canonical_id || r.source_kind !== "canonical");
    for (const l of local) {
      const lName = l[nameField];
      if (!lName) continue;
      for (const c of canonical) {
        if (c[nameField] === lName) {
          collisions.push({
            entity,
            localId: l.id,
            localName: lName,
            localSourceKind: l.source_kind || "local",
            canonicalId: c.id,
            canonicalCid: c.canonical_id,
          });
        }
      }
    }
  }
  return collisions;
}