import { describe, expect, it } from "vitest";
import { standardRecordFields } from "./shared-record-types";
import {
  applyWorkflowAction,
  assertRuntimeIdentity,
  compileWorkflowDefinition,
  evaluateWorkflowConditions,
  redactWorkflowDefinition,
  workflowBackoff,
  workflowDepthOutcome,
  workflowEventKey,
  workflowStepKey,
  type WorkflowDefinition,
} from "./workflow-automation-plan";

const fields = standardRecordFields("organisations");
const notes = fields.find(field => field.key === "core:notes")!;
const subject = "00000000-0000-4000-8000-0000000000aa";

function definition(patch: Record<string, unknown> = {}): WorkflowDefinition {
  return compileWorkflowDefinition({
    trigger: { event: "record.created" },
    conditions: { all: [{ field: "core:notes", operator: "is-empty" }] },
    actions: [{ type: "set-field", field: "core:notes", value: "Hello" }],
    identity: { kind: "delegated", subjectId: subject },
    ...patch,
  }, fields);
}

describe("workflow rules", () => {
  describe("identity", () => {
    it("requires an explicit delegated or service identity", () => {
      expect(assertRuntimeIdentity({ kind: "service", subjectId: "svc-1" })).toEqual({ kind: "service", subjectId: "svc-1" });
      expect(definition().identity).toEqual({ kind: "delegated", subjectId: subject });
      expect(() => assertRuntimeIdentity({ kind: "delegated" })).toThrowError(expect.objectContaining({ code: "workflow_identity" }));
      expect(() => assertRuntimeIdentity({ kind: "agent", subjectId: subject })).toThrowError(expect.objectContaining({ code: "workflow_identity" }));
      expect(() => definition({ identity: { kind: "delegated", subjectId: subject, inherit: true } })).toThrowError(expect.objectContaining({ code: "workflow_identity" }));
    });
  });

  describe("idempotency", () => {
    it("keeps event and step keys stable and bounds retry and depth", () => {
      const parts = { tenantId: "tenant", workflowId: "wf", recordId: "rec", event: "record.created", sourceKey: "src-1" };
      expect(workflowEventKey(parts)).toBe(workflowEventKey({ ...parts }));
      expect(workflowEventKey(parts)).not.toBe(workflowEventKey({ ...parts, sourceKey: "src-2" }));
      expect(workflowStepKey("event", 0)).toBe(workflowStepKey("event", 0));
      expect(workflowStepKey("event", 0)).not.toBe(workflowStepKey("event", 1));
      expect(workflowBackoff(1)).toBe(1000);
      expect(workflowBackoff(2)).toBe(4000);
      expect(workflowBackoff(3)).toBeNull();
      expect(workflowDepthOutcome(10)).toBe("run");
      expect(workflowDepthOutcome(11)).toBe("dead-letter");
    });
  });

  describe("permissions", () => {
    it("rejects unknown, unique, and non-allowlisted actions without echoing the value", () => {
      const secret = "hidden-salary-value";
      expect(() => definition({ conditions: { all: [{ field: "missing", operator: "equals", value: secret }] } })).toThrowError(expect.objectContaining({ code: "workflow_field" }));
      try { definition({ actions: [{ type: "ask-model", field: "core:notes", prompt: secret }] }); }
      catch (error) { expect(JSON.stringify(error)).not.toContain(secret); expect(error).toMatchObject({ code: "workflow_validation" }); }
      expect(() => definition({ actions: [{ type: "append-note", field: "core:domain", text: "nope" }] })).toThrowError(expect.objectContaining({ code: "workflow_field" }));
      const redacted = redactWorkflowDefinition(definition({ conditions: { all: [{ field: "core:notes", operator: "equals", value: secret }] } }), new Set());
      expect(JSON.stringify(redacted)).not.toContain(secret);
      expect(JSON.stringify(redacted)).not.toContain("core:notes");
      expect(redacted.identity.subjectId).toBe(subject);
    });
  });

  describe("versioning and drafts", () => {
    it("types conditions and actions that a saved definition can reapply", () => {
      const saved = definition({ conditions: { all: [{ field: "core:notes", operator: "equals", value: "Hello" }] }, actions: [{ type: "append-note", field: "core:notes", text: " again" }] });
      expect(evaluateWorkflowConditions(saved, { "core:notes": "Hello" }, new Set())).toEqual({ matched: true, blocked: null });
      expect(evaluateWorkflowConditions(saved, { "core:notes": "Hello" }, new Set(["core:notes"]))).toEqual({ matched: false, blocked: "field" });
      expect(applyWorkflowAction(notes, "Hello", saved.actions[0])).toBe("Hello\n again");
      expect(evaluateWorkflowConditions(saved, {}, new Set())).toEqual({ matched: false, blocked: null });
    });
  });
});
