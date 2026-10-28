import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {DocumentError} from '../../../../../../lib/document';
import {spaceAccess,previewSpaceMemberChange,changeSpaceMember} from '../../../../../../lib/space-administration';
const change={subjectId:z.string().min(1).max(200),role:z.enum(['leader','editor','viewer']).nullable()};
const input=z.discriminatedUnion('kind',[z.object({kind:z.literal('preview'),...change}).strict(),z.object({kind:z.literal('apply'),...change,operationId:z.string().uuid(),expectedVersion:z.number().int().positive(),previewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]);
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,c:Context){return api(req,async actor=>spaceAccess(await repository(localPreview(req)),actor,(await c.params).id));}
export async function POST(req:Request,c:Context){return api(req,async actor=>{const parsed=input.safeParse(await readJson(req,8192));if(!parsed.success)throw new DocumentError('Invalid space access change','invalid_change',422);const r=await repository(localPreview(req)),id=(await c.params).id;return parsed.data.kind==='preview'?previewSpaceMemberChange(r,actor,id,parsed.data):changeSpaceMember(r,actor,id,parsed.data);},true);}
