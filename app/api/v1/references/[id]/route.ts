import { api, localPreview } from "../../../../../lib/auth";
import { repository } from "../../../../../lib/repository";
import { referenceLabel } from '../../../../../lib/page-references';
import { DocumentError } from '../../../../../lib/document';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const source=new URL(req.url).searchParams.get('sourcePageId');if(!source)throw new DocumentError('Linked page is restricted or unavailable','not_found',404);return referenceLabel(await repository(localPreview(req)),actor,source,(await params).id);});}
