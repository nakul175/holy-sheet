import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  assertConsentAdvance,
  commitTarget,
  compileIntakeForm,
  decideAbuse,
  decideAnonymous,
  decideFence,
  genericReceipt,
  intakeReceiptText,
  scanIntakeAttachment,
} from "./intake-form-plan";

const email = "00000000-0000-4000-8000-00000000e201";

function definition(extra: Record<string, unknown> = {}) {
  return {
    collection: "organisations",
    fields: [
      { key: "core:notes", type: "text", required: false, maxLength: 200 },
      { key: email, type: "email", required: true, maxLength: 120 },
    ],
    validation: { required: [email] },
    queue: { name: "clinic-intake", private: true },
    audience: "public",
    anonymous: false,
    expiry: { hours: 24 },
    consent: { text: "Synthetic notice.", version: 1 },
    limits: { bytes: 1000, types: ["pdf", "txt"] },
    edge: { cache: "no-store", residency: "tenant", public: false },
    bot: { required: true },
    ...extra,
  };
}

it("compiles schema-bound fields, validation, a private queue, and an explicit audience", () => {
  const compiled = compileIntakeForm(definition());
  expect(compiled.fields.map(field => field.key)).toEqual(["core:notes", email]);
  expect(compiled.validation.required).toEqual([email]);
  expect(compiled.queue).toEqual({ name: "clinic-intake", private: true });
  expect(compiled.audience).toBe("public");
  expect(compiled.anonymous).toBe(false);
  expect(compiled.bot).toEqual({ required: true });
  expect(compiled.edge.public).toBe(false);
  expect(() => compileIntakeForm(definition({ edge: { cache: "public", residency: "tenant", public: true } }))).toThrow(/no-store/i);
  expect(() => compileIntakeForm(definition({ queue: { name: "clinic-intake", private: false } }))).toThrow(/check the form/i);
  expect(() => compileIntakeForm(definition({ audience: "workspace" }))).toThrow(/check the form/i);
  expect(() => compileIntakeForm(definition({ validation: { required: [] } }))).toThrow(/check the form/i);
  expect(() => compileIntakeForm({ ...definition(), sharing: "on" })).toThrow(/check the form/i);
  expect(() => assertConsentAdvance({ text: "Synthetic notice.", version: 1 }, { text: "Changed notice.", version: 1 })).toThrow(/check the form/i);
});

it("allows anonymous intake only by explicit form opt-in and admin policy", () => {
  expect(decideAnonymous({ requested: false, formAllows: false, policyAllows: false })).toEqual({ accepted: true, anonymous: false });
  expect(decideAnonymous({ requested: true, formAllows: true, policyAllows: false })).toMatchObject({ accepted: false, reason: "policy" });
  expect(decideAnonymous({ requested: true, formAllows: false, policyAllows: true })).toMatchObject({ accepted: false, reason: "policy" });
  expect(decideAnonymous({ requested: true, formAllows: true, policyAllows: true })).toEqual({ accepted: true, anonymous: true });
});

it("rejects oversized, mistyped, rushed, unproven, and reused intake", () => {
  expect(decideAbuse({ bytes: 20, limitBytes: 10, mediaType: null, allowedMedia: [], rateCount: 1, rateLimit: 5, bot: "valid", intent: "new" })).toMatchObject({ allowed: false, reason: "size" });
  expect(decideAbuse({ bytes: 10, limitBytes: 10, mediaType: "image/gif", allowedMedia: ["application/pdf"], rateCount: 1, rateLimit: 5, bot: "valid", intent: "new" })).toMatchObject({ allowed: false, reason: "type" });
  expect(decideAbuse({ bytes: 10, limitBytes: 10, mediaType: null, allowedMedia: [], rateCount: 6, rateLimit: 5, bot: "valid", intent: "new" })).toMatchObject({ allowed: false, reason: "rate" });
  expect(decideAbuse({ bytes: 10, limitBytes: 10, mediaType: null, allowedMedia: [], rateCount: 1, rateLimit: 5, bot: "missing", intent: "new" })).toMatchObject({ allowed: false, reason: "bot" });
  expect(decideAbuse({ bytes: 10, limitBytes: 10, mediaType: null, allowedMedia: [], rateCount: 1, rateLimit: 5, bot: "reused", intent: "new" })).toMatchObject({ allowed: false, reason: "bot" });
  expect(decideAbuse({ bytes: 10, limitBytes: 10, mediaType: null, allowedMedia: [], rateCount: 1, rateLimit: 5, bot: "valid", intent: "mismatch" })).toMatchObject({ allowed: false, reason: "intent" });
  expect(decideAbuse({ bytes: 10, limitBytes: 10, mediaType: null, allowedMedia: [], rateCount: 5, rateLimit: 5, bot: "valid", intent: "replay" })).toEqual({ allowed: true, reason: "replay" });
  const clean = scanIntakeAttachment({ name: "brief.pdf", mediaType: "application/pdf", byteSize: 100 }, { bytes: 1000, types: ["pdf"] });
  expect(clean).toMatchObject({ quarantined: true, fetched: false, scan: "clean" });
  expect(scanIntakeAttachment({ name: "eicar.txt", mediaType: "text/plain", byteSize: 68 }, { bytes: 1000, types: ["txt"] }).scan).toBe("rejected");
  expect(scanIntakeAttachment({ name: "photo.gif", mediaType: "image/gif", byteSize: 20 }, { bytes: 1000, types: ["pdf", "txt"] }).scan).toBe("rejected");
  expect(genericReceipt("rc_example").receipt).toBe(intakeReceiptText);
  expect(genericReceipt("rc_example")).not.toHaveProperty("values");
});

it("fences stale intake and refuses to update a record chosen by name", () => {
  expect(decideFence({ status: "disabled", expired: false, formVersion: 2, submissionVersion: 2, state: "quarantine" })).toEqual({ fenced: true });
  expect(decideFence({ status: "draft", expired: true, formVersion: 1, submissionVersion: 1, state: "reviewed" })).toEqual({ fenced: true });
  expect(decideFence({ status: "draft", expired: false, formVersion: 3, submissionVersion: 2, state: "quarantine" })).toEqual({ fenced: true });
  expect(decideFence({ status: "draft", expired: false, formVersion: 2, submissionVersion: 2, state: "committed" })).toEqual({ fenced: false });
  const named = "00000000-0000-4000-8000-00000000f101";
  const explicit = "00000000-0000-4000-8000-00000000f102";
  expect(commitTarget(null, named)).toEqual({ mode: "insert", namedRecordIdIgnored: named });
  expect(commitTarget(explicit, named)).toEqual({ mode: "update", recordId: explicit, namedRecordIdIgnored: named });
  const sql = readFileSync("db/133_external_intake.sql", "utf8").replace(/--.*$/gm, "");
  expect(sql).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(sql).not.toMatch(/parent_organisation_id/);
  expect(sql).not.toMatch(/release\.py/);
  expect(sql).toMatch(/activated = false/);
  expect(sql).toMatch(/sharing = 'off'/);
});
