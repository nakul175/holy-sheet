import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordLayoutRepository} from '../../../../../../../../lib/shared-record-layouts';
import {recordLayoutDefinition} from '../../../../../../../../lib/record-layout-definition';
const id=z.string().uuid(),collection=z.string().min(1).max(100);
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('save'),collection,expectedVersion:z.number().int().nonnegative(),expectedSchemaVersion:z.number().int().positive(),operationId:id,definition:recordLayoutDefinition}).strict(),
 z.object({kind:z.literal('preview'),collection,sourceVersion:z.number().int().positive(),expectedPublicationRevision:z.number().int().nonnegative(),expectedSchemaVersion:z.number().int().positive()}).strict(),
 z.object({kind:z.literal('publish'),previewId:id,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:id,confirm:z.literal('publish-record-layout')}).strict(),
]);
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
async function scoped(request:Request,c:Context){const {id:workspaceId,tenantId}=await c.params;const {actor,authority}=await authenticateRecordAuthority(request);return {ctx:{actor,workspaceId,tenantId},repo:new SharedRecordLayoutRepository(await repository(),authority)};}
export async function GET(request:Request,c:Context){try{const q=z.object({collection}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!q.success)throw new DocumentError('Invalid layout request.','record_layout_validation',400);const {ctx,repo}=await scoped(request,c);const [draft,published]=await Promise.all([repo.readLayoutDraft(ctx,q.data.collection),repo.getPublishedLayout(ctx,q.data.collection)]);return Response.json({draft,published},{headers});}catch(e){return failure(e);}}
export async function POST(request:Request,c:Context){try{sameOrigin(request);const parsed=command.safeParse(await readJson(request,256_000));if(!parsed.success)throw new DocumentError('Invalid layout request.','record_layout_validation',400);const {ctx,repo}=await scoped(request,c),data=parsed.data;if(data.kind==='save'){const {kind:_,...input}=data;return Response.json(await repo.saveLayoutDraft(ctx,input),{headers});}if(data.kind==='preview'){const {kind:_,...input}=data;return Response.json(await repo.previewLayoutPublication(ctx,input),{headers});}const {kind:_,...input}=data;return Response.json(await repo.publishLayout(ctx,input),{headers});}catch(e){return failure(e);}}
function failure(e:unknown){if(e instanceof DocumentError)return Response.json({error:e.message,code:e.code,retryable:e.status>=500},{status:e.status,headers});return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});}
