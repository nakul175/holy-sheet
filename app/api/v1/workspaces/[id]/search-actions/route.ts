import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import { SEARCH_JUMP_UNAVAILABLE, runSearchCommand, searchCommandPalette } from "../../../../../../lib/search-jump";
import { authenticateRecordAuthority } from "../../../../../../lib/suite-tenant-authority";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return api(request, async actor => {
    const { id } = await context.params;
    const url = new URL(request.url);
    return searchCommandPalette(await repository(localPreview(request)), actor, id, { query: url.searchParams.get("q") ?? "", pageId: url.searchParams.get("pageId") ?? undefined });
  });
}

export async function POST(request: Request, context: Context) {
  return api(request, async actor => {
    const { id } = await context.params;
    const body = await readJson(request, 16_000);
    const action = body && typeof body === "object" && !Array.isArray(body) ? (body as { action?: unknown }).action : undefined;
    let authority = null;
    if (action === "create-record") {
      try { authority = (await authenticateRecordAuthority(request)).authority; }
      catch (error) {
        if (error instanceof DocumentError && (error.status === 404 || error.status === 403 || error.status === 503)) throw new DocumentError(SEARCH_JUMP_UNAVAILABLE, "not_found", 404);
        throw error;
      }
    }
    return runSearchCommand(await repository(localPreview(request)), actor, authority, id, body);
  }, true);
}
