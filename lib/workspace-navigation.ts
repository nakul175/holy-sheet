import type {Actor} from './auth';
import type {Repository} from './repository';
export type WorkspaceSummary={id:string;name:string;canCreateWorkspace:boolean};
// Include empty workspaces: their first space/page must not be a prerequisite
// for discovering a workspace the current actor already belongs to.
export async function listWorkspaces(r:Repository,actor:Actor):Promise<WorkspaceSummary[]>{
 const result=await r.db.query<WorkspaceSummary>(`SELECT w.id,w.name,(m.role='owner') AS "canCreateWorkspace" FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$1 AND m.active=true ORDER BY w.name,w.id`,[actor.id]);
 return result.rows;
}
