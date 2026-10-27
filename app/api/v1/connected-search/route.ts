import { z } from 'zod';
import { api,localPreview,readJson,sameOrigin } from '../../../../lib/auth';
import { repository } from '../../../../lib/repository';
import { connectedSearch } from '../../../../lib/connected-search';
import { DocumentError } from '../../../../lib/document';
const id=z.string().min(1).max(200),schema=z.object({query:z.string().trim().min(2).max(512),workspaceId:id,spaceId:id.optional(),cursor:z.string().max(128).optional(),requestId:z.string().uuid()}).strict();
// Keep private query text out of ordinary URL/access logs. Bearer calls have already
// passed api's trusted issuer/audience verification; cookie calls require exact origin.
export async function POST(req:Request){return api(req,async actor=>{if(req.headers.has('x-hs-actor')&&req.headers.get('x-hs-actor')!==actor.id)throw new DocumentError('Use the same Aplyd account as the connected client.','identity_mismatch',403);if(!/^Bearer .+$/.test(req.headers.get('authorization')??''))sameOrigin(req);const input=schema.safeParse(await readJson(req,2048));if(!input.success)throw new DocumentError('Invalid scoped search request');return {subject:actor.id,...await connectedSearch(await repository(localPreview(req)),actor,input.data)};});}
