// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDocumentSession } from '../components/editor/use-document-session';
import { schemaVersion } from './document';
import type { DocumentPage } from './repository';

const mocks = vi.hoisted(() => ({ receive: undefined as undefined | ((value: unknown) => void), unavailable: undefined as undefined | (() => void) }));
vi.mock('./access-monitor', () => ({ monitorAccess: (_check: unknown, receive: typeof mocks.receive, unavailable: typeof mocks.unavailable) => { mocks.receive = receive; mocks.unavailable = unavailable; return () => {}; } }));
vi.mock('./recovery-client', () => ({ importDraftKey: async () => ({}), recoveryDrafts: async () => [], storeDraft: vi.fn(async () => {}), discardDraft: vi.fn(async () => {}), decryptDraft: vi.fn() }));
const page: DocumentPage = { id: 'schema-page', title: 'Future document', role: 'owner', version: 4, schemaVersion: schemaVersion + 1, workspaceId: 'qa', workspaceName: 'QA', spaceId: 'qa', spaceName: 'QA', parentPageId: null, visibility: 'private', updatedAt: '2026-10-27T00:00:00Z', blocks: [], document: { type: 'doc', content: [{ type: 'futureWidget', attrs: { id: 'future', futureOption: 'preserve me' }, content: [{ type: 'text', text: 'Future widget text' }] }] } };
let root: Root, host: HTMLElement, session: ReturnType<typeof useDocumentSession>, remote: DocumentPage, fetcher: ReturnType<typeof vi.fn>;
function Probe() { session = useDocumentSession('schema-page'); return null; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  remote = structuredClone(page);
  fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/document') ? { page: remote, actorId: 'qa-owner' } : { id: 'draft', key: 'key', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  vi.stubGlobal('fetch', fetcher);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('opens a future schema read-only without allocating recovery keys or changing its unknown content', async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(session.status).toBe('readonly');
  expect(session.page?.document).toEqual(page.document);
  expect(fetcher.mock.calls.every(([url]) => url.endsWith('/document'))).toBe(true);
  await act(async () => { session.change({ title: 'Must not overwrite', document: { type: 'doc', content: [] } }); await session.save(); });
  expect(session.page).toEqual(page); expect(session.dirty()).toBe(false);
});

it('keeps an older schema read-only rather than attempting implicit conversion', async () => {
  remote = { ...page, schemaVersion: schemaVersion - 1 };
  await act(async () => root.render(createElement(Probe)));
  expect(session.status).toBe('readonly');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('cannot reactivate an unsupported writer after an access-check outage', async () => {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => mocks.unavailable!());
  await act(async () => mocks.receive!({ actorId: 'qa-owner', role: 'owner' }));
  expect(session.status).toBe('readonly');
  await act(async () => session.change({ title: 'Still forbidden' }));
  expect(session.page?.title).toBe(page.title);
});

it('does not combine a local supported draft with a newly fetched future schema', async () => {
  remote = { ...page, schemaVersion, document: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p' }, content: [{ type: 'text', text: 'Supported content' }] }] } };
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { session.change({ title: 'Local supported draft' }); session.acceptExternal(page); });
  const before = structuredClone(session.page);
  await act(async () => session.keepBoth());
  expect(session.page).toEqual(before); expect(session.latest).toEqual(page); expect(session.status).toBe('conflict');
});

it('explicitly loading the latest future schema switches to read-only without resubmitting local content', async () => {
  remote = { ...page, schemaVersion, document: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p' } }] } };
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { session.change({ title: 'Local draft' }); session.acceptExternal(page); });
  remote = page;
  await act(async () => session.keepLatest());
  expect(session.page).toEqual(page); expect(session.status).toBe('readonly'); expect(session.dirty()).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/operations'))).toBe(false);
});

it('enters read-only mode when a clean external refresh advances the document schema', async () => {
  remote = { ...page, schemaVersion };
  await act(async () => root.render(createElement(Probe)));
  await act(async () => session.acceptExternal(page));
  expect(session.page).toEqual(page); expect(session.status).toBe('readonly');
  await act(async () => { session.change({ title: 'Forbidden after refresh' }); await session.save(); });
  expect(session.page?.title).toBe(page.title); expect(session.dirty()).toBe(false);
});

it('retains the conflict if an old save acknowledgement arrives after a future-schema refresh', async () => {
  remote = { ...page, schemaVersion, document: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p' } }] } };
  await act(async () => root.render(createElement(Probe)));
  let finish!: (response: Response) => void, operationId = '';
  fetcher.mockImplementationOnce((_url: string, init: RequestInit) => { operationId = JSON.parse(String(init.body)).operationId; return new Promise<Response>(resolve => { finish = resolve; }); });
  let saving!: Promise<void>;
  await act(async () => { session.change({ title: 'Local in-flight save' }); saving = session.save(); });
  expect(operationId).toMatch(/^[a-f0-9-]{36}$/); expect(session.status).toBe('saving');
  await act(async () => session.acceptExternal(page));
  await act(async () => { finish(Response.json({ page: { ...remote, title: 'Local in-flight save' }, acknowledgedOperationId: operationId })); await saving; });
  expect(session.status,session.error).toBe('conflict'); expect(session.latest).toEqual(page);
  expect(session.dirty()).toBe(true); expect(session.page?.title).toBe('Local in-flight save');
});
