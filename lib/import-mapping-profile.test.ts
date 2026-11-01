import { expect, it } from "vitest";
import {
  applyImportProfile,
  columnsFromPositionalMapping,
  importProfileAccess,
  profileCompatibility,
  profilePayloadHasSecrets,
  snapshotBindings,
  validateProfileColumns,
  type ImportProfileField,
} from "./import-mapping-profile";

const notes: ImportProfileField = { fieldId: "core:notes", label: "Notes", kind: "long-text", choices: [], required: false, unique: false, deprecated: false, referenceListId: null, referenceListVersion: null, sensitive: false, visible: true, writable: true };
const choice: ImportProfileField = { ...notes, fieldId: "field-choice", label: "Department", kind: "single-select", choices: ["one", "two"] };
const amount: ImportProfileField = { ...notes, fieldId: "field-amount", label: "Amount", kind: "number" };
const secret = "secret-sample-value";

it("saves a collection-bound create or update mapping by field id", () => {
  const created = columnsFromPositionalMapping(["Name", "Notes"], { mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] }, "organisations");
  expect(created).toEqual({ ok: true, columns: [{ header: "Name", role: "name" }, { header: "Notes", role: "field", fieldId: "core:notes" }] });
  const updated = columnsFromPositionalMapping(["HS ID", "Notes"], { mode: "update", idColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] }, "organisations");
  expect(updated.ok).toBe(true);
  expect(validateProfileColumns("create", [{ header: "Notes", role: "field", fieldId: "core:notes" }], "organisations").ok).toBe(false);
  expect(validateProfileColumns("update", [{ header: "Name", role: "name" }], "organisations").ok).toBe(false);
  expect(columnsFromPositionalMapping(["Name", "Parent"], { mode: "create", nameColumn: 0, parentOrganisationColumn: 1, fields: [] }, "accounts").ok).toBe(true);
});

it("previews header and sample type differences and requires repair for ambiguous or missing required columns", () => {
  const columns = [{ header: "Name", role: "name" as const }, { header: "Notes", role: "field" as const, fieldId: "core:notes" }, { header: "Amount", role: "field" as const, fieldId: "field-amount" }];
  const bindings = snapshotBindings(columns, [notes, amount]);
  const ambiguous = applyImportProfile({ collection: "organisations", mode: "create", columns, bindings, fields: [notes, amount], headers: ["Name", "Notes", "Notes", "Amount"], samples: [["Ada", secret, secret, "12"]] });
  expect(ambiguous.repairRequired).toBe(true);
  expect(ambiguous.mapping).toBeNull();
  expect(ambiguous.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ambiguous_header", header: "Notes", repair: true })]));
  expect(JSON.stringify(ambiguous)).not.toContain(secret);
  const missing = applyImportProfile({ collection: "organisations", mode: "create", columns, bindings, fields: [notes, amount], headers: ["Notes", "Amount"], samples: [[secret, "nope"]] });
  expect(missing.repairRequired).toBe(true);
  expect(missing.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_required", header: "Name", repair: true })]));
  expect(missing.mapping).toBeNull();
  const typed = applyImportProfile({ collection: "organisations", mode: "create", columns, bindings, fields: [notes, amount], headers: ["Name", "Notes", "Amount"], samples: [["Ada", secret, "nope"]] });
  expect(typed.repairRequired).toBe(false);
  expect(typed.mapping).toMatchObject({ mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }, { column: 2, fieldKey: "field-amount" }] });
  expect(typed.typeDiffs).toEqual(expect.arrayContaining([expect.objectContaining({ header: "Amount", expectedKind: "number", observedKind: "text", difference: true })]));
  expect(typed.headerDiffs).toEqual(expect.arrayContaining([expect.objectContaining({ header: "Name", status: "matched" })]));
  expect(JSON.stringify(typed)).not.toContain(secret);
  expect(typed.samplesStored).toBe(false);
});

it("marks schema, choice and key changes incompatible without treating a label-only field as changed", () => {
  const bindings = snapshotBindings([{ header: "Department", role: "field", fieldId: choice.fieldId }], [choice]);
  expect(profileCompatibility(bindings, [choice]).compatibility).toBe("compatible");
  expect(profileCompatibility(bindings, [{ ...choice, label: "Team" }]).compatibility).toBe("compatible");
  expect(profileCompatibility(bindings, [{ ...choice, choices: ["one"] }]).reasons).toEqual([{ code: "choices_changed", fieldId: choice.fieldId }]);
  expect(profileCompatibility(bindings, [{ ...choice, unique: true }]).reasons).toEqual([{ code: "key_changed", fieldId: choice.fieldId }]);
  expect(profileCompatibility(bindings, [{ ...choice, kind: "text", choices: [] }]).reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["kind_changed", "choices_changed"]));
  expect(profileCompatibility(bindings, []).reasons).toEqual([{ code: "field_missing", fieldId: choice.fieldId }]);
  const preview = applyImportProfile({ collection: "organisations", mode: "update", columns: [{ header: "HS ID", role: "record-id" }, { header: "Department", role: "field", fieldId: choice.fieldId }], bindings, fields: [{ ...choice, choices: ["one", "three"] }], headers: ["HS ID", "Department"], samples: [] });
  expect(preview.compatibility).toBe("incompatible");
  expect(preview.repairRequired).toBe(true);
  expect(preview.mapping).toBeNull();
});

it("separates personal and shared management from use, schema and assignment", () => {
  const personal = { scope: "personal" as const, ownerId: "owner", actorId: "other", capabilities: ["view", "import", "manage-import-profiles", "schema"] };
  expect(importProfileAccess(personal)).toEqual({ visible: false, canManage: false, canUse: false });
  expect(importProfileAccess({ ...personal, actorId: "owner", capabilities: ["view", "import"] })).toEqual({ visible: true, canManage: true, canUse: true });
  expect(importProfileAccess({ scope: "shared", ownerId: "owner", actorId: "other", capabilities: ["view", "import"] })).toEqual({ visible: true, canManage: false, canUse: true });
  expect(importProfileAccess({ scope: "shared", ownerId: "owner", actorId: "other", capabilities: ["view", "import", "manage-import-profiles"] }).canManage).toBe(true);
  expect(importProfileAccess({ scope: "shared", ownerId: "owner", actorId: "other", capabilities: ["manage-import-profiles", "schema"] }).visible).toBe(false);
  expect(importProfileAccess({ scope: "shared", ownerId: "owner", actorId: "other", capabilities: ["view", "schema"] }).visible).toBe(false);
});

it("rejects stored samples and secrets", () => {
  expect(profilePayloadHasSecrets({ columns: [{ header: "Name", samples: [secret] }] })).toBe(true);
  expect(profilePayloadHasSecrets({ password: secret })).toBe(true);
  expect(profilePayloadHasSecrets({ columns: [{ header: "Name", role: "name" }] })).toBe(false);
  expect(validateProfileColumns("create", [{ header: "Name", role: "name" }, { header: "Name", role: "field", fieldId: "core:notes" }]).ok).toBe(false);
});
