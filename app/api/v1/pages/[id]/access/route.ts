import { api,localPreview } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,{params}:Context){
  return api(req,async actor=>{
    const r=await repository(localPreview(req)),page=await r.access(r.db,(await params).id,actor);
    // No document, ancestor names, recipient list, or permission-service secrets.
    return {actorId:actor.id,role:page.role};
  });
}
