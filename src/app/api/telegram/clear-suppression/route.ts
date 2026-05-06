import { NextResponse } from "next/server";
import { requireFtmoMonitorAuth } from "@/lib/ftmoMonitorAuth";
import { __forceClearTelegramSuppression } from "@/utils/telegramNotify";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host)
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  try {
    if (new URL(origin).host !== host)
      return NextResponse.json(
        { ok: false, error: "forbidden" },
        { status: 403 },
      );
  } catch {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }
  const auth = await requireFtmoMonitorAuth();
  if (!auth.ok)
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  __forceClearTelegramSuppression();
  return NextResponse.json({
    ok: true,
    message: "Telegram suppression cleared",
  });
}
