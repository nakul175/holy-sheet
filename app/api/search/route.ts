import { api, localPreview } from "../../../lib/auth";
import { repository } from "../../../lib/repository";
import {workspaceSearch} from '../../../lib/workspace-search';
import {searchKinds} from '../../../lib/types';
import {z} from 'zod';
import {DocumentError} from '../../../lib/document';
const date=/^\d{4}-\d{2}-\d{2}$/;
export async function GET(req:Request){return api(req,async actor=>{
 const p=new URL(req.url).searchParams;
 const type=p.get('type');
 const kinds=type?[...new Set(type.split(',').map(item=>item.trim()).filter(Boolean))]:undefined;
 const raw={query:p.get('q')??'',workspaceId:p.get('workspaceId'),spaceId:p.get('spaceId')??undefined,cursor:p.get('cursor')??undefined,...(kinds?{kinds}:{}),...(p.get('collection')?{collection:p.get('collection')}:{}),...(p.get('owner')?{ownerId:p.get('owner')}:{}),...(p.get('from')?{updatedFrom:p.get('from')}:{}),...(p.get('to')?{updatedTo:p.get('to')}:{})};
 const parsed=z.object({query:z.string().max(512),workspaceId:z.string().min(1).max(200),spaceId:z.string().min(1).max(200).optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),kinds:z.array(z.enum(searchKinds)).min(1).max(searchKinds.length).optional(),collection:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/).optional(),ownerId:z.string().min(1).max(200).regex(/^[^\p{C}]+$/u).optional(),updatedFrom:z.string().regex(date).optional(),updatedTo:z.string().regex(date).optional()}).safeParse(raw);
 if(!parsed.success||parsed.data.updatedFrom&&parsed.data.updatedTo&&parsed.data.updatedFrom>parsed.data.updatedTo)throw new DocumentError('Invalid workspace search.','search_validation',400);
 return workspaceSearch(await repository(localPreview(req)),actor,parsed.data,req.signal);
});}
