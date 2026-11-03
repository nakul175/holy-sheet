import { describe, expect, it } from "vitest";
import { standardRecordFields, type RecordField } from "./shared-record-types";
import {
  assessBinding,
  compileRoleInterface,
  componentResults,
  interfaceButtonState,
  redactRoleInterface,
  roleInterfaceAssignment,
  roleInterfaceAuthority,
  roleInterfaceBoundary,
  roleInterfaceControlSize,
  roleInterfaceOperationHash,
  roleInterfaceSharing,
  type InterfaceCompileContext,
  type InterfaceDefinition,
} from "./role-interface-plan";

const buttonId = "00000000-0000-4000-8000-0000000000b1";
const viewId = "00000000-0000-4000-8000-0000000000c1";
const retiring: RecordField = { key: "11111111-1111-4111-8111-111111111111", label: "Retiring", kind: "text", required: false, choices: [], sensitive: false, unique: false, deprecated: false, core: false, version: 1 };
const fields = [...standardRecordFields("organisations"), retiring];

function context(patch: { calculated?: string[]; owned?: string[] } = {}): InterfaceCompileContext {
  return {
    collections: new Map([["organisations", { fields, calculated: new Set(patch.calculated ?? []), owned: new Set(patch.owned ?? []) }]]),
    views: new Map([[viewId, { collection: "organisations" }]]),
    buttons: new Set([buttonId]),
  };
}

function body(patch: Record<string, unknown> = {}) {
  return {
    navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }],
    screens: [{
      id: "clinic",
      name: "Clinic",
      components: [
        { id: "roster", kind: "list", collection: "organisations", viewId, fields: [{ key: retiring.key, version: 1 }] },
        { id: "focus", kind: "detail", collection: "organisations", fields: [{ key: "core:registration", version: 1 }] },
        { id: "edit", kind: "form", collection: "organisations", fields: [{ key: "core:notes", version: 1 }] },
        { id: "mix", kind: "chart", collection: "organisations", viewId: null, field: { key: "core:registration", version: 1 } },
        { id: "go", kind: "button", buttonId },
      ],
    }],
    roles: ["member"],
    ...patch,
  };
}

describe("role interface rules", () => {
  describe("N62-01", () => {
    it("compiles named navigation, screens, and collection, view, and field bindings", () => {
      const definition = compileRoleInterface(body(), context());
      expect(definition.navigation).toEqual([{ id: "home", label: "Clinic", screenId: "clinic" }]);
      expect(definition.screens[0].components.map(component => component.kind)).toEqual(["list", "detail", "form", "chart", "button"]);
      expect(definition.roles).toEqual(["member"]);
      const list = definition.screens[0].components[0];
      expect(list).toMatchObject({ kind: "list", viewId, fields: [{ key: retiring.key, version: 1 }] });
    });
  });

  describe("N62-02", () => {
    it("keeps role visibility from becoming a data grant", () => {
      expect(roleInterfaceAuthority).toContain("does not grant collection browse");
      expect(roleInterfaceAssignment).toContain("does not grant access");
      const definition = compileRoleInterface(body(), context());
      expect(definition.roles).toEqual(["member"]);
      expect(JSON.stringify(definition)).not.toContain("grant");
    });
  });

  describe("N62-03", () => {
    it("rejects calculated and owned fields and scripts", () => {
      const secret = "hidden-salary-value";
      expect(() => compileRoleInterface(body({ script: secret }), context())).toThrowError(expect.objectContaining({ code: "role_interface_validation" }));
      try { compileRoleInterface(body({ script: secret }), context()); }
      catch (error) { expect(JSON.stringify(error)).not.toContain(secret); expect((error as Error).message).not.toContain(secret); }
      expect(() => compileRoleInterface(body({
        screens: [{ id: "clinic", name: "Clinic", components: [{ id: "edit", kind: "form", collection: "organisations", fields: [{ key: retiring.key, version: 1 }] }] }],
        navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }],
      }), context({ calculated: [retiring.key] }))).toThrowError(expect.objectContaining({ code: "role_interface_calculated" }));
      expect(() => compileRoleInterface(body({
        screens: [{ id: "clinic", name: "Clinic", components: [{ id: "edit", kind: "form", collection: "organisations", fields: [{ key: "parent_organisation_id", version: 1 }] }] }],
        navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }],
      }), context())).toThrowError(expect.objectContaining({ code: "role_interface_owned" }));
    });
  });

  describe("N62-04", () => {
    it("reports one broken binding and leaves another component usable", () => {
      const broken = assessBinding({ collectionPresent: true, collectionDeprecated: false, viewBound: true, viewPresent: true, viewVisible: true, fields: [{ present: true, deprecated: true, version: 1, boundVersion: 1, calculated: false, owned: false }], buttonBound: false, buttonPresent: true, buttonDeprecated: false, buttonCalculated: false, buttonOwned: false });
      const ready = assessBinding({ collectionPresent: true, collectionDeprecated: false, viewBound: false, viewPresent: true, viewVisible: true, fields: [{ present: true, deprecated: false, version: 1, boundVersion: 1, calculated: false, owned: false }], buttonBound: false, buttonPresent: true, buttonDeprecated: false, buttonCalculated: false, buttonOwned: false });
      expect(broken).toEqual({ status: "broken", reason: "deprecated-field" });
      expect(ready).toEqual({ status: "ready", reason: null });
      expect(componentResults([broken, ready])).toEqual({ ready: 1, broken: 1, usable: true });
      expect(assessBinding({ collectionPresent: true, collectionDeprecated: false, viewBound: true, viewPresent: false, viewVisible: false, fields: [], buttonBound: false, buttonPresent: true, buttonDeprecated: false, buttonCalculated: false, buttonOwned: false }).reason).toBe("missing-view");
      expect(roleInterfaceSharing).toContain("not shared publicly");
      expect(() => compileRoleInterface(body({ sharing: "public" }), context())).toThrowError(expect.objectContaining({ code: "role_interface_public" }));
    });
  });

  describe("N62-05", () => {
    it("redacts a field the caller cannot view", () => {
      const secret = "hidden-salary-value";
      const definition = compileRoleInterface(body({
        screens: [{
          id: "clinic",
          name: "Clinic",
          components: [
            { id: "focus", kind: "detail", collection: "organisations", fields: [{ key: retiring.key, version: 1 }, { key: "core:notes", version: 1 }] },
            { id: "edit", kind: "form", collection: "organisations", fields: [{ key: "core:notes", version: 1 }] },
          ],
        }],
      }), context()) satisfies InterfaceDefinition;
      const redacted = redactRoleInterface(definition, new Set(["core:notes"]), new Set());
      expect(JSON.stringify(redacted)).not.toContain(retiring.key);
      expect(JSON.stringify(redacted)).not.toContain(secret);
      expect(JSON.stringify(redacted)).toContain("restricted");
      expect(roleInterfaceBoundary).toContain("do not run scripts");
    });
  });

  describe("N62-06", () => {
    it("changes the operation hash when configuration changes and keeps controls phone sized", () => {
      expect(roleInterfaceControlSize).toBeGreaterThanOrEqual(44);
      const first = compileRoleInterface(body(), context());
      const second = compileRoleInterface(body({ navigation: [{ id: "home", label: "Ward", screenId: "clinic" }] }), context());
      expect(roleInterfaceOperationHash(first)).not.toBe(roleInterfaceOperationHash(second));
      expect(interfaceButtonState({ status: "draft", canAct: true, hasRecord: true })).toEqual({ enabled: false, reason: "draft" });
      expect(interfaceButtonState({ status: "active", canAct: true, hasRecord: true })).toEqual({ enabled: true, reason: null });
    });
  });
});
