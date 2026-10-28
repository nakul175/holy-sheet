import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../lib/auth';
import {repository} from '../../../../lib/repository';
import {DocumentError} from '../../../../lib/document';
import {createWorkspaceIntent} from '../../../../lib/workspace-creation';
const input=z.object({name:z.string().trim().min(1).max(80),sourceWorkspaceId:z.string().min(1).max(200),operationId:z.string().uuid()}).strict();
export async function POST(req:Request){return api(req,async actor=>{const parsed=input.safeParse(await readJson(req,8192));if(!parsed.success)throw new DocumentError('Invalid workspace creation','invalid_creation',422);return createWorkspaceIntent(await repository(localPreview(req)),actor,parsed.data);},true);}
