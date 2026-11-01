import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { changeVariantRouting } from "../../../../../../lib/document-variants";
import { repository } from "../../../../../../lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => changeVariantRouting(await repository(localPreview(request)), actor, (await params).id, await readJson(request, 8_000)), true);
}
