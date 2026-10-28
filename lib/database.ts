import { readFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";

export type Sql = { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
export type Database = Sql & { transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };

export async function createDatabase(dataDir?: string): Promise<Database> {
  const directory=path.join(process.cwd(),'db');
  const files=(await readdir(directory)).filter(name=>/^\d{3}_.+\.sql$/.test(name)&&name>='002_').sort();
  const migration=(await Promise.all(files.map(name=>readFile(path.join(directory,name),'utf8')))).join('\n');
  if (process.env.DATABASE_URL && !dataDir) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.PGSSL === "require" ? {rejectUnauthorized:true} : undefined });
    try { await pool.query(`BEGIN; SELECT pg_advisory_xact_lock(730217439);\n${migration}\nCOMMIT;`); } catch(error) { await pool.end(); throw error; }
    return {
      query: async <T>(sql: string, values?: unknown[]) => ({rows:(await pool.query(sql,values)).rows as T[]}),
      transaction: async <T>(fn: (tx:Sql)=>Promise<T>) => { const c=await pool.connect();try { await c.query("BEGIN");const result=await fn({query:async <R>(sql:string,values?:unknown[])=>({rows:(await c.query(sql,values)).rows as R[]})});await c.query("COMMIT");return result; } catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();} },
      close:()=>pool.end(),
    };
  }
  if (!dataDir && process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
  const dir = dataDir ?? (process.env.NODE_ENV!=='production'&&process.env.HS_LOCAL_PREVIEW==='1'?process.env.HS_LOCAL_DATABASE_DIR:undefined) ?? path.join(process.cwd(), ".holy-sheet/postgres");
  if(dir!==":memory:") await mkdir(dir,{recursive:true});
  const local = new PGlite(dir === ":memory:" ? undefined : dir);
  await local.exec(migration);
  const wrap = (client: Pick<PGlite,"query">): Sql => ({query:async <T>(sql:string,values?:unknown[])=>({rows:(await client.query(sql,values)).rows as T[]})});
  return {...wrap(local),transaction:fn=>local.transaction(tx=>fn(wrap(tx))),close:()=>local.close()};
}

const runtime = globalThis as typeof globalThis & { holyDatabase?: Promise<Database> };
export function database() { return runtime.holyDatabase ??= createDatabase(); }
