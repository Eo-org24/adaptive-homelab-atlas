// Strict architecture-dataset loader.
//
// The UI convenience hook (useAllEntities) is allowed to cap fetches and
// substitute [] on failure — it is for display only. Architecture-wide
// operations (canonical import, duplicate detection, findings, capacity,
// graphs, dependency analysis, sync counts) must NEVER treat a fetch failure
// as "zero records" or operate on a silently-truncated dataset.
//
// This module loads the COMPLETE relevant dataset, paginating where the Base44
// SDK requires pagination, and exposes load errors + truncation rather than
// hiding them. Callers must fail closed when `complete` is false.

const DEFAULT_PAGE_SIZE = 500; // Base44 SDK max per request is 5000; 500 keeps latency bounded.
const MAX_PAGES = 200; // safety cap: 200 * 500 = 100k records per entity. Beyond this -> truncated.

// Load every record for a single entity, paginating via skip.
// Returns { records, complete, truncated, error, pages }.
// - complete=false iff a fetch threw or truncation could not be ruled out.
// - error is set when a fetch failed (records may be partial -> truncated=true).
export async function loadEntityComplete(client, entityName, { sort = "-updated_date", pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const records = [];
  let skip = 0;
  let pages = 0;
  let truncated = false;
  let error = null;
  try {
    while (pages < MAX_PAGES) {
      const batch = await client.entities[entityName].list(sort, pageSize, skip);
      if (!Array.isArray(batch)) { error = new Error(`list(${entityName}) returned non-array`); truncated = true; break; }
      records.push(...batch);
      pages++;
      if (batch.length < pageSize) break; // definitive end
      skip += pageSize;
    }
    if (pages >= MAX_PAGES) truncated = true; // could not confirm completeness within cap
  } catch (e) {
    error = e;
    truncated = true; // a failure mid-stream means we may be missing records
  }
  return { records, complete: !error && !truncated, truncated, error, pages };
}

// Load a complete architecture dataset across several entities.
// Returns { data, complete, errors, incompleteEntities, loading:false }.
// `data` is the entity->records map. `complete` is false if ANY entity failed
// or could not be confirmed complete. `incompleteEntities` lists which.
export async function loadArchitectureDataset(client, names, opts = {}) {
  const data = {};
  const errors = {};
  const incompleteEntities = [];
  const results = await Promise.all(
    names.map(async (n) => [n, await loadEntityComplete(client, n, opts)])
  );
  for (const [name, res] of results) {
    data[name] = res.records;
    if (!res.complete) {
      incompleteEntities.push(name);
      if (res.error) errors[name] = res.error.message || String(res.error);
      else errors[name] = "truncated/paginated — completeness not confirmed";
    }
  }
  return { data, complete: incompleteEntities.length === 0, errors, incompleteEntities };
}