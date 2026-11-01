import { api, localPreview } from "../../../../../../lib/auth";
import { runWorkspacePageReviewReminders } from "../../../../../../lib/page-review";
import { repository } from "../../../../../../lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => runWorkspacePageReviewReminders(await repository(localPreview(request)), actor, (await params).id), true);
}
