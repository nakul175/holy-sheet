// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HolySheetApp from '../components/holy-sheet-app';
import { schemaVersion } from './document';
import { Blob as NodeBlob } from 'node:buffer';
import { documentPreviewText } from '../components/editor/schema-fallback';

const mocks = vi.hoisted(() => ({ rich: vi.fn(), future: true }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../components/editor/rich-editor', () => ({ default: (props: unknown) => { mocks.rich(props); return null; }, Dialog: () => null }));
vi.mock('../components/personal-navigation', () => ({ default: () => null }));
vi.mock('../components/discussion-panel', () => ({ default: () => null }));
vi.mock('../components/editor/pending-uploads', () => ({ default: () => null }));
vi.mock('../components/backlinks', () => ({ default: () => null }));
vi.mock('../components/templates-dialog', () => ({ default: () => null, TemplateSource: () => null }));
vi.mock('../components/session-boundary', () => ({ SignInLink: () => null, SignOutButton: () => null }));
vi.mock('../components/editor/use-document-session', () => ({
  requestJson: async () => ({ pages: [], spaces: [] }),
  useDocumentSession: () => ({ page: { id: 'future-page', title: 'Preserved title', schemaVersion: mocks.future ? 999 : 2, role: 'owner', version: 4, workspaceId: 'qa', workspaceName: 'QA', spaceName: 'QA', visibility: 'private', document: { type: 'doc', content: [{ type: 'futureWidget', attrs: { id: 'future-id', optionUnknownToOldEditor: 'retain exactly' }, content: [{ type: 'text', text: '<script>inert()</script> — future content' }] }] } }, status: 'readonly', candidates: [], actorId: 'qa-owner', checkpoint: vi.fn(), save: vi.fn(), change: vi.fn(), dirty: () => false }),
}));

let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.future = true; mocks.rich.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('never sends unfamiliar blocks through the old editor and renders their text inertly', async () => {
  await act(async () => root.render(createElement(HolySheetApp, { initialPageId: 'future-page' })));
  expect(mocks.rich).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Page title"]')?.readOnly).toBe(true);
  expect(host.querySelector('[aria-label="Read-only document preview"]')?.textContent).toContain('<script>inert()</script>');
  expect(host.querySelector('script')).toBeNull();
  expect([...host.querySelectorAll('button')].some(button => ['History', 'Save as template', 'Discussions'].includes(button.textContent ?? ''))).toBe(false);
});

it('downloads the complete original unknown blocks/attributes, then releases the temporary URL', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Blob', NodeBlob);
  let captured: Blob | undefined;
  const createUrl = vi.fn((blob: Blob) => { captured = blob; return 'blob:qa-document'; }), revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () => root.render(createElement(HolySheetApp, { initialPageId: 'future-page', embedded: true })));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Download document data')!.click());
  expect(click).toHaveBeenCalledOnce();
  const text = await captured!.text();
  const data = JSON.parse(text);
  expect(data.title).toBe('Preserved title'); expect(data.schemaVersion).toBe(999);
  expect(data.document.content[0]).toEqual({ type: 'futureWidget', attrs: { id: 'future-id', optionUnknownToOldEditor: 'retain exactly' }, content: [{ type: 'text', text: '<script>inert()</script> — future content' }] });
  await vi.advanceTimersByTimeAsync(1000); expect(revoke).toHaveBeenCalledWith('blob:qa-document');
});

it('tolerates unfamiliar child shapes without invoking the old schema parser', () => {
  expect(documentPreviewText({ type: 'doc', content: [{ type: 'newBlock', content: { newShape: true } }, null, { text: '<img onerror=bad()>' }] })).toBe('<img onerror=bad()>');
});

it('still mounts the rich editor for the supported schema', async () => {
  expect(schemaVersion).toBe(2); mocks.future = false;
  await act(async () => root.render(createElement(HolySheetApp, { initialPageId: 'future-page' })));
  expect(mocks.rich).toHaveBeenCalled(); expect(host.querySelector('[aria-label="Read-only document preview"]')).toBeNull();
});
