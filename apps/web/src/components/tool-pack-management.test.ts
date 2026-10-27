import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolPack } from "@council/contracts";
import { createEmptyToolPackTool, createToolPackDraft, toolPackInputFromDraft } from "./tool-pack-management.js";

const imageDigest = `sha256:${"a".repeat(64)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;

function pack(): ToolPack {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    name: "Reader Pack",
    version: "1.0.0",
    description: "Read reports.",
    owner: "Platform Owner",
    sourceReference: `registry.example.com/council/reader@${imageDigest}`,
    imageDigest,
    manifestDigest,
    tools: [{ ...createEmptyToolPackTool(), name: "read", goal: "Read reports." }],
    revision: 1,
    status: "draft",
    validation: { result: "pending", summary: "Not validated.", checkedAt: null, manifestDigest: null },
    approvedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z"
  };
}

describe("Tool Pack management drafts", () => {
  it("retains independent exact-payload create retries until each request settles", () => {
    const source = readFileSync(new URL("./tool-pack-management.tsx", import.meta.url), "utf8");
    const saveSource = source.slice(
      source.indexOf("  async function saveToolPack("),
      source.indexOf("  async function recordValidation(")
    );
    const editorLifecycle = source.slice(
      source.indexOf("  function openEditor("),
      source.indexOf("  async function saveToolPack(")
    );

    expect(source).toContain("const toolPackCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(source).toContain("const managementMutationRetrySignatureRef = useRef(new ManagementMutationRetrySignature());");
    expect(saveSource).toContain('await managementMutationRetrySignatureRef.current.forPayload("tool-pack.create", input)');
    expect(saveSource).toContain("toolPackCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(saveSource).toContain("managementApi.createToolPack(input, retryToken.idempotencyKey)");
    expect(saveSource).toContain("toolPackCreationRetryRegistryRef.current.settle(createRetry);");
    expect(saveSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(saveSource).toContain('managementMutationRetryDisposition(cause) === "clear"');
    expect(saveSource).toContain("commitMutation(");
    expect(saveSource).not.toContain("await refresh()");
    expect(editorLifecycle).not.toContain("toolPackCreationRetryRegistryRef.current.settle");
  });

  it("confirms every dirty editor close path and keeps pending editors locked", () => {
    const source = readFileSync(new URL("./tool-pack-management.tsx", import.meta.url), "utf8");
    const closeEditor = source.slice(
      source.indexOf("  function closeEditor("),
      source.indexOf("  function updateDraft(")
    );
    const updateDraft = source.slice(
      source.indexOf("  function updateDraft("),
      source.indexOf("  async function saveToolPack(")
    );
    const editorModal = source.slice(
      source.indexOf('<Modal title={editingPack ?'),
      source.indexOf('<Modal title={validationPack ?')
    );
    const confirmation = closeEditor.indexOf("if (editorDirty && !window.confirm(");

    expect(source).toContain("const [editorDirty, setEditorDirty] = useState(false);");
    expect(closeEditor).toContain("if (pending) return;");
    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(confirmation).toBeLessThan(closeEditor.indexOf("setEditorOpen(false);"));
    expect(confirmation).toBeLessThan(closeEditor.indexOf("setEditingPack(null);"));
    expect(updateDraft).toContain("setEditorDirty(true);");
    expect(editorModal).toContain("onClose={closeEditor}");
    expect(editorModal).toContain("closeDisabled={pending}");
    expect(editorModal).toContain("busy={pending}");
    expect(editorModal).toContain("onClick={closeEditor}");
  });

  it("does not place existing full source or image digest into editor fields", () => {
    const draft = createToolPackDraft(pack());
    expect(draft.sourceReference).toBe("");
    expect(draft.imageDigest).toBe("");
  });

  it("preserves hidden immutable source identity when an edit leaves those fields blank", () => {
    const existing = pack();
    const input = toolPackInputFromDraft(createToolPackDraft(existing), existing);
    expect(input.sourceReference).toBe(existing.sourceReference);
    expect(input.imageDigest).toBe(existing.imageDigest);
    expect(input).not.toHaveProperty("manifestDigest");
  });

  it("uses one fixed packaging entrypoint without exposing free argv in the editor", () => {
    const draft = createToolPackDraft();
    draft.tools[0] = { ...draft.tools[0]!, name: "search", goal: "Search approved documents." };
    expect(toolPackInputFromDraft({
      ...draft,
      name: "Search Pack",
      sourceReference: `registry.example.com/council/search@${imageDigest}`,
      imageDigest
    }).tools[0]?.argv).toEqual({
      executable: "/opt/council/tool-pack/bin/entrypoint",
      fixedArguments: ["search"]
    });
  });
});
