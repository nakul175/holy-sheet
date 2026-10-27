import assert from 'node:assert/strict';
import type { Sql } from '../lib/database';

const listTables = async (db: Sql) => (await db.query<{ tablename: string }>(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'hs\\_%' ESCAPE '\\' ORDER BY tablename",
)).rows.map(row => row.tablename);

/** Compare before opening repositories: migrations must not repair a broken restore. */
export async function verifyRestoredTables(source: Sql, restored: Sql) {
  const names = await listTables(source);
  assert.ok(names.includes('hs_pages'), 'Source must contain the HS page table.');
  assert.deepEqual(await listTables(restored), names, 'Restored HS table inventory differs.');
  const results = [];
  for (const name of names) {
    assert.match(name, /^hs_[a-z_]+$/);
    const sql = `SELECT count(*)::integer AS rows, md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM "${name}" t`;
    const left = (await source.query<{ rows: number; digest: string }>(sql)).rows[0];
    const right = (await restored.query(sql)).rows[0];
    assert.deepEqual(right, left, `${name}: restored rows differ`);
    if (name === 'hs_pages') assert.ok(left.rows > 0, 'Source must contain seeded page fixtures.');
    results.push({ table: name, ...left });
  }
  return results;
}
