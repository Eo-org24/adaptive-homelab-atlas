// Server-side canonical mutation boundary.
//
// This is the SINGLE shared server-side mutation boundary for canonical entity
// upserts. The browser importer does NOT call entity.create directly for
// canonical entities — it routes through this function via
// base44.functions.invoke('canonicalMutation', { operations }).
//
// Base44 does NOT expose atomic transactions, unique constraints, or conditional
// creates. The strongest guarantee available is:
//   fresh-read (filter by canonical_id) -> create/update -> immediate verify.
// A cross-session race is DETECTED immediately after creation and surfaces as
// `canonical_identity_race_detected` / `recovery_required` — never as clean
// success.
//
// Algorithm: identical to src/lib/canonicalMutation.js (canonicalUpsertBatch).
// The backend function cannot import Vite app code, so the algorithm is
// replicated here. Any change to the algorithm MUST be reflected in both files.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const operations = Array.isArray(body && body.operations) ? body.operations : null;
    if (!operations) return Response.json({ error: 'operations must be an array' }, { status: 400 });

    const svc = base44.asServiceRole.entities;
    const FILTER_LIMIT = 5000;

    const store = {
      async filterByCanonicalId(entity, cid) {
        return await svc[entity].filter({ canonical_id: cid }, '-created_date', FILTER_LIMIT, 0);
      },
      async create(entity, payload) {
        return await svc[entity].create(payload);
      },
      async update(entity, id, payload) {
        return await svc[entity].update(id, payload);
      },
    };

    const results = [];
    for (const op of operations) {
      if (!op || !op.canonical_id || !op.entity) {
        results.push({ canonical_id: op ? op.canonical_id : "", entity: op ? op.entity : "", status: "invalid_operation", blocked: true });
        continue;
      }
      try {
        var existing = await store.filterByCanonicalId(op.entity, op.canonical_id);
        if (existing.length === 0) {
          var created = await store.create(op.entity, op.payload);
          var verify = await store.filterByCanonicalId(op.entity, op.canonical_id);
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

    const verification = [];
    const seenCids = new Map();
    operations.forEach((op) => {
      if (op && op.canonical_id && op.entity) seenCids.set(op.canonical_id, op.entity);
    });
    for (const [cid, entity] of seenCids) {
      const recs = await store.filterByCanonicalId(entity, cid);
      verification.push({ canonical_id: cid, entity, count: recs.length, unique: recs.length === 1 });
    }

    const race_detected = results.some(function(r) { return r.status === "canonical_identity_race_detected"; });
    const recovery_required = race_detected || results.some(function(r) { return r.status === "ambiguous_existing_canonical_identity"; });

    return Response.json({ results, verification, race_detected, recovery_required });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}