import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {beginCollaboration,leaveCollaboration,pullCollaboration,submitCollaboration,updateCollaborationPresence} from '../../../../../../lib/collaboration';
import {DocumentError} from '../../../../../../lib/document';
import {repository} from '../../../../../../lib/repository';
const uuid=z.string().uuid(),base=z.object({sessionId:uuid,epoch:uuid,clientId:uuid});
const input=z.discriminatedUnion('action',[
 z.object({action:z.literal('start'),clientId:uuid}).strict(),
 base.extend({action:z.literal('pull'),afterVersion:z.number().int().nonnegative()}).strict(),
 base.extend({action:z.literal('submit'),operationId:uuid,baseStepVersion:z.number().int().nonnegative(),steps:z.array(z.unknown()).min(1).max(100)}).strict(),
 base.extend({action:z.literal('presence'),presence:z.object({anchorBlockId:z.string().max(100).nullable().optional(),anchorOffset:z.number().int().nonnegative().max(1_000_000).nullable().optional(),headBlockId:z.string().max(100).nullable().optional(),headOffset:z.number().int().nonnegative().max(1_000_000).nullable().optional()}).strict()}).strict(),
 base.extend({action:z.literal('leave')}).strict(),
]);
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{
 if(process.env.HS_COLLABORATION_ENABLED!=='1')throw new DocumentError('Live collaboration is not enabled in this environment.','feature_disabled',503);
 const parsed=input.safeParse(await readJson(req,300_000));if(!parsed.success)throw new DocumentError('Invalid collaboration request.');const pageId=(await params).id,r=await repository(localPreview(req)),value=parsed.data;
 if(value.action==='start')return beginCollaboration(r,actor,pageId,value.clientId);
 if(value.action==='pull')return pullCollaboration(r,actor,pageId,value);
 if(value.action==='submit')return submitCollaboration(r,actor,pageId,value);
 if(value.action==='presence')return updateCollaborationPresence(r,actor,pageId,value);
 return leaveCollaboration(r,actor,pageId,value);
 },true);}
