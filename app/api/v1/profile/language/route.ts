import { api, localPreview, readJson } from "../../../../../lib/auth";
import { changeProfileLanguage } from "../../../../../lib/document-variants";
import { repository } from "../../../../../lib/repository";

export async function POST(request: Request) {
  return api(request, async actor => changeProfileLanguage(await repository(localPreview(request)), actor, await readJson(request, 8_000)), true);
}
