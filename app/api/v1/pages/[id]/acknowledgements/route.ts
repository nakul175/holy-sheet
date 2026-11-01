import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { acknowledgementExport, acknowledgementView, changeAcknowledgement, ipCountryFromHeader } from "../../../../../../lib/document-acknowledgements";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const pageId = (await params).id;
    const url = new URL(request.url);
    const format = url.searchParams.get("export");
    const repo = await repository(localPreview(request));
    if (format === "csv" || format === "evidence") {
      const file = await acknowledgementExport(repo, actor, pageId, format, url.searchParams.get("status"));
      return new Response(file.body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
          "Content-Type": file.contentType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return acknowledgementView(repo, actor, pageId);
  });
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => changeAcknowledgement(
    await repository(localPreview(request)),
    actor,
    (await params).id,
    await readJson(request, 16_000),
    { ipCountry: ipCountryFromHeader(request.headers.get("x-hs-ip-country")) },
  ), true);
}
