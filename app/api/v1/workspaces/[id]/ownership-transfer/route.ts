import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {DocumentError} from '../../../../../../lib/document';
import {previewOwnershipTransfer,requestOwnershipTransfer,acceptOwnershipTransfer,ownershipTransfers} from '../../../../../../lib/ownership-transfer';
const id=z.string().uuid(),input=z.discriminatedUnion('kind',[z.object({kind:z.literal('preview'),targetId:z.string().min(1).max(200)}).strict(),z.object({kind:z.literal('request'),targetId:z.string().min(1).max(200),operationId:id,expectedVersion:z.number().int().positive(),previewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),z.object({kind:z.literal('accept'),transferId:id,operationId:id,expectedVersion:z.number().int().positive()}).strict()]);
export async function GET(req:Request,c:{params:Promise<{id:string}>}){return api(req,async actor=>ownershipTransfers(await repository(localPreview(req)),actor,(await c.params).id));}
export async function POST(req:Request,c:{params:Promise<{id:string}>}){return api(req,async actor=>{const parsed=input.safeParse(await readJson(req,8192));if(!parsed.success)throw new DocumentError('Invalid ownership transfer','invalid_change',422);const r=await repository(localPreview(req)),workspaceId=(await c.params).id;return parsed.data.kind==='preview'?previewOwnershipTransfer(r,actor,workspaceId,parsed.data.targetId):parsed.data.kind==='request'?requestOwnershipTransfer(r,actor,workspaceId,parsed.data):acceptOwnershipTransfer(r,actor,workspaceId,parsed.data);},true);}
