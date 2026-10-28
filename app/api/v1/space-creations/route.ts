import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../lib/auth';
import {repository} from '../../../../lib/repository';
import {DocumentError} from '../../../../lib/document';
import {createSpaceIntent} from '../../../../lib/space-creation';
const input=z.object({name:z.string().trim().min(1).max(80),workspaceId:z.string().min(1).max(200),operationId:z.string().uuid()}).strict();
// Dedicated capability route: a rollback to an older server returns 404 instead
// of silently ignoring an operation ID on the legacy space-creation endpoint.
export async function POST(req:Request){return api(req,async actor=>{
 const parsed=input.safeParse(await readJson(req,8192));if(!parsed.success)throw new DocumentError('Invalid space creation','invalid_creation',422);
 const r=await repository(localPreview(req)),d=parsed.data;
 return {space:await createSpaceIntent(r,actor,d.name,d.workspaceId,d.operationId),acknowledgedOperationId:d.operationId};
},true);}
