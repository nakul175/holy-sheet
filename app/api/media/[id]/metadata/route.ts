import { api, localPreview } from "../../../../../lib/auth";
import { mediaAccess } from "../../../../../lib/media";
import { repository } from "../../../../../lib/repository";
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const m=await mediaAccess(await repository(localPreview(req)),actor,(await params).id);return {name:m.name,size:Number(m.size),mime:m.mime};});}
