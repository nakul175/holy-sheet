import { NextResponse } from "next/server";
import { searchDemoPages } from "../../../lib/demo-store";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const spaceId = searchParams.get("spaceId");
  return NextResponse.json({ results: searchDemoPages(query, spaceId).slice(0, 20) });
}
