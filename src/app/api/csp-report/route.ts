import { NextResponse } from "next/server";
import { isRateLimited } from "@/utils/distributedRateLimit";

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (
    await isRateLimited("csp-report", ip, { windowMs: 60_000, maxHits: 30 })
  ) {
    return new NextResponse(null, { status: 429 });
  }
  try {
    const body = await request.json();
    console.warn("[csp-violation]", JSON.stringify(body).slice(0, 500));
  } catch {
    // ignore malformed body
  }
  return new NextResponse(null, { status: 204 });
}
