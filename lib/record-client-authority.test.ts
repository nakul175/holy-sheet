import { expect, it } from "vitest";
import type { RecordApiContext } from "./shared-record-api";
import { publishRecordClientResult, unavailableRecordClientAuthority } from "./record-client-authority";

const ctx = {
  actor: { id: "verified-user" },
  workspaceId: "workspace-a",
  tenantId: "00000000-0000-4000-8000-000000000002",
  credential: { authorization: "Bearer synthetic-secret", clientId: "holy-sheet", tenantId: "browser-tenant", role: "admin" },
} as RecordApiContext;

it("denies every delegation without reading token claims or browser authority", async () => {
  const authority = unavailableRecordClientAuthority();
  await expect(authority.verify(ctx)).rejects.toMatchObject({ code: "record_client_denied", status: 403 });
  await expect(authority.verify(ctx)).rejects.toThrow("Current application delegation is unavailable.");
  try {
    await authority.verify(ctx);
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${"code" in error ? String(error.code) : ""}` : "";
    expect(message).not.toContain("synthetic-secret");
    expect(message).not.toContain("holy-sheet");
    expect(message).not.toContain("browser-tenant");
  }
});

it("publishes only an online private version-one result", () => {
  const result = { apiVersion: 1 as const, data: { results: [] }, authority: { verifiedAt: "2026-10-31T00:00:00.000Z", validUntil: "2026-10-31T00:05:00.000Z" }, cacheControl: "private, no-store" as const, offline: false as const };
  expect(publishRecordClientResult(result)).toEqual(result);
  expect(() => publishRecordClientResult({ ...result, cacheControl: "public" })).toThrow(/temporarily unavailable/);
  expect(() => publishRecordClientResult({ ...result, offline: true })).toThrow(/temporarily unavailable/);
  expect(() => publishRecordClientResult({ ...result, credential: "Bearer synthetic-secret" })).toThrow(/temporarily unavailable/);
  expect(() => publishRecordClientResult({ ...result, authority: { ...result.authority, token: "synthetic-secret" } })).toThrow(/temporarily unavailable/);
  expect(() => publishRecordClientResult({ ...result, apiVersion: 2 })).toThrow(/temporarily unavailable/);
});
