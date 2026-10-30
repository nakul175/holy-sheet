import {api,localPreview} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {publishedDocument} from '../../../../../../lib/document-publishing';
import {DocumentError} from '../../../../../../lib/document';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const r=await repository(localPreview(req));return r.db.transaction(async tx=>{const result=await publishedDocument(r,tx,actor,(await params).id);if(!result)throw new DocumentError('Published version is unavailable','publication_unavailable',404);return result;});});}
