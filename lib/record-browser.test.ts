// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordBrowser from "../components/record-browser";
const fetchMock = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const response = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(RecordBrowser, {
        workspaceId: "ws one",
        tenantId: "00000000-0000-4000-8000-000000000002",
      }),
    ),
  );
  return {
    host,
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("lists bounded records, opens detail and exposes only accessible linked documents", async () => {
  fetchMock.mockImplementation((url: string) =>
    url.includes("/records/")
      ? response({
          id: "record-a",
          name: "Acme",
          collection: "organisations",
          state: "active",
          version: 1,
          schemaVersion: 1,
          capabilities: ["view", "edit"],
          values: {},
          documents: [{ id: "link", pageId: "page-a", title: "Accessible brief" }],
          related: [],
        })
      : response({
          schemaVersion: 1,
          results: [
            {
              id: "record-a",
              name: "Acme",
              collection: "organisations",
              state: "active",
              version: 1,
              values: {},
            },
          ],
          nextCursor: null,
        }),
  );
  const view = await mount();
  try {
    expect(fetchMock.mock.calls[0][0]).toContain("collection=organisations");
    expect(view.host.textContent).toContain("Acme");
    await act(async () => view.host.querySelector<HTMLButtonElement>("li button")!.click());
    expect(view.host.textContent).toContain("Immutable ID");
    expect(view.host.textContent).toContain("Accessible brief");
    expect(view.host.querySelector("a")?.getAttribute("href")).toBe("/pages/page-a");
    expect(view.host.querySelector('section[aria-label="Collection fields"]')).toBeNull();
  } finally {
    await view.dispose();
  }
});
it("preserves a creation draft when server validation fails", async () => {
  fetchMock
    .mockResolvedValueOnce(await response({ schemaVersion: 1, results: [], nextCursor: null }))
    .mockResolvedValueOnce(await response({ schemaVersion: 1, fields: [], collectionCapabilities: ["view", "create"], canManage: false }))
    .mockResolvedValueOnce(await response({ error: "Tenant administrator and schema permission are required." }, 403))
    .mockResolvedValueOnce(await response({ error: "Name is invalid." }, 422));
  const view = await mount();
  try {
    const field = view.host.querySelector<HTMLInputElement>('section[aria-label="Record editor"] input')!;
    await input(field, "  Draft name  ");
    await act(async () => view.host.querySelector<HTMLFormElement>('section[aria-label="Record editor"] form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(view.host.textContent).toContain("Name is invalid.");
    expect(field.value).toBe("  Draft name  ");
  } finally {
    await view.dispose();
  }
});
it("uses record version and schema version for edits without clearing a failed edit", async () => {
  fetchMock
    .mockResolvedValueOnce(
      await response({
        schemaVersion: 4,
        results: [
          {
            id: "record-a",
            name: "Acme",
            collection: "organisations",
            state: "active",
            version: 7,
            values: {},
          },
        ],
        nextCursor: null,
      }),
    )
    .mockResolvedValueOnce(await response({ schemaVersion: 4, fields: [], collectionCapabilities: ["view", "edit"], canManage: false }))
    .mockResolvedValueOnce(await response({ error: "Tenant administrator and schema permission are required." }, 403))
    .mockResolvedValueOnce(
      await response({
        id: "record-a",
        name: "Acme",
        collection: "organisations",
        state: "active",
        version: 7,
        schemaVersion: 4,
        capabilities: ["view", "edit"],
        values: {},
        documents: [],
        related: [],
      }),
    )
    .mockResolvedValueOnce(await response({ error: "The record changed." }, 409));
  const view = await mount();
  try {
    await act(async () => view.host.querySelector<HTMLButtonElement>("li button")!.click());
    const field = view.host.querySelector<HTMLInputElement>('section[aria-label="Record editor"] input')!;
    await input(field, "My pending edit");
    await act(async () => view.host.querySelector<HTMLFormElement>('section[aria-label="Record editor"] form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(JSON.parse(fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH")![1].body)).toMatchObject({
      expectedVersion: 7,
      schemaVersion: 4,
      name: "My pending edit",
    });
    expect(view.host.textContent).toContain("The record changed.");
    expect(field.value).toBe("My pending edit");
  } finally {
    await view.dispose();
  }
});
it("creates a native contact-account association with role, primary and status metadata", async () => {
  const contact = {
    id: "00000000-0000-4000-8000-000000000010",
    name: "Alex",
    collection: "contacts",
    state: "active",
    version: 2,
    schemaVersion: 1,
    capabilities: ["view", "edit", "link"],
    values: {},
    parentOrganisation: null,
    documents: [],
    related: [],
  };
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/relationships"))
      return response({
        record: {
          ...contact,
          version: 3,
          related: [
            {
              id: "edge",
              kind: "contact-account",
              role: "Buyer",
              primary: true,
              status: "active",
              target: {
                id: "00000000-0000-4000-8000-000000000020",
                name: "Account",
                collection: "accounts",
              },
            },
          ],
        },
      });
    if (url.includes("/records/")) return response(contact);
    if (url.includes("collection=contacts"))
      return response({
        schemaVersion: 1,
        results: [contact],
        nextCursor: null,
      });
    return response({ schemaVersion: 1, results: [], nextCursor: null });
  });
  const view = await mount();
  try {
    await select(view.host.querySelector<HTMLSelectElement>('section[aria-label="Record list"] select')!, "contacts");
    await act(async () => view.host.querySelector<HTMLButtonElement>("li button")!.click());
    const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Add relationship"]')!,
      fields = form.querySelectorAll<HTMLInputElement>("input");
    await input(fields[0], "00000000-0000-4000-8000-000000000020");
    await input(fields[1], "Buyer");
    await act(async () => fields[2].click());
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const sent = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(sent).toMatchObject({
      kind: "contact-account",
      targetId: "00000000-0000-4000-8000-000000000020",
      action: "upsert",
      role: "Buyer",
      primary: true,
      status: "active",
      expectedVersion: 2,
    });
    expect(view.host.textContent).toContain("Relationship saved.");
  } finally {
    await view.dispose();
  }
});
it("requires an impact preview before confirming an account reparent", async () => {
  const account = {
      id: "00000000-0000-4000-8000-000000000030",
      name: "Account",
      collection: "accounts",
      state: "active",
      version: 5,
      schemaVersion: 1,
      capabilities: ["view", "edit", "link"],
      values: {},
      parentOrganisation: {
        id: "00000000-0000-4000-8000-000000000031",
        name: "Old org",
      },
      documents: [],
      related: [],
    },
    preview = {
      previewToken: "a".repeat(64),
      expectedVersion: 5,
      newOrganisationId: "00000000-0000-4000-8000-000000000032",
      newOrganisation: {
        id: "00000000-0000-4000-8000-000000000032",
        name: "New org",
      },
      affectedContracts: [{ id: "contract", name: "Agreement" }],
      contextReferences: [{ source_app: "sho", source_type: "project", source_id: "42" }],
      legalPartiesWillChange: false,
    };
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/reparent")) {
      const body = JSON.parse(init.body as string);
      return body.action === "preview"
        ? response(preview)
        : response({
            record: {
              ...account,
              version: 6,
              parentOrganisation: preview.newOrganisation,
            },
            affectedContracts: preview.affectedContracts,
            legalPartiesChanged: false,
          });
    }
    if (url.includes("/records/")) return response(account);
    if (url.includes("collection=accounts"))
      return response({
        schemaVersion: 1,
        results: [account],
        nextCursor: null,
      });
    return response({ schemaVersion: 1, results: [], nextCursor: null });
  });
  const view = await mount();
  try {
    await select(view.host.querySelector<HTMLSelectElement>('section[aria-label="Record list"] select')!, "accounts");
    await act(async () => view.host.querySelector<HTMLButtonElement>("li button")!.click());
    const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Move account"]')!,
      field = form.querySelector<HTMLInputElement>("input")!;
    await input(field, preview.newOrganisationId);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(view.host.textContent).toContain("1 contract context(s) and 1 external context reference(s) are affected.");
    await act(async () => view.host.querySelector<HTMLButtonElement>('section[aria-label="Move impact"] button')!.click());
    const applied = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(applied).toMatchObject({
      action: "apply",
      expectedVersion: 5,
      newOrganisationId: preview.newOrganisationId,
      previewToken: preview.previewToken,
      confirmed: true,
    });
    expect(view.host.textContent).toContain("Contract legal parties were not changed.");
  } finally {
    await view.dispose();
  }
});
it("renders permitted sensitive fields, omits hidden values, and submits only the edited field", async () => {
  const record = {
    id: "record-a",
    name: "Alex",
    collection: "contacts",
    state: "active",
    version: 3,
    schemaVersion: 2,
    capabilities: ["view", "edit", "history"],
    values: { "core:job-title": "Analyst", "core:email": "allowed@example.org" },
    documents: [],
    related: [],
    parentOrganisation: null,
  };
  const fields = [
    { key: "core:job-title", label: "Job title", kind: "text", sensitive: false, choices: [], canWrite: true, canHistory: true },
    { key: "core:email", label: "Email", kind: "email", sensitive: true, choices: [], canWrite: true, canHistory: true },
  ];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/history")) return response({ events: [{ id: "event-1", version: 2, kind: "update", before: null, after: { name: "Alex", values: { "core:job-title": "Analyst", "core:email": "allowed@example.org" } } }] });
    if (url.includes("/record-permissions")) return response({ schemaVersion: 2, fields, collectionCapabilities: ["view", "edit", "create", "history"], canManage: false });
    if (init?.method === "PATCH") return response({ record: { ...record, version: 4 } });
    if (url.includes("/records/")) return response(record);
    if (url.includes("collection=contacts")) return response({ schemaVersion: 2, results: [record], nextCursor: null });
    return response({ schemaVersion: 2, results: [], nextCursor: null });
  });
  const view = await mount();
  try {
    await select(view.host.querySelector("select")!, "contacts");
    await act(async () => view.host.querySelector<HTMLButtonElement>("li button")!.click());
    expect(view.host.textContent).toContain("allowed@example.org");
    expect(view.host.textContent).not.toContain("hidden-secret@example.org");
    const email = view.host.querySelector<HTMLInputElement>('input[type="email"]')!;
    await input(email, "updated@example.org");
    await act(async () => view.host.querySelector('section[aria-label="Record editor"] form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(JSON.parse(fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH")![1].body).values).toEqual({ "core:email": "updated@example.org" });
    expect(view.host.textContent).toContain("Analyst");
    expect(view.host.textContent).not.toContain("hidden-secret@example.org");
  } finally {
    await view.dispose();
  }
});
it("saves record and sensitive-field flags for another member without a hidden value", async () => {
  const record = {
    id: "record-a",
    name: "Alex",
    collection: "contacts",
    state: "active",
    version: 3,
    schemaVersion: 2,
    capabilities: ["view", "edit"],
    values: { "core:job-title": "Analyst" },
    documents: [],
    related: [],
    parentOrganisation: null,
  };
  const matrix = {
    sensitiveFields: [{ key: "core:email", label: "Email", kind: "email" }],
    members: [{ id: "record-viewer", name: "Viewer", collection: { capabilities: ["view"], version: 1 }, record: { capabilities: [], version: 0 }, fields: [{ key: "core:email", canView: false, canWrite: false, canHistory: false, version: 0 }] }],
  };
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("manage=1")) return response(matrix);
    if (init?.method === "POST" && url.includes("/record-permissions")) return response({ recordVersion: 1, fieldVersions: { "core:email": 1 }, replayed: false });
    if (url.includes("/record-permissions")) return response({ schemaVersion: 2, fields: [{ key: "core:job-title", label: "Job title", kind: "text", sensitive: false, choices: [], canWrite: true, canHistory: true }], collectionCapabilities: ["view", "manage-permissions"], canManage: true });
    if (url.includes("/records/")) return response(record);
    if (url.includes("collection=contacts")) return response({ schemaVersion: 2, results: [record], nextCursor: null });
    return response({ schemaVersion: 2, results: [], nextCursor: null });
  });
  const view = await mount();
  try {
    await select(view.host.querySelector("select")!, "contacts");
    await act(async () => view.host.querySelector<HTMLButtonElement>("li button")!.click());
    await act(async () => view.host.querySelector<HTMLButtonElement>('section[aria-label="Record permissions"] button')!.click());
    const email = view.host.querySelector('fieldset legend')!.parentElement!.querySelector("fieldset") ?? view.host.querySelectorAll("fieldset")[1];
    await act(async () => email.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => view.host.querySelector<HTMLFormElement>('form[aria-label="Edit member access"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const body = JSON.parse(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")![1].body);
    expect(body).toMatchObject({ subjectId: "record-viewer", recordGrant: { recordId: "record-a", expectedVersion: 0 }, fields: [{ key: "core:email", canView: true, canWrite: false, canHistory: false, expectedVersion: 0 }] });
    expect(JSON.stringify(body)).not.toContain("hidden-secret@example.org");
    expect(view.host.textContent).not.toContain("hidden-secret@example.org");
  } finally {
    await view.dispose();
  }
});
it("reviews and applies a custom field without reading record values or editing built-in fields", async () => {
  const fieldKey = "00000000-0000-4000-8000-0000000000aa";
  const catalogue = {
    schemaVersion: 4,
    canManage: true,
    customFieldCount: 1,
    limits: { maxFields: 100, maxChoices: 100 },
    fields: [
      { key: "core:domain", label: "Domain", kind: "url", required: false, choices: [], sensitive: false, unique: false, deprecated: false, core: true, version: 1 },
      { key: fieldKey, label: "Badge", kind: "text", required: false, choices: [], sensitive: true, unique: false, deprecated: true, core: false, version: 2 },
    ],
  };
  const preview = {
    previewId: "00000000-0000-4000-8000-0000000000bb",
    fieldKey: "00000000-0000-4000-8000-0000000000cc",
    reviewHash: "ab".repeat(32),
    expiresAt: "2026-10-30T22:00:00.000Z",
    impact: {
      recordCount: 3,
      populatedCount: 1,
      missingCount: 2,
      duplicateValues: 0,
      dependencies: [],
      blockers: [] as string[],
      changes: ["label"],
      defaultBehavior: "Defaults apply to future creates only. Existing records are not rewritten.",
    },
  };
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.includes("/record-schema")) {
      const body = JSON.parse(String(init.body));
      if (body.definition?.deprecated) return response({ ...preview, impact: { ...preview.impact, blockers: ["Resolve the listed views, import mappings or integrations before this change."] } });
      return response(preview);
    }
    if (url.includes("/record-schema")) return response(catalogue);
    if (url.includes("/record-permissions")) return response({ schemaVersion: 4, fields: [], collectionCapabilities: ["schema"], canManage: false });
    return response({ schemaVersion: 4, results: [], nextCursor: null });
  });
  const view = await mount();
  try {
    expect(view.host.textContent).toContain("Domain · built-in · not editable");
    expect(view.host.textContent).toContain("does not grant field-value read");
    const fields = view.host.querySelector('section[aria-label="Collection fields"]')!;
    await act(async () => fields.querySelectorAll("button")[0].click());
    const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Custom field"]')!;
    const boxes = form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes[2].checked).toBe(true);
    expect(boxes[2].disabled).toBe(true);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(view.host.querySelector('section[aria-label="Schema review"] button')).toBeNull();
    expect(view.host.textContent).toContain("Resolve the listed views");
    const reviewed = JSON.parse(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")![1].body);
    expect(reviewed).toMatchObject({ kind: "preview", collection: "organisations", fieldKey, expectedSchemaVersion: 4, definition: { label: "Badge", kind: "text", sensitive: true, deprecated: true, choices: [] } });
    expect(JSON.stringify(reviewed)).not.toContain("hidden-record-value@example.org");
    await act(async () => form.querySelector("button")!.click());
    await input(form.querySelector("input")!, "Department");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(view.host.textContent).toContain("Defaults apply to future creates only");
    expect(view.host.textContent).toContain("3 records, 1 populated, 2 missing, 0 duplicate values.");
    await act(async () => view.host.querySelector<HTMLButtonElement>('section[aria-label="Schema review"] button')!.click());
    const posts = fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(String(call[1].body)));
    expect(posts.at(-2)).toMatchObject({ kind: "preview", collection: "organisations", expectedSchemaVersion: 4, definition: { label: "Department", kind: "text", required: false, sensitive: false, unique: false, deprecated: false, choices: [] } });
    expect(posts.at(-2).fieldKey).toBeUndefined();
    expect(posts.at(-1)).toMatchObject({ kind: "apply", previewId: preview.previewId, reviewHash: preview.reviewHash });
    expect(JSON.stringify(posts)).not.toContain("hidden-record-value@example.org");
    expect(view.host.textContent).toContain("Custom field saved.");
  } finally {
    await view.dispose();
  }
});
