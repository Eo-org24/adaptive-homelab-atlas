import { describe, it, expect } from "vitest";
import { validateDecisionSupersession, supersessionChain, detectTaskDependencyIssues } from "@/lib/integrity";

const D = (id, o = {}) => ({ id, decision_id: id, title: id, ...o });
const T = (id, o = {}) => ({ id, task: id, ...o });

describe("decision supersession", () => {
  it("detects self-supersession", () => {
    const issues = validateDecisionSupersession([D("d1", { supersedes: "d1" })]);
    expect(issues.some((i) => i.code === "DECISION_SELF_SUPERSEDE")).toBe(true);
  });
  it("detects mutual supersession (A→B and B→A)", () => {
    const issues = validateDecisionSupersession([D("d1", { supersedes: "d2" }), D("d2", { supersedes: "d1" })]);
    expect(issues.some((i) => i.code === "DECISION_MUTUAL_SUPERSEDE")).toBe(true);
  });
  it("accepts a valid linear supersession chain", () => {
    const issues = validateDecisionSupersession([D("d1", { supersedes: "d2" }), D("d2")]);
    expect(issues).toHaveLength(0);
  });
  it("builds the supersession chain via superseded_by", () => {
    const decisions = [D("d1", { superseded_by: "d2" }), D("d2", { superseded_by: "d3" }), D("d3")];
    const chain = supersessionChain(decisions[0], decisions).map((d) => d.decision_id);
    expect(chain).toEqual(["d1", "d2", "d3"]);
  });
  it("chain is cycle-guarded (does not loop forever)", () => {
    const decisions = [D("d1", { superseded_by: "d2" }), D("d2", { superseded_by: "d1" })];
    expect(() => supersessionChain(decisions[0], decisions)).not.toThrow();
    const chain = supersessionChain(decisions[0], decisions).map((d) => d.decision_id);
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});

describe("task dependency", () => {
  it("detects self-dependency", () => {
    const issues = detectTaskDependencyIssues([T("t1", { dependency_task: "t1" })]);
    expect(issues.some((i) => i.code === "TASK_SELF_DEPENDENCY")).toBe(true);
  });
  it("detects a dependency cycle", () => {
    const issues = detectTaskDependencyIssues([T("t1", { dependency_task: "t2" }), T("t2", { dependency_task: "t1" })]);
    expect(issues.some((i) => i.code === "TASK_DEPENDENCY_CYCLE")).toBe(true);
  });
  it("detects a missing dependency target", () => {
    const issues = detectTaskDependencyIssues([T("t1", { dependency_task: "ghost" })]);
    expect(issues.some((i) => i.code === "TASK_DEPENDENCY_MISSING")).toBe(true);
  });
  it("accepts a valid dependency chain", () => {
    const issues = detectTaskDependencyIssues([T("t1", { dependency_task: "t2" }), T("t2")]);
    expect(issues).toHaveLength(0);
  });
  it("keeps free-text dependency notes separate from structured references", () => {
    // a dependency note without a structured dependency_task must not be treated as a cycle/missing ref
    const issues = detectTaskDependencyIssues([T("t1", { dependency: "after we buy RAM" })]);
    expect(issues).toHaveLength(0);
  });
});