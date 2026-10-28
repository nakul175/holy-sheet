import {api} from '../../../../../../../lib/auth';
import {shoProjects} from '../../../../../../../lib/sho-checklist-client';
export const GET=(req:Request)=>api(req,async()=>shoProjects(req));
