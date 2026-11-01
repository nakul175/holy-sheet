import { api, localPreview } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import { variantPublicationDiff } from "../../../../../../../lib/document-variants";
import { repository } from "../../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const url = new URL(request.url);
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new DocumentError("Invalid language variant operation", "invalid_variant", 400);
    return variantPublicationDiff(await repository(localPreview(request)), actor, (await params).id, from, to);
  });
}
