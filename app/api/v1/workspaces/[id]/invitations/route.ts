import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {DocumentError} from '../../../../../../lib/document';
import {acceptAccessInvitation,createAccessInvitation,listAccessInvitations,revokeAccessInvitation} from '../../../../../../lib/access-invitations';
const roles=z.enum(['owner','admin','member','observer']),spaceRoles=z.array(z.object({spaceId:z.string().min(1).max(200),role:z.enum(['leader','editor','viewer'])}).strict()).max(100);
const input=z.discriminatedUnion('kind',[z.object({kind:z.literal('create'),centralInvitationId:z.string().min(1).max(200),inviteeSubject:z.string().min(1).max(200),workspaceRole:roles,spaceRoles,operationId:z.uuid()}).strict(),z.object({kind:z.literal('accept'),invitationId:z.uuid(),centralInvitationId:z.string().min(1).max(200),operationId:z.uuid()}).strict(),z.object({kind:z.literal('revoke'),invitationId:z.uuid(),operationId:z.uuid()}).strict()]);
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,c:Context){return api(req,async actor=>listAccessInvitations(await repository(localPreview(req)),actor,(await c.params).id));}
export async function POST(req:Request,c:Context){return api(req,async actor=>{const parsed=input.safeParse(await readJson(req,16_384));if(!parsed.success)throw new DocumentError('Invalid invitation change','invalid_change',422);const r=await repository(localPreview(req)),id=(await c.params).id,d=parsed.data;if(d.kind==='create')return createAccessInvitation(r,actor,id,d);if(d.kind==='accept')return acceptAccessInvitation(r,actor,id,d);return revokeAccessInvitation(r,actor,id,d);},true);}
