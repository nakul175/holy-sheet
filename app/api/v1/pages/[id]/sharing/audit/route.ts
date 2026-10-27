import {api,localPreview} from '../../../../../../../lib/auth';
import {repository} from '../../../../../../../lib/repository';
import {sharingAudit} from '../../../../../../../lib/sharing';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>({events:await sharingAudit(await repository(localPreview(req)),actor,(await params).id)}));}
