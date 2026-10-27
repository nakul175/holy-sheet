import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {DocumentError} from '../../../../../../lib/document';
import {previewPageLocation,movePageTree} from '../../../../../../lib/page-organisation';
const intent={spaceId:z.string().min(1).max(200),parentId:z.string().min(1).max(200).nullable(),index:z.number().int().min(0).max(1000)};
const input=z.discriminatedUnion('kind',[z.object({kind:z.literal('preview'),...intent}).strict(),z.object({kind:z.literal('apply'),...intent,operationId:z.uuid(),expectedTreeVersion:z.number().int().positive(),previewDigest:z.string().regex(/^[a-f0-9]{64}$/),confirmExpanded:z.boolean()}).strict()]);
type Context={params:Promise<{id:string}>};
export async function POST(req:Request,c:Context){return api(req,async actor=>{const data=input.safeParse(await readJson(req,8192));if(!data.success)throw new DocumentError('Invalid page move','invalid_move',422);const r=await repository(localPreview(req)),id=(await c.params).id;return data.data.kind==='preview'?previewPageLocation(r,actor,id,data.data):movePageTree(r,actor,id,data.data);},true);}
