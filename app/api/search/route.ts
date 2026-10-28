import { api, localPreview } from "../../../lib/auth";
import { repository } from "../../../lib/repository";
import {workspaceSearch} from '../../../lib/workspace-search';
import {z} from 'zod';
import {DocumentError} from '../../../lib/document';
export async function GET(req:Request){return api(req,async actor=>{
 const p=new URL(req.url).searchParams;
 const parsed=z.object({query:z.string().max(512),workspaceId:z.string().min(1).max(200),spaceId:z.string().min(1).max(200).optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()}).safeParse({query:p.get('q')??'',workspaceId:p.get('workspaceId'),spaceId:p.get('spaceId')??undefined,cursor:p.get('cursor')??undefined});
 if(!parsed.success)throw new DocumentError('Invalid workspace search.','search_validation',400);
 return workspaceSearch(await repository(localPreview(req)),actor,parsed.data,req.signal);
});}
