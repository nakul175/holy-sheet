import { expect, it } from "vitest";
import { acceptedImport, buildImportMapping, importCommitBody, type ImportFieldDraft } from "./record-import-contract";

const notes = { key: "core:notes", label: "Notes", kind: "long-text" };
const amount = { key: "core:amount", label: "Amount", kind: "currency" };
const empty = (column = ""): ImportFieldDraft => ({ column, lookup: "id", currencyCode: "", currencyScale: "" });
const base = {
  canCreate: true,
  headerCount: 3,
  nameColumn: "0",
  idColumn: "",
  parentOrganisationColumn: "",
  legalOrganisationColumn: "",
  accountColumn: "",
  fields: [notes],
  drafts: { "core:notes": empty() },
};

it("maps a create by position and omits update identity and relationship columns", () => {
  const mapped = buildImportMapping({ ...base, mode: "create", collection: "organisations", drafts: { "core:notes": empty("1") } });
  expect(mapped).toEqual({ ok: true, mapping: { mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] } });
  expect(JSON.stringify(mapped)).not.toContain("idColumn");
  expect(JSON.stringify(mapped)).not.toContain("parentOrganisation");
});

it("maps an update by immutable id and ignores a relationship column", () => {
  const mapped = buildImportMapping({ ...base, mode: "update", collection: "accounts", nameColumn: "", idColumn: "0", parentOrganisationColumn: "2", drafts: { "core:notes": empty("1") } });
  expect(mapped).toEqual({ ok: true, mapping: { mode: "update", idColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] } });
});

it("requires the relationship columns the service requires for create", () => {
  expect(buildImportMapping({ ...base, mode: "create", collection: "accounts" })).toMatchObject({ ok: false });
  const account = buildImportMapping({ ...base, mode: "create", collection: "accounts", parentOrganisationColumn: "2" });
  expect(account).toMatchObject({ ok: true, mapping: { parentOrganisationColumn: 2 } });
  expect(buildImportMapping({ ...base, mode: "create", collection: "contracts", legalOrganisationColumn: "" })).toMatchObject({ ok: false });
  const contract = buildImportMapping({ ...base, mode: "create", collection: "contracts", legalOrganisationColumn: "1", accountColumn: "2" });
  expect(contract).toMatchObject({ ok: true, mapping: { legalOrganisationColumn: 1, accountColumn: 2 } });
});

it("keeps currency and reference identity explicit and refuses an unknown column", () => {
  const currency = buildImportMapping({
    ...base,
    mode: "update",
    collection: "contracts",
    nameColumn: "",
    idColumn: "0",
    fields: [{ ...amount, referenceList: true }],
    drafts: { "core:amount": { column: "1", lookup: "code", currencyCode: "USD", currencyScale: "2" } },
  });
  expect(currency).toEqual({ ok: true, mapping: { mode: "update", idColumn: 0, fields: [{ column: 1, fieldKey: "core:amount", currency: { code: "USD", scale: 2 }, referenceLookup: "code" }] } });
  expect(buildImportMapping({ ...base, mode: "create", collection: "organisations", fields: [amount], drafts: { "core:amount": { ...empty("1"), currencyCode: "$", currencyScale: "2" } } })).toMatchObject({ ok: false });
  expect(buildImportMapping({ ...base, mode: "create", collection: "organisations", nameColumn: "9" })).toMatchObject({ ok: false });
  expect(buildImportMapping({ ...base, mode: "create", collection: "organisations", canCreate: false })).toMatchObject({ ok: false });
});

it("accepts a preview without hidden field keys, values or unsafe issue text", () => {
  const secret = "secret-cell";
  const hidden = "hidden-field";
  const viewed = acceptedImport({
    id: "00000000-0000-4000-8000-0000000000c1",
    collection: "organisations",
    name: "people.csv",
    format: "csv",
    headers: ["Name", "Notes"],
    state: "reviewed",
    mode: "create",
    rowCount: 1,
    version: 3,
    reviewOffset: 1,
    reviewHash: "ab".repeat(32),
    warnings: ["Cached formula value"],
    expiresAt: "2026-11-01T00:00:00.000Z",
    counts: { unreviewed: 0, valid: 0, invalid: 1, applied: 0, blocked: 0 },
    rows: [{ ordinal: 0, sourceRow: 2, state: "invalid", duplicateWarning: true, errors: [{ code: "field_value_invalid", fieldKey: "core:notes" }, { code: "field_value_invalid", fieldKey: hidden }, { code: `=${secret}` }], name: "Ada", values: { "core:notes": secret, [hidden]: secret } }],
    nextOffset: null,
  }, ["core:notes"]);
  expect(viewed?.rows?.[0].errors).toEqual([{ code: "field_value_invalid", fieldKey: "core:notes" }, { code: "field_value_invalid" }, { code: "validation_error" }]);
  expect(viewed?.rows?.[0].values).toEqual({ "core:notes": secret });
  expect(JSON.stringify(viewed?.rows?.[0].errors)).not.toContain(hidden);
  expect(JSON.stringify(viewed?.rows?.[0].errors)).not.toContain(secret);
  expect(importCommitBody(viewed!, "00000000-0000-4000-8000-0000000000d1", { allowValidSubset: true, allowDuplicates: true, acknowledgeWarnings: true })).toMatchObject({ confirm: "create-records", id: "00000000-0000-4000-8000-0000000000d1" });
  expect(importCommitBody({ ...viewed!, reviewHash: null }, "00000000-0000-4000-8000-0000000000d1", { allowValidSubset: true, allowDuplicates: false, acknowledgeWarnings: false })).toBeNull();
});
