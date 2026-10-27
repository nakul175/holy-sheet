import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { documentBlocks, fromLegacy, plainText, stableStringify, validateDocument } from './document';
import type { Block } from './types';

const fixture: Block[] = [
  { id: 'heading', pageId: 'legacy', parentBlockId: null, type: 'heading', text: 'Migration 👋 مرحبا', position: 0 },
  { id: 'list-source', pageId: 'legacy', parentBlockId: null, type: 'paragraph', text: '  Preserve whitespace\nSecond line', position: 1 },
  { id: 'source', pageId: 'legacy', parentBlockId: null, type: 'bullet', text: 'Bullet', position: 2 },
  { id: 'number', pageId: 'legacy', parentBlockId: null, type: 'number', text: 'Numbered', position: 3 },
  { id: 'checked', pageId: 'legacy', parentBlockId: null, type: 'checklist', text: 'Completed', checked: true, position: 4 },
  { id: 'unchecked', pageId: 'legacy', parentBlockId: null, type: 'checklist', text: 'Pending', checked: false, position: 5 },
];
let db: Database | undefined, directory: string | undefined;
afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('orders by stored position and retains text, checks and source IDs without helper-ID collisions', () => {
  const source = structuredClone(fixture).reverse(), before = structuredClone(source), document = fromLegacy(source);
  expect(() => validateDocument(document)).not.toThrow();
  const blocks = documentBlocks(document);
  for (const original of fixture) expect(blocks.find(block => block.id === original.id)).toBeDefined();
  expect(blocks.find(block => block.id === 'checked')?.node.attrs?.checked).toBe(true);
  expect(blocks.find(block => block.id === 'unchecked')?.node.attrs?.checked).toBe(false);
  expect(plainText(document).replace(/\n+/g, '\n')).toBe(fixture.map(block => block.text).join('\n'));
  expect(source).toEqual(before); expect(fromLegacy(source)).toEqual(document);
});

it.each([
  ['nested blocks', () => [{ ...fixture[0], parentBlockId: 'unknown-parent' }]],
  ['unknown block types', () => [{ ...fixture[0], type: 'futureWidget' }]],
  ['mixed pages', () => [fixture[0], { ...fixture[1], pageId: 'another-page' }]],
  ['duplicate source IDs', () => [fixture[0], { ...fixture[1], id: fixture[0].id }]],
  ['ambiguous positions', () => [fixture[0], { ...fixture[1], position: fixture[0].position }]],
  ['unsupported source fields', () => [{ ...fixture[0], futureOption: 'must not vanish' }]],
  ['checked state on a non-checklist block', () => [{ ...fixture[0], checked: true }]],
])('requires review for %s without mutating the legacy input', (_name, build) => {
  const source = build() as Block[], before = structuredClone(source);
  expect(() => fromLegacy(source)).toThrow(); expect(source).toEqual(before);
});

it('retains converted text, order, IDs and checklist state across a cold SQL reopen', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'holy3-legacy-reopen-'));
  db = await createDatabase(directory); let repository = new Repository(db); await repository.seedLocal();
  const page = await repository.create(localActor, 'Synthetic legacy migration', 'space-product');
  await repository.save(page.id, localActor, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document: fromLegacy(fixture) });
  const before = stableStringify(await repository.get(page.id, localActor));
  await db.close(); db = undefined;
  db = await createDatabase(directory); repository = new Repository(db);
  expect(stableStringify(await repository.get(page.id, localActor))).toBe(before);
});
