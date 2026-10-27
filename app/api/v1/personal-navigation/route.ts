import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../lib/auth';
import { repository } from '../../../../lib/repository';
import { DocumentError } from '../../../../lib/document';
import { personalNavigation,updatePersonalNavigation } from '../../../../lib/personal-navigation';
const id=z.string().min(1).max(200),version=z.number().int().nonnegative();
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('favourite'),pageId:id,value:z.boolean(),version}).strict(),
 z.object({action:z.literal('opened'),pageId:id}).strict(),
 z.object({action:z.literal('clear'),version}).strict(),
 z.object({action:z.literal('reorder'),pageId:id,beforeId:id.nullable(),version}).strict()
]);
export async function GET(req:Request){return api(req,async actor=>{const workspaceId=new URL(req.url).searchParams.get('workspaceId')??undefined;if(workspaceId&&!id.safeParse(workspaceId).success)throw new DocumentError('Invalid workspace');return personalNavigation(await repository(localPreview(req)),actor,workspaceId);});}
export async function POST(req:Request){return api(req,async actor=>{const input=schema.safeParse(await readJson(req,2048));if(!input.success)throw new DocumentError('Invalid personal navigation request');return updatePersonalNavigation(await repository(localPreview(req)),actor,input.data);},true);}
