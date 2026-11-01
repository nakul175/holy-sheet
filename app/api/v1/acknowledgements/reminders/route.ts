import { createHash, timingSafeEqual } from "node:crypto";
import { DocumentError } from "../../../../../lib/document";
import { runAcknowledgementReminders } from "../../../../../lib/document-acknowledgements";
import { repository } from "../../../../../lib/repository";

function authorized(request: Request) {
  const expected = process.env.HS_ACK_REMINDER_TOKEN;
  if (!expected) return "unconfigured" as const;
  const presented = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(presented).digest();
  return timingSafeEqual(left, right) ? "ok" as const : "denied" as const;
}

export async function POST(request: Request) {
  try {
    const access = authorized(request);
    if (access === "unconfigured") return Response.json({ error: "Reminder job is not configured", code: "reminder_unconfigured", retryable: true }, { status: 503, headers: { "Cache-Control": "no-store" } });
    if (access !== "ok") return Response.json({ error: "Page is restricted or unavailable", code: "not_found", retryable: false }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return Response.json(await runAcknowledgementReminders(await repository(false)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    console.error("HS acknowledgement reminder failed", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Service temporarily unavailable", code: "service_unavailable", retryable: true }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
