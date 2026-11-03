import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertGuestText,
  compileGuestPortal,
  evaluateGuestAccess,
  guestFileCitation,
  type AccessClaim,
  type AccessFacts,
} from "./guest-portal-plan";

const recordId = "00000000-0000-4000-8000-00000000f101";
const secretField = "00000000-0000-4000-8000-00000000f201";
const baseFacts: AccessFacts = { status: "preview", suiteSubject: null, identityLinked: false, grant: "missing", expiredByPolicy: false, audienceDomain: "partner.example" };
const anonymous: AccessClaim = { authenticated: false, suiteSubject: null, urlToken: null, domain: null, accountAssigned: false };

function definition() {
  return {
    screens: [{ id: "clinic", name: "Clinic", fields: ["core:notes", secretField], actions: ["view", "form", "comment", "file", "export", "history"] }],
    scope: { collection: "organisations", recordIds: [recordId] },
    fields: [{ key: "core:notes", mode: "edit" as const }, { key: secretField, mode: "view" as const }],
    actions: ["view", "form", "comment", "file", "export", "history"],
    expiry: { hours: 24 },
    edge: { cache: "no-store" as const, residency: "tenant" as const, public: false as const },
    guestPreview: true as const,
    domain: "partner.example",
  };
}

it("compiles explicit screens, scope, fields, actions, preview, and expiry", () => {
  const compiled = compileGuestPortal(definition());
  expect(compiled.screens.map(screen => screen.name)).toEqual(["Clinic"]);
  expect(compiled.scope).toEqual({ collection: "organisations", recordIds: [recordId] });
  expect(compiled.fields.map(field => field.key)).toEqual(["core:notes", secretField]);
  expect(compiled.actions).toContain("form");
  expect(compiled.expiry).toEqual({ hours: 24 });
  expect(compiled.guestPreview).toBe(true);
  expect(compiled.edge).toEqual({ cache: "no-store", residency: "tenant", public: false });
  expect(() => compileGuestPortal({ ...definition(), edge: { cache: "public", residency: "tenant", public: true } })).toThrow(/no-store/i);
  expect(() => compileGuestPortal({ ...definition(), sharing: "on" })).toThrow(/check the portal/i);
});

it("never treats a URL, domain, or account assignment as guest access", () => {
  expect(evaluateGuestAccess({ ...anonymous, urlToken: recordId }, baseFacts)).toMatchObject({ allowed: false, reason: "url" });
  expect(evaluateGuestAccess({ ...anonymous, domain: "partner.example" }, baseFacts)).toMatchObject({ allowed: false, reason: "domain" });
  expect(evaluateGuestAccess({ ...anonymous, accountAssigned: true }, baseFacts)).toMatchObject({ allowed: false, reason: "assignment" });
  expect(evaluateGuestAccess({ ...anonymous, authenticated: true, suiteSubject: "assigned-user", accountAssigned: true }, baseFacts)).toMatchObject({ allowed: false, reason: "assignment" });
  const linked: AccessFacts = { ...baseFacts, suiteSubject: "portal-guest", identityLinked: true };
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "portal-guest", urlToken: null, domain: "partner.example", accountAssigned: true }, linked)).toMatchObject({ allowed: false, reason: "grant" });
  const granted: AccessFacts = { ...linked, grant: "current" };
  expect(evaluateGuestAccess({ authenticated: false, suiteSubject: null, urlToken: recordId, domain: "partner.example", accountAssigned: true }, granted)).toMatchObject({ allowed: false, reason: "authentication" });
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "other-user", urlToken: recordId, domain: "partner.example", accountAssigned: true }, granted)).toMatchObject({ allowed: false, reason: "authentication" });
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "portal-guest", urlToken: recordId, domain: "partner.example", accountAssigned: true }, granted)).toEqual({ allowed: true, reason: "grant-and-authentication" });
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "portal-guest", urlToken: null, domain: null, accountAssigned: false }, { ...granted, grant: "expired" })).toMatchObject({ allowed: false, reason: "expiry" });
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "portal-guest", urlToken: null, domain: null, accountAssigned: false }, { ...granted, expiredByPolicy: true })).toMatchObject({ allowed: false, reason: "expiry" });
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "portal-guest", urlToken: null, domain: null, accountAssigned: false }, { ...granted, status: "paused" })).toMatchObject({ allowed: false, reason: "paused" });
  expect(evaluateGuestAccess({ authenticated: true, suiteSubject: "portal-guest", urlToken: null, domain: null, accountAssigned: false }, { ...granted, status: "revoked" })).toMatchObject({ allowed: false, reason: "revoked" });
});

it("rejects unsafe guest links and remote file fetches", () => {
  expect(assertGuestText("Hours are listed at https://partner.example/hours")).toContain("https://partner.example/hours");
  expect(() => assertGuestText("javascript:alert(1)")).toThrow(/link is not allowed/i);
  expect(() => assertGuestText("See https://user:secret@partner.example/hours")).toThrow(/link is not allowed/i);
  expect(guestFileCitation("Partner brief.pdf")).toEqual({ name: "Partner brief.pdf", fetched: false });
  expect(() => guestFileCitation("https://partner.example/file.pdf")).toThrow(/link is not allowed/i);
  const sql = readFileSync("db/132_guest_portals.sql", "utf8").replace(/--.*$/gm, "");
  expect(sql).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(sql).not.toMatch(/parent_organisation_id/);
  expect(sql).not.toMatch(/release\.py/);
});
