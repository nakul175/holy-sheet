import { z } from "zod";
import { api, localPreview } from "../../../../../lib/auth";
import { complianceSessionBinding, readComplianceExport } from "../../../../../lib/compliance-pack";
import { DocumentError } from "../../../../../lib/document";
import { repository } from "../../../../../lib/repository";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const id = (await params).id;
    if (!z.string().uuid().safeParse(id).success) throw new DocumentError("Export unavailable", "not_found", 404);
    return readComplianceExport(await repository(localPreview(req)), actor, id, complianceSessionBinding(req, actor.id));
  });
}
