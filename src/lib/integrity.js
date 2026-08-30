// Integrity checks for structured relationships that are not covered by the
// deterministic health engine: decision supersession chains and task dependency
// graphs. Pure functions over record arrays — no writes, no UI.

const key = (v) => v || "";

// Resolve a decision by decision_id, canonical_id, or internal id.
function findDecision(decisions, k) {
  return (decisions || []).find(
    (d) => key(d.decision_id) === k || key(d.canonical_id) === k || d.id === k
  );
}

// ---- Decision supersession (§16) ----
// Detect: self-supersession, mutual supersession (A→B and B→A).
export function validateDecisionSupersession(decisions) {
  const issues = [];
  const dlist = decisions || [];

  dlist.forEach((d) => {
    const sup = key(d.supersedes);
    const selfKey = key(d.decision_id) || key(d.canonical_id) || d.id;
    if (sup && sup === selfKey) {
      issues.push({ code: "DECISION_SELF_SUPERSEDE", decision: selfKey, supersedes: sup });
    }
  });

  for (let i = 0; i < dlist.length; i++) {
    for (let j = i + 1; j < dlist.length; j++) {
      const a = dlist[i];
      const b = dlist[j];
      const aKey = key(a.decision_id) || key(a.canonical_id) || a.id;
      const bKey = key(b.decision_id) || key(b.canonical_id) || b.id;
      if (key(a.supersedes) === bKey && key(b.supersedes) === aKey) {
        issues.push({ code: "DECISION_MUTUAL_SUPERSEDE", decisions: [aKey, bKey] });
      }
    }
  }
  return issues;
}

// Follow the superseded_by chain from a decision. Cycle-guarded and bounded.
export function supersessionChain(decision, decisions) {
  const chain = [decision];
  const seen = new Set([key(decision.decision_id) || key(decision.canonical_id) || decision.id]);
  let cur = decision;
  let guard = 0;
  while (guard++ < 64) {
    const nextKey = key(cur.superseded_by);
    if (!nextKey || seen.has(nextKey)) break;
    const next = findDecision(decisions, nextKey);
    if (!next) break;
    seen.add(nextKey);
    chain.push(next);
    cur = next;
  }
  return chain;
}

// ---- Task dependency (§17) ----
// Detect: self-dependency, dependency cycles, missing dependency target.
export function detectTaskDependencyIssues(tasks) {
  const issues = [];
  const tlist = tasks || [];

  tlist.forEach((t) => {
    if (t.dependency_task && t.dependency_task === t.id) {
      issues.push({ code: "TASK_SELF_DEPENDENCY", task_id: t.id });
    }
  });

  const adj = {};
  tlist.forEach((t) => {
    if (t.dependency_task) (adj[t.id] = adj[t.id] || []).push(t.dependency_task);
  });
  const cycles = [];
  const visited = {}, stack = {}, path = [];
  function dfs(n) {
    visited[n] = true; stack[n] = true; path.push(n);
    (adj[n] || []).forEach((m) => {
      if (!visited[m]) dfs(m);
      else if (stack[m]) { const idx = path.indexOf(m); cycles.push(path.slice(idx).concat(m)); }
    });
    stack[n] = false; path.pop();
  }
  Object.keys(adj).forEach((n) => { if (!visited[n]) dfs(n); });
  cycles.forEach((c) => issues.push({ code: "TASK_DEPENDENCY_CYCLE", tasks: c }));

  const find = (id) => tlist.find((t) => t.id === id);
  tlist.forEach((t) => {
    if (t.dependency_task && !find(t.dependency_task)) {
      issues.push({ code: "TASK_DEPENDENCY_MISSING", task_id: t.id, dependency_task: t.dependency_task });
    }
  });
  return issues;
}