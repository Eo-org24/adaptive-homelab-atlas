// Strict recursive validation of the frozen adaptive-homelab-atlas/v1 contract.
// Uses Zod (.strict mode) to reject unknown properties at every level.
// This runs BEFORE normalization or writes — malformed input never reaches the DB.
import { z } from "zod";

const V1 = "adaptive-homelab-atlas/v1";

// ---- Typed-id shape: <kind>:<id> ----
const typedIdRegex = /^[a-z-]+:.+$/;

// ---- Capability: exactly { type, id } — no open-ended properties ----
const capabilitySchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
}).strict();

// ---- Capability requirement: exactly { type, instance } — no open-ended properties ----
const capabilityRequirementSchema = z.object({
  type: z.string().min(1),
  instance: z.string().min(1),
}).strict();

// ---- Provenance: exactly { source_class: "canonical" } ----
const provenanceSchema = z.object({
  source_class: z.literal("canonical"),
}).strict();

// ---- Entity base (shared by all kinds) ----
const entityBase = {
  schema: z.string().min(1),
  kind: z.string().min(1),
  id: z.string().min(1),
  provenance: provenanceSchema,
};

// ---- Node (homelab.node/v1) ----
const nodeSchema = z.object({
  ...entityBase,
  identity: z.object({
    physical_name: z.string().optional(),
    fqdn: z.string().optional(),
  }).strict().optional(),
  purpose: z.array(z.string()).optional(),
  lifecycle: z.object({
    state: z.string().optional(),
  }).strict().optional(),
  availability: z.object({
    expected: z.string().optional(),
  }).strict().optional(),
  capabilities: z.array(capabilitySchema).optional(),
  resources: z.object({
    memory_gib: z.number().optional(),
    cpu: z.object({
      model: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

// ---- Execution Provider (homelab.execution-provider/v1) ----
const providerSchema = z.object({
  ...entityBase,
  purpose: z.array(z.string()).optional(),
  runtime: z.object({
    kind: z.string().optional(),
    autostart: z.boolean().optional(),
  }).strict().optional(),
  capabilities: z.array(capabilitySchema).optional(),
}).strict();

// ---- Workload (homelab.workload/v1) ----
const workloadSchema = z.object({
  ...entityBase,
  display_name: z.string().optional(),
  maturity: z.string().optional(),
  runtime: z.object({
    kind: z.string().optional(),
  }).strict().optional(),
  requirements: z.object({
    capabilities: z.array(capabilityRequirementSchema).optional(),
  }).strict().optional(),
}).strict();

// ---- Kind -> schema validator + expected V1 schema string ----
const KIND_VALIDATORS = {
  node: nodeSchema,
  "execution-provider": providerSchema,
  workload: workloadSchema,
};
const KIND_SCHEMA_STRING = {
  node: "homelab.node/v1",
  "execution-provider": "homelab.execution-provider/v1",
  workload: "homelab.workload/v1",
};

// ---- Relationship: exactly { source, type, target } ----
const RELATIONSHIP_TYPES = ["hosted_on", "placement_allowed_on_provider", "placement_allowed_on_node", "depends_on"];
const relationshipSchema = z.object({
  source: z.string().regex(typedIdRegex, "relationship source must be a typed id <kind>:<id>"),
  type: z.enum(RELATIONSHIP_TYPES),
  target: z.string().regex(typedIdRegex, "relationship target must be a typed id <kind>:<id>"),
}).strict();

// ---- Envelope ----
const contentDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/i, "content_digest must be 'sha256:<64 hex chars>'");

const envelopeSchema = z.object({
  schema_version: z.literal(V1),
  generated_at: z.string().refine((v) => !isNaN(Date.parse(v)), "generated_at must be a valid date-time"),
  producer: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }).strict(),
  source: z.object({
    repository: z.string().min(1),
    commit: z.string(),
    is_dirty: z.boolean(),
    content_digest: contentDigestSchema.optional(),
  }).strict(),
  entities: z.array(z.union([nodeSchema, providerSchema, workloadSchema])),
  relationships: z.array(relationshipSchema),
}).strict();

// ---- Relationship endpoint kind enforcement ----
const REL_KIND_RULES = {
  hosted_on: { sourceKind: "execution-provider", targetKind: "node" },
  placement_allowed_on_provider: { sourceKind: "workload", targetKind: "execution-provider" },
  placement_allowed_on_node: { sourceKind: "workload", targetKind: "node" },
  depends_on: { sourceKind: "workload", targetKind: "workload" },
};

function parseTypedId(s) {
  if (typeof s !== "string") return null;
  const i = s.indexOf(":");
  if (i < 0) return null;
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
}

function validateRelationshipKinds(relationships) {
  const errors = [];
  (relationships || []).forEach((r, idx) => {
    const rule = REL_KIND_RULES[r.type];
    if (!rule) return; // unknown type caught by Zod
    const s = parseTypedId(r.source), t = parseTypedId(r.target);
    if (!s || !t) return;
    if (s.kind !== rule.sourceKind) errors.push({ path: ["relationships", idx, "source"], message: `relationship "${r.type}" requires source kind "${rule.sourceKind}", got "${s.kind}"` });
    if (t.kind !== rule.targetKind) errors.push({ path: ["relationships", idx, "target"], message: `relationship "${r.type}" requires target kind "${rule.targetKind}", got "${t.kind}"` });
  });
  return errors;
}

// ---- Schema/kind consistency ----
function validateSchemaKindConsistency(entities) {
  const errors = [];
  (entities || []).forEach((e, idx) => {
    const expected = KIND_SCHEMA_STRING[e.kind];
    if (expected && e.schema !== expected) {
      errors.push({ path: ["entities", idx, "schema"], message: `kind "${e.kind}" requires schema "${expected}", got "${e.schema}"` });
    }
  });
  return errors;
}

// ---- Main strict validation entry point ----
// Returns { valid: boolean, errors: string[] }.
export function validateV1Strict(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { valid: false, errors: ["Envelope is not a JSON object."] };
  }
  // Zod strict envelope validation
  const envResult = envelopeSchema.safeParse(envelope);
  const errors = [];
  if (!envResult.success) {
    envResult.error.issues.forEach((iss) => {
      errors.push(`${iss.path.join(".") || "(root)"}: ${iss.message}`);
    });
  }
  // If envelope shape is valid, validate cross-field consistency
  if (envResult.success) {
    const schemaKindErrors = validateSchemaKindConsistency(envelope.entities);
    const relKindErrors = validateRelationshipKinds(envelope.relationships);
    schemaKindErrors.forEach((e) => errors.push(`${e.path.join(".")}: ${e.message}`));
    relKindErrors.forEach((e) => errors.push(`${e.path.join(".")}: ${e.message}`));
  }
  return { valid: errors.length === 0, errors };
}

export { V1, RELATIONSHIP_TYPES, REL_KIND_RULES, KIND_VALIDATORS, KIND_SCHEMA_STRING };