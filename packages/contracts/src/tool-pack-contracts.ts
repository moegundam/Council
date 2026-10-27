import { z } from "zod";

export const toolPackStatuses = ["draft", "validated", "approved", "revoked"] as const;
export const toolPackValidationResults = ["pending", "passed", "failed"] as const;
export const toolPackToolKinds = ["command", "function", "library"] as const;
export const toolPackRevisionSources = ["created", "updated", "validated", "approved", "revoked"] as const;

export type ToolPackStatus = (typeof toolPackStatuses)[number];
export type ToolPackValidationResult = (typeof toolPackValidationResults)[number];
export type ToolPackToolKind = (typeof toolPackToolKinds)[number];
export type ToolPackRevisionSource = (typeof toolPackRevisionSources)[number];

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nonEmpty = z.string().trim().min(1);
export const toolPackDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const toolPackSemanticVersionSchema = z.string().trim().max(100).regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  "Tool Pack version must be a semantic version."
);
export const toolPackSourceReferenceSchema = nonEmpty.max(1_000).regex(
  /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/i,
  "Tool Pack source reference must be an OCI-style digest-pinned reference without a scheme or credentials."
);

export const toolPackDangerousEnvironmentNames = [
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
  "PERL5LIB",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYLIB"
] as const;

const dangerousEnvironmentNames = new Set<string>(toolPackDangerousEnvironmentNames);

export function toolPackEnvironmentNameIsSafe(name: string): boolean {
  return !dangerousEnvironmentNames.has(name);
}

export const toolPackEnvironmentNameSchema = z.string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
  .refine(toolPackEnvironmentNameIsSafe, "Loader-affecting environment names are not allowed.");

export const toolPackArgvSchema = z.object({
  executable: z.string().min(1).max(500).regex(/^\/[^\0\r\n]+$/, "Tool executable must be an absolute path without control characters."),
  fixedArguments: z.array(z.string().max(1_000).regex(/^[^\0\r\n]*$/)).max(64)
}).strict();

export const toolPackEnvSchema = z.object({
  allowedNames: z.array(toolPackEnvironmentNameSchema).max(32)
}).strict().superRefine((value, context) => {
  if (new Set(value.allowedNames).size !== value.allowedNames.length) {
    context.addIssue({ code: "custom", path: ["allowedNames"], message: "Each environment name may be declared only once." });
  }
});

export const toolPackStdinSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.enum(["json", "text"]), maxBytes: z.number().int().min(1).max(1_048_576) }).strict()
]);

export const toolPackDeclaredToolSchema = z.object({
  name: nonEmpty.max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  kind: z.enum(toolPackToolKinds),
  goal: nonEmpty.max(2_000),
  access: z.literal("read_only"),
  argv: toolPackArgvSchema,
  env: toolPackEnvSchema,
  stdin: toolPackStdinSchema
}).strict();

const declaredToolsSchema = z.array(toolPackDeclaredToolSchema).min(1).max(64).superRefine((tools, context) => {
  const seen = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (seen.has(tool.name)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: "Each Tool Pack tool may be declared only once." });
    }
    seen.add(tool.name);
  }
});

const toolPackManifestFields = {
  name: nonEmpty.max(120),
  version: toolPackSemanticVersionSchema,
  description: z.string().trim().max(2_000),
  owner: nonEmpty.max(200),
  sourceReference: toolPackSourceReferenceSchema,
  imageDigest: toolPackDigestSchema,
  tools: declaredToolsSchema
};

const toolPackContentFields = {
  ...toolPackManifestFields,
  manifestDigest: toolPackDigestSchema
};

function enforcePinnedSource(
  value: { sourceReference: string; imageDigest: string },
  context: z.RefinementCtx
): void {
  if (!value.sourceReference.endsWith(`@${value.imageDigest}`)) {
    context.addIssue({
      code: "custom",
      path: ["sourceReference"],
      message: "Tool Pack source reference must be pinned to the declared image digest."
    });
  }
}

export const toolPackValidationSchema = z.object({
  result: z.enum(toolPackValidationResults),
  summary: z.string().trim().max(2_000),
  checkedAt: timestamp.nullable(),
  manifestDigest: toolPackDigestSchema.nullable()
}).strict().superRefine((value, context) => {
  const pending = value.result === "pending";
  if (pending !== (value.checkedAt === null && value.manifestDigest === null)) {
    context.addIssue({ code: "custom", message: "Pending validation cannot carry evidence, and completed validation requires it." });
  }
});

const lifecycleFields = {
  revision: z.number().int().positive(),
  status: z.enum(toolPackStatuses),
  validation: toolPackValidationSchema,
  approvedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  revocationReason: nonEmpty.max(1_000).nullable()
};

function enforceLifecycle(
  value: {
    status: ToolPackStatus;
    manifestDigest: string;
    validation: z.infer<typeof toolPackValidationSchema>;
    approvedAt: string | null;
    revokedAt: string | null;
    revocationReason: string | null;
  },
  context: z.RefinementCtx
): void {
  if (value.status === "draft" && value.validation.result !== "pending") {
    context.addIssue({ code: "custom", path: ["validation"], message: "Draft Tool Packs require pending validation." });
  }
  if (value.status === "validated" && value.validation.result === "pending") {
    context.addIssue({ code: "custom", path: ["validation"], message: "Validated Tool Packs require a completed validation." });
  }
  if ((value.status === "approved" || value.status === "revoked")
    && (value.validation.result !== "passed" || value.validation.manifestDigest !== value.manifestDigest)) {
    context.addIssue({ code: "custom", path: ["validation"], message: "Approved Tool Packs require current passed validation." });
  }
  const approved = value.status === "approved" || value.status === "revoked";
  if (approved !== (value.approvedAt !== null)) {
    context.addIssue({ code: "custom", path: ["approvedAt"], message: "Tool Pack approval timestamp does not match lifecycle status." });
  }
  const revoked = value.status === "revoked";
  if (revoked !== (value.revokedAt !== null && value.revocationReason !== null)) {
    context.addIssue({ code: "custom", path: ["revokedAt"], message: "Revoked Tool Packs require terminal revocation evidence." });
  }
}

export const toolPackSchema = z.object({
  id: uuid,
  ...toolPackContentFields,
  ...lifecycleFields,
  createdAt: timestamp,
  updatedAt: timestamp
}).strict().superRefine(enforcePinnedSource).superRefine(enforceLifecycle);

export const toolPackRevisionSchema = z.object({
  packId: uuid,
  ...toolPackContentFields,
  ...lifecycleFields,
  source: z.enum(toolPackRevisionSources),
  recordedAt: timestamp
}).strict().superRefine(enforcePinnedSource).superRefine(enforceLifecycle);

export const toolPackGrantSchema = z.object({
  packId: uuid,
  revision: z.number().int().positive(),
  manifestDigest: toolPackDigestSchema,
  toolName: nonEmpty.max(120)
}).strict();

export const createToolPackSchema = z.object(toolPackManifestFields).strict().superRefine(enforcePinnedSource);

export const updateToolPackSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: toolPackManifestFields.name.optional(),
  version: toolPackManifestFields.version.optional(),
  description: toolPackManifestFields.description.optional(),
  owner: toolPackManifestFields.owner.optional(),
  sourceReference: toolPackManifestFields.sourceReference.optional(),
  imageDigest: toolPackManifestFields.imageDigest.optional(),
  tools: toolPackManifestFields.tools.optional()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
  "At least one Tool Pack field is required."
).superRefine((value, context) => {
  if (value.sourceReference !== undefined && value.imageDigest !== undefined) {
    enforcePinnedSource({ sourceReference: value.sourceReference, imageDigest: value.imageDigest }, context);
  }
});

export const validateToolPackSchema = z.object({
  expectedRevision: z.number().int().positive(),
  manifestDigest: toolPackDigestSchema,
  result: z.enum(["passed", "failed"]),
  summary: nonEmpty.max(2_000)
}).strict();

export const approveToolPackSchema = z.object({
  expectedRevision: z.number().int().positive(),
  manifestDigest: toolPackDigestSchema
}).strict();

export const revokeToolPackSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: nonEmpty.max(1_000)
}).strict();

export type ToolPackDeclaredTool = z.infer<typeof toolPackDeclaredToolSchema>;
export type ToolPackValidation = z.infer<typeof toolPackValidationSchema>;
export type ToolPack = z.infer<typeof toolPackSchema>;
export type ToolPackRevision = z.infer<typeof toolPackRevisionSchema>;
export type ToolPackGrant = z.infer<typeof toolPackGrantSchema>;
export type CreateToolPackInput = z.infer<typeof createToolPackSchema>;
export type UpdateToolPackInput = z.infer<typeof updateToolPackSchema>;
export type ValidateToolPackInput = z.infer<typeof validateToolPackSchema>;
export type ApproveToolPackInput = z.infer<typeof approveToolPackSchema>;
export type RevokeToolPackInput = z.infer<typeof revokeToolPackSchema>;

export function toolPackGrantIsCurrentAndApproved(
  grant: ToolPackGrant,
  packs: readonly ToolPack[]
): boolean {
  const pack = packs.find((candidate) => candidate.id === grant.packId);
  if (!pack
    || pack.status !== "approved"
    || pack.revision !== grant.revision
    || pack.manifestDigest !== grant.manifestDigest) {
    return false;
  }
  return pack.tools.some((tool) => tool.name === grant.toolName && tool.access === "read_only");
}

export function createToolPackRevision(
  pack: ToolPack,
  source: ToolPackRevisionSource,
  recordedAt = new Date().toISOString()
): ToolPackRevision {
  return toolPackRevisionSchema.parse({
    packId: pack.id,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    owner: pack.owner,
    sourceReference: pack.sourceReference,
    imageDigest: pack.imageDigest,
    manifestDigest: pack.manifestDigest,
    tools: structuredClone(pack.tools),
    revision: pack.revision,
    status: pack.status,
    validation: { ...pack.validation },
    approvedAt: pack.approvedAt,
    revokedAt: pack.revokedAt,
    revocationReason: pack.revocationReason,
    source,
    recordedAt
  });
}
