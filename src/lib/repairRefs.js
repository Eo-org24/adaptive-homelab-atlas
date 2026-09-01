// Repair-reference descriptor: the complete persisted internal-reference vocabulary
// for duplicate repair. This is the single source of truth used by BOTH
// previewRepair and runRepair — they must use the same vocabulary.
//
// REF_FIELDS (from relationships.js) covers the "core" entity relationship fields.
// This module extends coverage to ALL persisted structured state that can point
// at V1-repairable entities (Node, ExecutionEnvironment, Workload):
//
//   Task.related_object_id        — target determined by related_object_type
//   Maintenance.target_id         — target determined by target_type
//   PlannedChange.affected_nodes  — Node internal IDs (array)
//   PlannedChange.affected_workloads — Workload internal IDs (array)
//   PlannedChange.operations[]    — structured ops with typed ID fields
//
// Safety rule: if a candidate-deleted internal ID is encountered in persisted
// structured state and its reference semantics CANNOT be determined safely,
// the duplicate group is BLOCKED (fail closed) rather than guessing.

import { REF_FIELDS, DEP_TYPE_MAP } from "@/lib/relationships";

// V1-repairable entity kinds (the only entities that duplicate-repair collapses).
export const REPAIRABLE_ENTITIES = new Set(["Node", "ExecutionEnvironment", "Workload"]);

// PlannedChange.operations ID fields that point at repairable entities.
// Each descriptor says: field name, target entity kind, and how to determine it.
// "direct" = the field value IS an internal ID of the target entity.
// "typed" = the field value is an internal ID, but the target entity is determined
//           by a sibling field (object_type) in the same operation object.
const OPERATION_ID_FIELDS = [
  { field: "workload_id", target: "Workload", resolve: "direct" },
  { field: "environment_id", target: "ExecutionEnvironment", resolve: "direct" },
  { field: "node_id", target: "Node", resolve: "direct" },
  { field: "to_node_id", target: "Node", resolve: "direct" },
  { field: "to_environment_id", target: "ExecutionEnvironment", resolve: "direct" },
  { field: "current_host_id", target: "Node", resolve: "direct" },
  { field: "object_id", target: null, resolve: "typed", typeField: "object_type" },
];

// Map object_type vocabulary to repairable entity kinds.
const OBJECT_TYPE_TO_ENTITY = {
  node: "Node",
  workload: "Workload",
  environment: "ExecutionEnvironment",
};
const TYPE_FIELD_TO_ENTITY = {
  related_object_type: (val) => OBJECT_TYPE_TO_ENTITY[val] || DEP_TYPE_MAP[val] || null,
  target_type: (val) => OBJECT_TYPE_TO_ENTITY[val] || DEP_TYPE_MAP[val] || null,
  object_type: (val) => OBJECT_TYPE_TO_ENTITY[val] || DEP_TYPE_MAP[val] || null,
};

// The complete repair-reference descriptor list.
// Each entry: { entity, field, target, array, resolve }
//   resolve: "direct" | "typed"
//   target: entity kind string, or null for typed (resolved at runtime)
//   typeField: for typed, the sibling field that determines the target
export const REPAIR_REF_DESC = [
  // Core REF_FIELDS (from relationships.js) — filtered to repairable targets
  ...REF_FIELDS.map((f) => ({
    entity: f.entity,
    field: f.field,
    target: f.target,
    array: !!f.array,
    resolve: f.target === "_source_type" ? "typed_source" : f.target === "_target_type" ? "typed_target" : "direct",
    typeField: null,
  })),
  // Task.related_object_id — typed via related_object_type
  { entity: "Task", field: "related_object_id", target: null, array: false, resolve: "typed", typeField: "related_object_type" },
  // Maintenance.target_id — typed via target_type
  { entity: "Maintenance", field: "target_id", target: null, array: false, resolve: "typed", typeField: "target_type" },
  // PlannedChange.affected_nodes — Node IDs (array)
  { entity: "PlannedChange", field: "affected_nodes", target: "Node", array: true, resolve: "direct", typeField: null },
  // PlannedChange.affected_workloads — Workload IDs (array)
  { entity: "PlannedChange", field: "affected_workloads", target: "Workload", array: true, resolve: "direct", typeField: null },
];

// Resolve the target entity for a descriptor given a specific record.
// Returns the entity kind string, or null if it cannot be determined safely.
export function resolveRefTarget(desc, rec) {
  if (desc.resolve === "direct") return desc.target;
  if (desc.resolve === "typed_source") return DEP_TYPE_MAP[rec.source_type] || null;
  if (desc.resolve === "typed_target") return DEP_TYPE_MAP[rec.target_type] || null;
  if (desc.resolve === "typed") {
    if (!desc.typeField) return null;
    const typeVal = rec[desc.typeField];
    if (!typeVal) return null;
    const resolver = TYPE_FIELD_TO_ENTITY[desc.typeField];
    return resolver ? resolver(typeVal) : null;
  }
  return null;
}

// R5: Plan operation remaps and collect structured unsafe findings.
// Returns { unsafe: [...], remaps: [...] } — ALWAYS, never null.
//
// unsafe entries: { deletedId, reason, opIndex, fieldPath }
//   - deletedId: the specific candidate-deleted internal ID that is implicated.
//     null ONLY when it is genuinely impossible to identify which deletion is
//     implicated (global block).
//   - reason: human-readable explanation.
//   - opIndex: index into the operations array.
//   - fieldPath: the field name where the unsafe reference was found.
//
// remaps entries: { opIndex, field, target, oldValue, newValue }
//
// The caller uses unsafe[].deletedId to block ONLY the duplicate groups whose
// deletion set contains that ID — not globally block all groups.
export function planOperationRemaps(operations, deleteIdToKeeper, deleteIdToEntity) {
  const remaps = [];
  const unsafe = [];
  if (!Array.isArray(operations)) return { unsafe, remaps };

  const deletedIds = new Set(deleteIdToKeeper.keys());
  // Known fields (ID fields + their type fields) — not scanned for unknown deleted IDs
  const knownFields = new Set(OPERATION_ID_FIELDS.map((f) => f.field));
  OPERATION_ID_FIELDS.forEach((f) => { if (f.typeField) knownFields.add(f.typeField); });

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op || typeof op !== "object") continue;

    // First pass: handle known ID fields
    for (const desc of OPERATION_ID_FIELDS) {
      const val = op[desc.field];
      if (val == null || val === "") continue;

      if (desc.resolve === "direct") {
        if (!desc.target) continue;
        if (!REPAIRABLE_ENTITIES.has(desc.target)) continue;
        if (deleteIdToEntity.has(val)) {
          // F3: Type mismatch — candidate-deleted ID whose entity kind conflicts with declared target
          if (deleteIdToEntity.get(val) !== desc.target) {
            unsafe.push({ deletedId: val, reason: `type mismatch: ${desc.field} expects ${desc.target} but deleted ID belongs to ${deleteIdToEntity.get(val)}`, opIndex: i, fieldPath: desc.field });
            continue;
          }
          if (!deleteIdToKeeper.has(val)) {
            unsafe.push({ deletedId: val, reason: `deleted ID has no keeper mapping`, opIndex: i, fieldPath: desc.field });
            continue;
          }
          remaps.push({ opIndex: i, field: desc.field, target: desc.target, oldValue: val, newValue: deleteIdToKeeper.get(val) });
        }
      } else if (desc.resolve === "typed") {
        const typeVal = op[desc.typeField];
        if (!typeVal) {
          if (deleteIdToEntity.has(val)) {
            unsafe.push({ deletedId: val, reason: `typed field ${desc.field} has no ${desc.typeField} to determine target entity`, opIndex: i, fieldPath: desc.field });
          }
          continue;
        }
        const target = TYPE_FIELD_TO_ENTITY[desc.typeField] ? TYPE_FIELD_TO_ENTITY[desc.typeField](typeVal) : null;
        if (!target) {
          if (deleteIdToEntity.has(val)) {
            unsafe.push({ deletedId: val, reason: `unresolvable type "${typeVal}" for ${desc.typeField}`, opIndex: i, fieldPath: desc.field });
          }
          continue;
        }
        if (!REPAIRABLE_ENTITIES.has(target)) continue;
        if (deleteIdToEntity.has(val)) {
          // F3: Type mismatch — candidate-deleted ID whose entity kind conflicts with declared type
          if (deleteIdToEntity.get(val) !== target) {
            unsafe.push({ deletedId: val, reason: `type mismatch: ${desc.field} expects ${target} but deleted ID belongs to ${deleteIdToEntity.get(val)}`, opIndex: i, fieldPath: desc.field });
            continue;
          }
          if (!deleteIdToKeeper.has(val)) {
            unsafe.push({ deletedId: val, reason: `deleted ID has no keeper mapping`, opIndex: i, fieldPath: desc.field });
            continue;
          }
          remaps.push({ opIndex: i, field: desc.field, target, oldValue: val, newValue: deleteIdToKeeper.get(val) });
        }
      }
    }

    // R5: Second pass — scan remaining unknown structured fields conservatively.
    // Collect EVERY candidate-deleted ID encountered in unknown fields, so the
    // caller can block ONLY the owning groups rather than globally blocking.
    for (const key of Object.keys(op)) {
      if (knownFields.has(key)) continue;
      const foundIds = collectDeletedIds(op[key], deletedIds);
      for (const fid of foundIds) {
        unsafe.push({ deletedId: fid, reason: `unknown structured field "${key}" contains deleted ID`, opIndex: i, fieldPath: key });
      }
    }
  }

  return { unsafe, remaps };
}

// R5: Collect ALL candidate-deleted IDs found in a value (not just a boolean).
// Recursively scans nested arrays/objects for strings matching deleted internal IDs.
function collectDeletedIds(value, deletedIds) {
  const found = [];
  if (value == null) return found;
  if (typeof value === "string") {
    if (deletedIds.has(value)) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const v of value) found.push(...collectDeletedIds(v, deletedIds));
    return found;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) found.push(...collectDeletedIds(v, deletedIds));
    return found;
  }
  return found;
}

// Apply planned operation remaps to an operations array, returning a new array.
export function applyOperationRemaps(operations, opRemaps) {
  if (!opRemaps || opRemaps.length === 0) return operations;
  const result = (operations || []).map((op, i) => ({ ...op }));
  for (const r of opRemaps) {
    if (result[r.opIndex]) {
      result[r.opIndex][r.field] = r.newValue;
    }
  }
  return result;
}