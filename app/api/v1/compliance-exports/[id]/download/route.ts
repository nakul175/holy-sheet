import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { complianceSessionBinding, downloadComplianceExport } from "../../../../../../lib/compliance-pack";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";

const schema = z.object({ token: z.string().min(20).max(200) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const id = (await params).id;
    if (!z.string().uuid().safeParse(id).success) throw new DocumentError("Export unavailable", "not_found", 404);
    const input = schema.safeParse(await readJson(req, 1024));
    if (!input.success) throw new DocumentError("Invalid download review");
    const result = await downloadComplianceExport(await repository(localPreview(req)), actor, id, input.data.token, complianceSessionBinding(req, actor.id));
    const encoded = encodeURIComponent(result.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
        "Vary": "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  }, true);
}
