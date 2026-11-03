import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), receipt: vi.fn(),
  configure: vi.fn(), stash: vi.fn(), discard: vi.fn(), preview: vi.fn(), disable: vi.fn(), revoke: vi.fn(),
  activate: vi.fn(), policy: vi.fn(), actions: vi.fn(), grant: vi.fn(), ungrant: vi.fn(),
  challenge: vi.fn(), submit: vi.fn(), review: vi.fn(), commit: vi.fn(), download: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./intake-form", () => ({
  intakeFormCatalogue: mocks.catalogue,
  readIntakeForm: mocks.read,
  searchIntakeForms: mocks.search,
  intakeFormHistory: mocks.history,
  readIntakeReceipt: mocks.receipt,
  saveIntakeForm: mocks.configure,
  stashIntakeForm: mocks.stash,
  discardIntakeDraft: mocks.discard,
  previewIntakeForm: mocks.preview,
  disableIntakeForm: mocks.disable,
  revokeIntakeForm: mocks.revoke,
  activateIntakeForm: mocks.activate,
  setIntakeAnonymousPolicy: mocks.policy,
  setIntakeActions: mocks.actions,
  grantIntakeManager: mocks.grant,
  revokeIntakeManager: mocks.ungrant,
  issueIntakeChallenge: mocks.challenge,
  submitIntake: mocks.submit,
  reviewIntake: mocks.review,
  commitIntake: mocks.commit,
  downloadIntakeReport: mocks.download,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/intake-forms/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const formId = "00000000-0000-4000-8000-0000000000d1";
const operationId = "00000000-0000-4000-8000-0000000000d2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, forms: [], accessGranted: false, sharing: "off", activated: false });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.receipt.mockResolvedValue({ receipt: "Received. This receipt does not confirm a record was created.", recordCreated: false });
  mocks.read.mockResolvedValue({ id: formId, sharing: "off", activated: false });
  mocks.preview.mockResolvedValue({ id: formId, sharing: "off", accessGranted: false, activated: false, cache: "no-store" });
  mocks.activate.mockResolvedValue({ activated: false, sharing: "off", accessGranted: false });
  mocks.submit.mockResolvedValue({ recordCreated: false, quarantined: true });
});
afterEach(() => vi.unstubAllEnvs());

it("keeps intake reads uncached and rejects a foreign origin before configuration", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/intake-forms`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = { action: "configure", operationId, expectedVersion: 0, name: "Clinic intake", definition: { fields: [] }, cookies: "session=abc", activated: true };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, formId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
  expect((await POST(request({ action: "activate", operationId, formId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.activate).toHaveBeenCalled();
});

it("uses the same not-found response for a missing form and a denied receipt", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/intake-forms?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/intake-forms?view=open&formId=${formId}`), params)).status).toBe(404);
  const { DocumentError } = await import("./document");
  mocks.receipt.mockRejectedValueOnce(new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/intake-forms?view=receipt&code=rc_secret_value`), params);
  expect(denied.status).toBe(404);
  const payload = await denied.json();
  expect(payload).toEqual({ error: "Intake forms are restricted or unavailable.", code: "not_found", retryable: false });
  expect(JSON.stringify(payload)).not.toContain("rc_secret_value");
  expect(denied.headers.get("cache-control")).toBe("no-store");
});
