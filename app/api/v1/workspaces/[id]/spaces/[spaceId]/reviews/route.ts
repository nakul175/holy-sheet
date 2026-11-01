import { api, localPreview, readJson } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { changeSpaceReviewPolicy, spaceReviewCsv, spaceReviewDashboard } from "../../../../../../../../lib/page-review";
import { repository } from "../../../../../../../../lib/repository";

type Context = { params: Promise<{ id: string; spaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const { id, spaceId } = await params;
    const url = new URL(request.url);
    const filter = url.searchParams.get("filter");
    const pages = await repository(localPreview(request));
    if (url.searchParams.get("export") === "csv") {
      const file = await spaceReviewCsv(pages, actor, id, spaceId, filter);
      return new Response(file.body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Content-Type": file.contentType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return spaceReviewDashboard(pages, actor, id, spaceId, filter);
  });
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => {
    const { id, spaceId } = await params;
    const body = await readJson(request, 16_000);
    if (!body || typeof body !== "object" || (body as { action?: string }).action !== "policy") throw new DocumentError("Invalid review operation", "invalid_review", 400);
    return changeSpaceReviewPolicy(await repository(localPreview(request)), actor, id, spaceId, body);
  }, true);
}
