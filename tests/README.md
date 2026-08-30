# Adaptive Homelab Atlas — Test Suite

## Run

```bash
npm test          # one-shot run (vitest run)
npm run test:watch # watch mode
```

Tests run on **Vitest** with a jsdom environment. The live Base44 SDK client is
stubbed globally in `tests/setup.js`, so domain-logic tests never touch the
network or the database.

## Layout

```
tests/
  setup.js                 # global SDK stub
  canonicalImport.test.js  # import matrix: idempotency, upsert, conflicts, unresolved refs, preservation
  relationships.test.js    # workload→env→node authority, deleted env, findReferences (delete safety)
  resource.test.js         # layered accounting, double-counting, oversubscription, UNKNOWN≠0
  placement.test.js        # priority invariants, eligibility ranking, unknown handling
  findings.test.js         # positive+negative fixture per finding code; structural invariants
  changeSandbox.test.js   # no-mutation, all op types, findings delta, malformed ops
  provenance.test.js       # truth layers, staleness, override conflicts
  dependency.test.js       # cycles, criticality inversion, SPOF, retired targets
  graph.test.js            # edges from real relationships, change diff, cycle flags, no mutation
  integrity.test.js        # decision supersession + task dependency validation
  malformed.test.js        # hostile input (nulls, NaN, huge, unicode, bad dates), order independence
  emptyState.test.js       # zero-data behavior; UNKNOWN not misleading zeros
```

## Domain modules covered

- `src/lib/canonicalImport.js` — `previewImport`, `validateEnvelope` (pure)
- `src/lib/relationships.js` — `workloadPhysicalNode`, `nodeHostedWorkloads`, `findReferences`, `resolveRef`
- `src/lib/homelab.js` — `nodeAllocations`, `nodeOversubscription`, `environmentUsage`, `scorePlacement`, `detectCycles`
- `src/lib/healthEngine.js` — `runHealthChecks` (deterministic findings)
- `src/lib/changeSandbox.js` — `applyOperations`, `analyzeChange`
- `src/lib/provenance.js` — `truthLayers`, `staleStatus`, `overrideConflicts`
- `src/lib/graph.js` — `physicalGraph`, `executionGraph`, `dependencyGraph`, `changeGraph`
- `src/lib/integrity.js` — `validateDecisionSupersession`, `detectTaskDependencyIssues`

## Core invariants under test

1. **Environment authority**: a workload's physical node is derived from its
   execution environment. A deleted environment makes the workload *unresolved* —
   it never silently falls back to a stale `current_host`.
2. **Layered accounting**: a workload inside an environment is counted via the
   environment's reservation, never double-counted against the node directly.
   Missing capacity is UNKNOWN, not zero.
3. **Placement priority**: Simplicity > Reliability > Power > Scalability >
   Performance, enforced lexicographically. An ineligible candidate can never
   rank above an eligible one; unknown evidence never becomes a PASS.
4. **Canonical import**: idempotent, never deletes, never fabricates records for
   unresolved references; local overrides conflict explicitly with canonical updates.
5. **Change sandbox**: simulation never mutates live data; findings delta is
   computed from a single proposed snapshot.
6. **Provenance**: truth layers coexist; none silently overwrites another.

## Adding a regression test

1. Pick the module that owns the behavior (see "Domain modules covered").
2. Add a fixture-based case to the matching `tests/*.test.js`.
3. For a new finding code, add a row to the `CASES` table in
   `tests/findings.test.js` (positive + negative fixture) — the matrix auto-runs
   both directions.
4. Run `npm test`.