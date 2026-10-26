import { api, localPreview } from "../../../../lib/auth";
import { repository } from "../../../../lib/repository";
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>({page:await (await repository(localPreview(req))).get((await params).id,actor),actorId:actor.id,localPreview:localPreview(req)}));}
// The unsafe legacy whole-block overwrite endpoint is retired.
export async function PATCH(){return Response.json({error:"Use the versioned document operations endpoint",code:"upgrade_required"},{status:410});}
