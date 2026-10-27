import { z } from 'zod';
import { api, localPreview, readJson } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import { DocumentError } from '../../../../../../lib/document';
const input = z.discriminatedUnion('action', [
    z.object({ action: z.literal('create'), title: z.string().max(240), spaceId: z.string().min(1).max(200), operationId: z.string().uuid() }).strict(),
    z.object({ action: z.literal('space'), name: z.string().trim().min(1).max(80), workspaceId: z.string().min(1).max(200) }).strict(),
    z.object({ action: z.literal('select'), pageId: z.string().uuid() }).strict()
]);
function expected(req: Request, id: string) { if (req.headers.get('x-hs-actor') !== id)
    throw new DocumentError('Use the same Aplyd account as SHO', 'identity_mismatch', 403); }
export async function GET(req: Request) {
    return api(req, async (actor) => {
        expected(req, actor.id);
        const r = await repository(localPreview(req));
        const spaces = (await r.db.query<{
            id: string;
            name: string;
            workspaceId: string;
            workspaceName: string;
        }>(`SELECT s.id,s.name,s.workspace_id AS "workspaceId",w.name AS "workspaceName" FROM hs_spaces s JOIN hs_workspaces w ON w.id=s.workspace_id JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$1 AND m.active=true ORDER BY w.name,s.name`, [actor.id])).rows, pages = (await r.list(actor)).map(p => ({ id: p.id, title: p.title, spaceId: p.spaceId, workspaceId: p.workspaceId }));
        return { subject: actor.id, spaces, pages };
    });
}
export async function POST(req: Request) {
    return api(req, async (actor) => {
        expected(req, actor.id);
        const parsed = input.safeParse(await readJson(req, 8192));
        if (!parsed.success)
            throw new DocumentError('Invalid document selection');
        const r = await repository(localPreview(req)), data = parsed.data;
        if (data.action === 'space')
            return { subject: actor.id, space: await r.createSpace(actor, data.name, data.workspaceId) };
        const page = data.action === 'create' ? await r.create(actor, data.title, data.spaceId, null, data.operationId) : await r.get(data.pageId, actor);
        return { subject: actor.id, page: { id: page.id, spaceId: page.spaceId } };
    }, true);
}
