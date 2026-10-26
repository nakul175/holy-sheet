import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError, saveInput } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const parsed=saveInput.safeParse(await readJson(req));if(!parsed.success)throw new DocumentError("Invalid document operation");return (await repository(localPreview(req))).save((await params).id,actor,parsed.data);},true);}
