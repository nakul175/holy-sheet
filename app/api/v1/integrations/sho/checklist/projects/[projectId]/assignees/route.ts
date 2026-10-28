import {api} from '../../../../../../../../../lib/auth';
import {shoAssignees} from '../../../../../../../../../lib/sho-checklist-client';
export const GET=(req:Request,ctx:{params:Promise<{projectId:string}>})=>api(req,async()=>shoAssignees(req,(await ctx.params).projectId));
