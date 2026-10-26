import { api,localPreview } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import { templateProvenance } from '../../../../../../lib/templates';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>({source:await templateProvenance(await repository(localPreview(req)),actor,(await params).id)}));}
