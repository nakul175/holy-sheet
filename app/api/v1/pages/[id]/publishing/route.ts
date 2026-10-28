import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {changePublishing,publishingState} from '../../../../../../lib/document-publishing';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>publishingState(await repository(localPreview(req)),actor,(await params).id));}
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>changePublishing(await repository(localPreview(req)),actor,(await params).id,await readJson(req,16000)),true);}
