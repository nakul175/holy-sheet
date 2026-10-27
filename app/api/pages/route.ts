import { z } from "zod";
import { api, localPreview, readJson } from "../../../lib/auth";
import { DocumentError } from "../../../lib/document";
import { repository } from "../../../lib/repository";

export async function GET(req:Request){return api(req,async actor=>({pages:await (await repository(localPreview(req))).list(actor)}));}
export async function POST(req:Request){return api(req,async actor=>{const parsed=z.object({title:z.string().max(240).default("Untitled"),spaceId:z.string().min(1),parentPageId:z.string().nullable().optional(),operationId:z.string().uuid().optional()}).strict().safeParse(await readJson(req,8192));if(!parsed.success)throw new DocumentError("Invalid page");const r=await repository(localPreview(req));return {page:await r.create(actor,parsed.data.title,parsed.data.spaceId,parsed.data.parentPageId,parsed.data.operationId)};},true);}
