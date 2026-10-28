import type {Database} from './database';
/** Existing explicit maintenance only; retain identity/audit, erase expired snapshot. */
export async function expireRecordExportSnapshots(db:Database){const r=await db.query("UPDATE hs_data_export_jobs SET state='expired',snapshot=NULL WHERE id IN(SELECT id FROM hs_data_export_jobs WHERE expires_at<=clock_timestamp() AND state='ready' ORDER BY expires_at LIMIT 100) RETURNING id");return r.rows.length;}
