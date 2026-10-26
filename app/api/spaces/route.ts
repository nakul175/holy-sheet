import { NextResponse } from "next/server";
import { z } from "zod";
import { createDemoSpace, demoWorkspace, listDemoSpaces } from "../../../lib/demo-store";

export async function GET() { return NextResponse.json({ workspace: demoWorkspace, spaces: listDemoSpaces() }); }
export async function POST(request: Request) {
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Enter a space name" }, { status: 400 });
  return NextResponse.json({ space: createDemoSpace(parsed.data.name) }, { status: 201 });
}
