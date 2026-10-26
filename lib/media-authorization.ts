import type { Sql } from './database';
import { mediaIdPattern } from './types';
export { mediaIdPattern } from './types';
/** Call only after current page authorization; unattached paths additionally require Editor/Owner. */
export async function usableMedia(tx:Sql,pageId:string,actorId:string,id:string,active:boolean){
  if(!mediaIdPattern.test(id))return false;
  const result=await tx.query(`SELECT m.id FROM hs_media m WHERE m.id=$1 AND m.page_id=$2 AND m.state='ready' AND (
    $4::boolean OR (m.uploader_id=$3 AND m.created_at>clock_timestamp()-interval '30 minutes')
    OR EXISTS(SELECT 1 FROM hs_drafts d WHERE d.page_id=m.page_id AND d.user_id=$3 AND d.expires_at>clock_timestamp() AND d.attachment_ids @> jsonb_build_array(m.id::text))
    OR EXISTS(SELECT 1 FROM hs_revision_media rm JOIN hs_revisions v ON v.page_id=rm.page_id AND v.version=rm.version JOIN hs_pages p ON p.id=v.page_id WHERE rm.media_id=m.id AND p.deleted_at IS NULL AND (p.version=v.version OR v.superseded_at>clock_timestamp()-interval '90 days'))
  )`,[id,pageId,actorId,active]);return result.rows.length>0;
}
