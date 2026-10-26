import { api, localPreview } from "../../../../../lib/auth";
import { repository } from "../../../../../lib/repository";
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const r=await repository(localPreview(req));const p=await r.access(r.db,(await params).id,actor);return {id:p.id,title:p.title};});}
