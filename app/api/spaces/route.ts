import { z } from "zod";
import { api, localPreview, readJson } from "../../../lib/auth";
import { DocumentError } from "../../../lib/document";
import { repository } from "../../../lib/repository";
export async function GET(req:Request){return api(req,async actor=>{const spaces=await (await repository(localPreview(req))).spaces(actor);return {spaces,workspace:spaces[0]?{id:spaces[0].workspaceId,name:"Workspace"}:null};});}
export async function POST(req:Request){return api(req,async actor=>{const p=z.object({name:z.string().trim().min(1).max(80),workspaceId:z.string().optional()}).strict().safeParse(await readJson(req,8192));if(!p.success)throw new DocumentError("Invalid space name");const r=await repository(localPreview(req));const workspaceId=p.data.workspaceId??(await r.spaces(actor))[0]?.workspaceId;if(!workspaceId)throw new DocumentError("Workspace unavailable","not_found",404);return {space:await r.createSpace(actor,p.data.name,workspaceId)};},true);}
