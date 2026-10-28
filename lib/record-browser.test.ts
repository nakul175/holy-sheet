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
  } finally {
    await view.dispose();
  }
});
it("preserves a creation draft when server validation fails", async () => {
  fetchMock.mockResolvedValueOnce(await response({ schemaVersion: 1, results: [], nextCursor: null })).mockResolvedValueOnce(await response({ error: "Name is invalid." }, 422));
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
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
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
