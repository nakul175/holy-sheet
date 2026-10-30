import {api,localPreview} from '../../../lib/auth';
import {repository} from '../../../lib/repository';
import {listWorkspaces} from '../../../lib/workspace-navigation';
export async function GET(req:Request){return api(req,async actor=>({workspaces:await listWorkspaces(await repository(localPreview(req)),actor)}));}
