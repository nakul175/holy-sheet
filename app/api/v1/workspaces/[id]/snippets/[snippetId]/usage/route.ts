import { api, localPreview } from "../../../../../../../../lib/auth";
import { repository } from "../../../../../../../../lib/repository";
import { snippetUsageCsvText, snippetUsageReport } from "../../../../../../../../lib/snippets";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; snippetId: string }> }) {
  return api(request, async actor => {
    const { id, snippetId } = await params;
    const report = await snippetUsageReport(await repository(localPreview(request)), actor, id, snippetId);
    if (new URL(request.url).searchParams.get("format") !== "csv") return report;
    return new Response(snippetUsageCsvText(report.placements), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=\"snippet-usage.csv\"",
        "cache-control": "no-store",
        vary: "Cookie, Authorization",
      },
    });
  });
}
