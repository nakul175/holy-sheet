import {afterAll,beforeAll,expect,it} from 'vitest';import {createDatabase,type Database} from './database';
let db:Database;
beforeAll(async()=>{db=await createDatabase(':memory:');});afterAll(async()=>{await db.close();});
it('installs the durable rollup job, item and command ledger',async()=>{const rows=await db.query<{job:string|null;items:string|null;commands:string|null}>("SELECT to_regclass('hs_data_rollup_jobs')::text job,to_regclass('hs_data_rollup_job_items')::text items,to_regclass('hs_data_rollup_job_commands')::text commands");expect(rows.rows[0]).toEqual({job:'hs_data_rollup_jobs',items:'hs_data_rollup_job_items',commands:'hs_data_rollup_job_commands'});});
