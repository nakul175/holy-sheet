import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { verifyRestoredTables } from '../scripts/restore-verification';
import type { Sql } from './database';

let source: PGlite, restored: PGlite;
const sql = (db: PGlite): Sql => ({ query: async <T>(statement: string, values?: unknown[]) => ({ rows: (await db.query<T>(statement, values)).rows }) });

beforeAll(() => { source = new PGlite(); restored = new PGlite(); });
afterAll(async () => { await source.close(); await restored.close(); });
beforeEach(async () => {
  for (const db of [source, restored]) await db.exec(`
    DROP TABLE IF EXISTS hs_pages, hs_extra, hsz_unrelated;
    CREATE TABLE hs_pages (id text PRIMARY KEY, content text NOT NULL);
    INSERT INTO hs_pages VALUES ('page-a', 'Saved rich content'), ('page-b', 'Checklist and image caption');
  `);
});

it('compares data independently of insertion order and ignores unrelated table names', async () => {
  await restored.exec("TRUNCATE hs_pages; INSERT INTO hs_pages VALUES ('page-b','Checklist and image caption'),('page-a','Saved rich content'); CREATE TABLE hsz_unrelated (id text)");
  expect(await verifyRestoredTables(sql(source), sql(restored))).toEqual([
    { table: 'hs_pages', rows: 2, digest: expect.any(String) },
  ]);
});

it('rejects restored content corruption even when row counts match', async () => {
  await restored.exec("UPDATE hs_pages SET content='Lost content' WHERE id='page-b'");
  await expect(verifyRestoredTables(sql(source), sql(restored))).rejects.toThrow('hs_pages: restored rows differ');
});

it('rejects missing restored tables before migrations can recreate them', async () => {
  await restored.exec('DROP TABLE hs_pages');
  await expect(verifyRestoredTables(sql(source), sql(restored))).rejects.toThrow('table inventory differs');
});

it('rejects unexpected restored HS tables', async () => {
  await restored.exec('CREATE TABLE hs_extra (id text)');
  await expect(verifyRestoredTables(sql(source), sql(restored))).rejects.toThrow('table inventory differs');
});

it('rejects an empty fixture database instead of reporting vacuous success', async () => {
  await source.exec('TRUNCATE hs_pages'); await restored.exec('TRUNCATE hs_pages');
  await expect(verifyRestoredTables(sql(source), sql(restored))).rejects.toThrow('seeded page fixtures');
});

it('rejects a source without the required HS schema', async () => {
  await source.exec('DROP TABLE hs_pages'); await restored.exec('DROP TABLE hs_pages');
  await expect(verifyRestoredTables(sql(source), sql(restored))).rejects.toThrow('HS page table');
});
