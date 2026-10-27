import type { Repository } from "./repository";
import { deleteObject } from "./media";

// Called by the service operator's existing lifecycle mechanism; no schedule is created here.
export async function maintainStorage(r:Repository,erase:(key:string)=>Promise<void>=deleteObject){
  const {rows:candidates}=await r.db.query<{id:string;page_id:string;object_key:string}>(`SELECT m.id,m.page_id,m.object_key FROM hs_media m
    WHERE m.state IN ('rejected','purging') OR (m.state!='purged' AND m.created_at<now()-interval '30 minutes'
    AND NOT(m.state IN ('reserved','uploading','processing') AND m.reservation_expires_at>clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM hs_blocks b JOIN hs_pages p ON p.id=b.page_id
      WHERE b.page_id=m.page_id AND p.deleted_at IS NULL AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=m.id::text)
    AND NOT EXISTS (SELECT 1 FROM hs_drafts d WHERE d.page_id=m.page_id AND d.expires_at>now() AND d.attachment_ids @> jsonb_build_array(m.id::text))
    AND NOT EXISTS (SELECT 1 FROM hs_revision_media rm JOIN hs_revisions v ON v.page_id=rm.page_id AND v.version=rm.version JOIN hs_pages p ON p.id=v.page_id WHERE rm.media_id=m.id AND p.deleted_at IS NULL AND (p.version=v.version OR v.superseded_at>clock_timestamp()-interval '90 days'))
    ) ORDER BY CASE WHEN m.state IN ('rejected','purging') THEN 0 ELSE 1 END,m.created_at LIMIT 50`);
  const purge:{id:string;key:string}[]=[];
  for(const m of candidates){await r.db.transaction(async tx=>{
    await tx.query("SELECT id FROM hs_pages WHERE id=$1 FOR UPDATE",[m.page_id]);
    const {rows}=await tx.query<{state:string;scanned_at:string|null;deleted_at:string|null;created_at:string}>("SELECT state,scanned_at,deleted_at,created_at FROM hs_media WHERE id=$1 FOR UPDATE",[m.id]);const current=rows[0];if(!current)return;
    if(current.state==='purging'){purge.push({id:m.id,key:m.object_key});return;}
    if(current.state==='rejected'){await tx.query("UPDATE hs_media SET state='purging' WHERE id=$1",[m.id]);purge.push({id:m.id,key:m.object_key});return;}
    const transfer=await tx.query("SELECT id FROM hs_media WHERE id=$1 AND state IN ('reserved','uploading','processing') AND reservation_expires_at>clock_timestamp()",[m.id]);if(transfer.rows.length)return;
    const live=await tx.query("SELECT b.id FROM hs_blocks b JOIN hs_pages p ON p.id=b.page_id WHERE b.page_id=$1 AND p.deleted_at IS NULL AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=$2 LIMIT 1",[m.page_id,m.id]);
    const lease=await tx.query("SELECT id FROM hs_drafts WHERE page_id=$1 AND expires_at>now() AND attachment_ids @> $2::jsonb LIMIT 1",[m.page_id,JSON.stringify([m.id])]);
    const history=await tx.query("SELECT rm.media_id FROM hs_revision_media rm JOIN hs_revisions v ON v.page_id=rm.page_id AND v.version=rm.version JOIN hs_pages p ON p.id=v.page_id WHERE rm.media_id=$1 AND p.deleted_at IS NULL AND (p.version=v.version OR v.superseded_at>clock_timestamp()-interval '90 days') LIMIT 1",[m.id]);
    if(live.rows.length||lease.rows.length||history.rows.length)return;
    if(current.scanned_at&&!current.deleted_at){await tx.query("UPDATE hs_media SET deleted_at=now() WHERE id=$1",[m.id]);return;}
    const aged=new Date(current.scanned_at?current.deleted_at!:current.created_at).getTime();
    const wait=current.scanned_at?7*86400_000:86400_000;
    if(Date.now()-aged<wait)return;
    // Commit a tombstone BEFORE storage deletion. Even if storage succeeds and a later DB update fails,
    // concurrent restore cannot see a ready attachment and commit a dangling reference.
    await tx.query("UPDATE hs_media SET state='purging' WHERE id=$1",[m.id]);purge.push({id:m.id,key:m.object_key});
  });}
  let removed=0,failed=0;
  for(const object of purge){try{await erase(object.key);await r.db.query("UPDATE hs_media SET state='purged' WHERE id=$1 AND state='purging'",[object.id]);removed++;}catch{failed++;}}
  await r.db.query("DELETE FROM hs_operations WHERE created_at<now()-interval '30 days'");
  await r.db.query("DELETE FROM hs_revisions v WHERE superseded_at<=clock_timestamp()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM hs_pages p WHERE p.id=v.page_id AND p.version=v.version) AND NOT EXISTS(SELECT 1 FROM hs_drafts d WHERE d.page_id=v.page_id AND d.base_version=v.version AND d.expires_at>now())");
  await r.db.query('DELETE FROM hs_restore_previews WHERE expires_at<=clock_timestamp()');
  await r.db.query('DELETE FROM hs_search_snapshots WHERE id IN (SELECT id FROM hs_search_snapshots WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)');
  return {considered:candidates.length,removed,failed};
}
