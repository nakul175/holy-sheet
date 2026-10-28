import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {executeChecklistTask,prepareChecklistTask,unlinkChecklistTask} from '../../../../../../lib/checklist-tasks';
import {shoChecklistDestination} from '../../../../../../lib/sho-checklist-client';

const prepare=z.object({action:z.literal('prepare'),id:z.string().uuid(),itemId:z.string().uuid(),expectedVersion:z.number().int().positive(),projectId:z.string().min(1).max(200),assigneeId:z.string().min(1).max(200),dueDate:z.string(),title:z.string()}).strict();
const execute=z.object({action:z.literal('execute'),id:z.string().uuid(),itemId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const unlink=z.object({action:z.literal('unlink'),id:z.string().uuid(),reviewed:z.boolean()}).strict();
const input=z.discriminatedUnion('action',[prepare,execute,unlink]);
export const POST=(req:Request,ctx:{params:Promise<{id:string}>})=>api(req,async actor=>{
 const pageId=(await ctx.params).id,data=input.parse(await readJson(req,32_000)),r=await repository(localPreview(req));
 if(data.action==='unlink')return unlinkChecklistTask(r,actor,data.id,data.reviewed);
 const adapter=shoChecklistDestination(req,{intentId:data.id,pageId,itemId:data.itemId});
 return data.action==='prepare'?prepareChecklistTask(r,actor,pageId,data,adapter):executeChecklistTask(r,actor,data.id,data.reviewHash,adapter);
},true);
