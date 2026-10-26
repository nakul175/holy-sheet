import { NextResponse } from "next/server";
import { z } from "zod";
import { createDemoPage, listDemoPages } from "../../../lib/demo-store";

const inputSchema = z.object({
  title: z.string().max(240).default("Untitled"),
  spaceId: z.string().min(1),
  parentPageId: z.string().nullable().optional(),
});

export async function GET() { return NextResponse.json({ pages: listDemoPages() }); }
export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid page" }, { status: 400 });
  return NextResponse.json({ page: createDemoPage(parsed.data) }, { status: 201 });
}
