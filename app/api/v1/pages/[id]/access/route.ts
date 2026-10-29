import { api,localPreview } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import {canEdit} from '../../../../../../lib/types';
import {publishedDocument} from '../../../../../../lib/document-publishing';
import {revisionDigest} from '../../../../../../lib/revision';
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,{params}:Context){
  return api(req,async actor=>{
    const r=await repository(localPreview(req)),page=await r.access(r.db,(await params).id,actor);
    // No document, ancestor names, recipient list, or permission-service secrets.
    const publication=!canEdit(page.role)?await publishedDocument(r,r.db,actor,page.id):null;
    return {actorId:actor.id,role:page.role,...(publication?{publicationFingerprint:publication.publicationId+':'+revisionDigest(publication.title,publication.document)}:{})};
  });
}
