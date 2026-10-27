import { api,localPreview } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import { backlinks } from '../../../../../../lib/page-references';
import { DocumentError } from '../../../../../../lib/document';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const after=new URL(req.url).searchParams.get('after')??undefined;if(after&&!/^[a-zA-Z0-9_-]{1,100}$/.test(after))throw new DocumentError('Invalid backlink cursor');return backlinks(await repository(localPreview(req)),actor,(await params).id,after);});}
