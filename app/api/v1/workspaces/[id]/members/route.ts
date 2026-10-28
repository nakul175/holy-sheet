import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import { DocumentError } from '../../../../../../lib/document';
import { workspaceAccess,previewMemberChange,changeWorkspaceMember } from '../../../../../../lib/workspace-administration';
const change={subjectId:z.string().min(1).max(200),role:z.enum(['owner','admin','member','observer']),active:z.boolean()};
const input=z.discriminatedUnion('kind',[z.object({kind:z.literal('preview'),...change}).strict(),z.object({kind:z.literal('apply'),...change,operationId:z.uuid(),expectedVersion:z.number().int().positive(),previewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]);
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,c:Context){return api(req,async actor=>workspaceAccess(await repository(localPreview(req)),actor,(await c.params).id));}
export async function POST(req:Request,c:Context){return api(req,async actor=>{const data=input.safeParse(await readJson(req,8192));if(!data.success)throw new DocumentError('Invalid access change','invalid_change',422);const r=await repository(localPreview(req)),id=(await c.params).id;return data.data.kind==='preview'?previewMemberChange(r,actor,id,data.data):changeWorkspaceMember(r,actor,id,data.data);},true);}
