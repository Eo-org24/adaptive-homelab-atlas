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

// Check if a PlannedChange.operations array contains any references to deleted IDs
// that point at repairable entities. Returns a list of remap descriptors for
// operations that reference deleted IDs, or null if an unsafe/unknown reference
// is found (which should block the group).
//
// Each returned descriptor: { opIndex, field, target, oldValue, newValue }
// F3: Recursively scan a value for strings exactly matching a deleted internal ID.
// Used to detect candidate-deleted IDs in unknown structured operation fields.
function scanForDeletedIds(value, deletedIds) {
  if (value == null) return false;
  if (typeof value === "string") return deletedIds.has(value);
  if (Array.isArray(value)) return value.some((v) => scanForDeletedIds(v, deletedIds));
  if (typeof value === "object") return Object.values(value).some((v) => scanForDeletedIds(v, deletedIds));
  return false;
}

export function planOperationRemaps(operations, deleteIdToKeeper, deleteIdToEntity) {
  const remaps = [];
  if (!Array.isArray(operations)) return remaps;

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
          // F3: Type mismatch — candidate-deleted ID whose entity kind conflicts with declared target → BLOCK
          if (deleteIdToEntity.get(val) !== desc.target) return null;
          if (!deleteIdToKeeper.has(val)) return null;
          remaps.push({ opIndex: i, field: desc.field, target: desc.target, oldValue: val, newValue: deleteIdToKeeper.get(val) });
        }
      } else if (desc.resolve === "typed") {
        const typeVal = op[desc.typeField];
        if (!typeVal) {
          if (deleteIdToEntity.has(val)) return null;
          continue;
        }
        const target = TYPE_FIELD_TO_ENTITY[desc.typeField] ? TYPE_FIELD_TO_ENTITY[desc.typeField](typeVal) : null;
        if (!target) {
          if (deleteIdToEntity.has(val)) return null;
          continue;
        }
        if (!REPAIRABLE_ENTITIES.has(target)) continue;
        if (deleteIdToEntity.has(val)) {
          // F3: Type mismatch — candidate-deleted ID whose entity kind conflicts with declared type → BLOCK
          if (deleteIdToEntity.get(val) !== target) return null;
          if (!deleteIdToKeeper.has(val)) return null;
          remaps.push({ opIndex: i, field: desc.field, target, oldValue: val, newValue: deleteIdToKeeper.get(val) });
        }
      }
    }

    // F3: Second pass — scan remaining unknown structured fields conservatively.
    // If any unknown field/value contains a string exactly equal to an internal ID
    // scheduled for deletion, block the group (fail closed). Handle nested arrays/objects.
    for (const key of Object.keys(op)) {
      if (knownFields.has(key)) continue;
      if (scanForDeletedIds(op[key], deletedIds)) return null;
    }
  }

  return remaps;
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