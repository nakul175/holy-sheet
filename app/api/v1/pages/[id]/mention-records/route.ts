import { api,localPreview } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import { mentionRecords } from '../../../../../../lib/discussions';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>mentionRecords(await repository(localPreview(req)),actor,(await params).id,(new URL(req.url).searchParams.get('q')??'').slice(0,80)));}
