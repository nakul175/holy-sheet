import { describe, expect, it } from "vitest";
import { standardRecordFields } from "./shared-record-types";
import {
  actionButtonAssignment,
  actionButtonAuthority,
  actionButtonBoundary,
  actionControlSize,
  actionImpact,
  actionOperationHash,
  buttonAvailability,
  compileActionButton,
  receiptSeparatesLink,
  redactActionButton,
  resolveActionInputs,
  type ActionButtonDefinition,
} from "./action-button-plan";

const fields = standardRecordFields("organisations");
const notes = fields.find(field => field.key === "core:notes")!;
const domain = fields.find(field => field.key === "core:domain")!;

function body(patch: Record<string, unknown> = {}) {
  return {
    context: { collection: "organisations", placement: "record" },
    inputs: [{ id: "note", field: "core:notes", required: true, default: "Hello" }],
    target: { actionId: "hs.record.append-note", field: "core:notes", inputId: "note" },
    link: null,
    ...patch,
  };
}

describe("action button rules", () => {
  describe("N61-01", () => {
    it("defines a label context, stable field ids, and an allowlisted action target", () => {
      const definition = compileActionButton(body(), fields, "organisations");
      expect(definition.context).toEqual({ collection: "organisations", placement: "record" });
      expect(definition.inputs[0]).toEqual({ id: "note", field: "core:notes", required: true, default: "Hello" });
      expect(definition.target).toEqual({ actionId: "hs.record.append-note", field: "core:notes", inputId: "note" });
      expect(definition.link).toBeNull();
      const secret = "hidden-salary-value";
      expect(() => compileActionButton(body({ target: { actionId: "hs.script.run", field: "core:notes", inputId: "note", script: secret } }), fields, "organisations")).toThrowError(expect.objectContaining({ code: "action_button_validation" }));
      try { compileActionButton(body({ link: { linkId: "https://evil.example/run", url: secret } }), fields, "organisations"); }
      catch (error) { expect(JSON.stringify(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain("https://evil.example"); }
      expect(() => compileActionButton(body({ target: { actionId: "hs.record.legacy-note", field: "core:notes", inputId: "note" } }), fields, "organisations")).toThrowError(expect.objectContaining({ code: "action_button_deprecated" }));
      expect(() => compileActionButton(body({ identity: { kind: "delegated", subjectId: "creator" } }), fields, "organisations")).toThrowError(expect.objectContaining({ code: "action_button_validation" }));
    });
  });

  describe("N61-02", () => {
    it("previews a mutation from required inputs and keeps a url value as data", () => {
      const definition = compileActionButton(body(), fields, "organisations");
      expect(resolveActionInputs(definition, undefined, fields)).toEqual({ note: "Hello" });
      expect(actionImpact(notes, "", definition.target, "Hello")).toBe("Hello");
      expect(() => resolveActionInputs(compileActionButton(body({ inputs: [{ id: "note", field: "core:notes", required: true }] }), fields, "organisations"), {}, fields)).toThrowError(expect.objectContaining({ code: "action_button_validation" }));
      const saved = compileActionButton({
        context: { collection: "organisations", placement: "page" },
        inputs: [{ id: "site", field: "core:domain", required: true, default: "https://example.com/records" }],
        target: { actionId: "hs.record.set-field", field: "core:domain", inputId: "site" },
        link: { linkId: "hs.page.open", pageId: "welcome" },
      }, fields, "organisations");
      expect(actionImpact(domain, null, saved.target, saved.inputs[0].default)).toBe("https://example.com/records");
      expect(saved.link).toEqual({ linkId: "hs.page.open", pageId: "welcome" });
    });
  });

  describe("N61-03", () => {
    it("keeps an operation hash stable and separates action success from link failure", () => {
      const parts = { buttonId: "button", recordId: "record", inputs: { note: "Hello" } };
      expect(actionOperationHash(parts)).toBe(actionOperationHash({ ...parts }));
      expect(actionOperationHash(parts)).not.toBe(actionOperationHash({ ...parts, inputs: { note: "Other" } }));
      expect(receiptSeparatesLink({ actionStatus: "succeeded", linkStatus: "failed", recoverable: true })).toBe(true);
      expect(receiptSeparatesLink({ actionStatus: "succeeded", linkStatus: "succeeded", recoverable: true })).toBe(false);
      expect(receiptSeparatesLink({ actionStatus: "failed", linkStatus: "failed", recoverable: true })).toBe(false);
    });
  });

  describe("N61-04", () => {
    it("disables stale, deprecated, paused, and forbidden targets at a phone-sized control", () => {
      expect(actionControlSize).toBeGreaterThanOrEqual(44);
      expect(buttonAvailability({ status: "active", contractDeprecated: false, fieldDeprecated: true, contextMatches: true, canAct: true, stale: false })).toEqual({ enabled: false, reason: "deprecated-target" });
      expect(buttonAvailability({ status: "active", contractDeprecated: true, fieldDeprecated: false, contextMatches: true, canAct: true, stale: true })).toEqual({ enabled: false, reason: "stale-target" });
      expect(buttonAvailability({ status: "paused", contractDeprecated: false, fieldDeprecated: false, contextMatches: true, canAct: true, stale: false })).toEqual({ enabled: false, reason: "paused" });
      expect(buttonAvailability({ status: "draft", contractDeprecated: false, fieldDeprecated: false, contextMatches: true, canAct: true, stale: false })).toEqual({ enabled: false, reason: "draft" });
      expect(buttonAvailability({ status: "active", contractDeprecated: false, fieldDeprecated: false, contextMatches: false, canAct: true, stale: false })).toEqual({ enabled: false, reason: "context" });
      expect(buttonAvailability({ status: "active", contractDeprecated: false, fieldDeprecated: false, contextMatches: true, canAct: false, stale: false })).toEqual({ enabled: false, reason: "forbidden" });
      expect(buttonAvailability({ status: "active", contractDeprecated: false, fieldDeprecated: false, contextMatches: true, canAct: true, stale: false })).toEqual({ enabled: true, reason: null });
    });
  });

  describe("N61-05", () => {
    it("redacts a field the caller cannot view and does not treat configuration as access", () => {
      const secret = "hidden-salary-value";
      const definition = compileActionButton(body({ inputs: [{ id: "note", field: "core:notes", required: true, default: secret }] }), fields, "organisations");
      const redacted = redactActionButton(definition, new Set());
      expect(JSON.stringify(redacted)).not.toContain(secret);
      expect(JSON.stringify(redacted)).not.toContain("core:notes");
      expect(redacted.target).toMatchObject({ field: "restricted" });
      expect(actionButtonAssignment).toContain("does not grant access");
      expect(actionButtonAuthority).toContain("does not grant the action");
      expect(actionButtonBoundary).toContain("do not run scripts");
    });
  });

  describe("N61-06", () => {
    it("changes the operation hash when mutable configuration changes", () => {
      const first = compileActionButton(body(), fields, "organisations");
      const second = compileActionButton(body({ inputs: [{ id: "note", field: "core:notes", required: true, default: "Kept" }] }), fields, "organisations");
      expect(actionOperationHash(first)).not.toBe(actionOperationHash(second));
      expect(resolveActionInputs(second, { note: "Kept" }, fields).note).toBe("Kept");
      const cleared = compileActionButton({
        context: { collection: "organisations", placement: "record" },
        inputs: [],
        target: { actionId: "hs.record.clear-field", field: "core:registration" },
        link: null,
      }, fields, "organisations") satisfies ActionButtonDefinition;
      expect(actionImpact(fields.find(field => field.key === "core:registration")!, "AB-1", cleared.target, undefined)).toBeNull();
    });
  });
});
