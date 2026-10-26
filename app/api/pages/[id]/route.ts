import { NextResponse } from "next/server";
import { z } from "zod";
import { blockTypes } from "../../../../lib/types";
import { getDemoPage, saveDemoPage } from "../../../../lib/demo-store";

const blockSchema = z.object({
  id: z.string(), pageId: z.string(), parentBlockId: z.string().nullable(),
  type: z.enum(blockTypes), text: z.string(), checked: z.boolean().optional(), position: z.number().int().min(0),
});
const saveSchema = z.object({ expectedVersion: z.number().int().positive(), title: z.string().max(240), blocks: z.array(blockSchema).max(1000) });

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const page = getDemoPage((await params).id);
  return page ? NextResponse.json({ page }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = saveSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid document" }, { status: 400 });
  const result = saveDemoPage((await params).id, parsed.data.expectedVersion, parsed.data.title, parsed.data.blocks);
  if (result.status === "missing") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (result.status === "conflict") return NextResponse.json({ error: "Page changed elsewhere", page: result.page }, { status: 409 });
  return NextResponse.json({ page: result.page });
}
