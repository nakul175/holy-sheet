import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
let db: Database, r: Repository;
beforeAll(async () => { db = await createDatabase(':memory:'); r = new Repository(db); await r.seedLocal(); });
afterAll(async () => db.close());
it('commits one page for repeated creation after a lost response', async () => {
    const op = crypto.randomUUID();
    const first = await r.create(localActor, 'Creation retry', 'space-product', null, op);
    const again = await r.create(localActor, 'Creation retry', 'space-product', null, op);
    expect(again.id).toBe(first.id);
    const rows = await db.query('SELECT id FROM hs_pages WHERE title=$1', ['Creation retry']);
    expect(rows.rows).toHaveLength(1);
    await expect(r.create(localActor, 'Different', 'space-product', null, op)).rejects.toMatchObject({ code: 'operation_mismatch', status: 409 });
});
it('does not replay a deleted page or leak an intent to another actor', async () => {
    const op = crypto.randomUUID();
    const page = await r.create(localActor, 'Deleted creation', 'space-product', null, op);
    await db.query('UPDATE hs_pages SET deleted_at=now() WHERE id=$1', [page.id]);
    await expect(r.create(localActor, 'Deleted creation', 'space-product', null, op)).rejects.toMatchObject({ status: 404 });
    await db.query("INSERT INTO hs_users(id,name) VALUES('other-creator','Other')");
    await expect(r.create({ id: 'other-creator' }, 'Deleted creation', 'space-product', null, op)).rejects.toMatchObject({ status: 404 });
});
it('rolls back a failed creation intent so corrected retries can succeed', async () => {
    const op = crypto.randomUUID();
    await expect(r.create(localActor, 'Bad space', 'absent', null, op)).rejects.toMatchObject({ status: 404 });
    const page = await r.create(localActor, 'Valid space', 'space-product', null, op);
    expect(page.id).toBeTruthy();
});

it('does not block retention purge or recreate a purged page on retry',async()=>{
 const op=crypto.randomUUID(),title='Purged creation';const page=await r.create(localActor,title,'space-product',null,op);
 await db.query('DELETE FROM hs_blocks WHERE page_id=$1',[page.id]);
 await db.query('DELETE FROM hs_revisions WHERE page_id=$1',[page.id]);
 await db.query('DELETE FROM hs_pages WHERE id=$1',[page.id]);
 await expect(r.create(localActor,title,'space-product',null,op)).rejects.toMatchObject({status:404});
 expect((await db.query('SELECT id FROM hs_pages WHERE title=$1',[title])).rows).toHaveLength(0);
});
