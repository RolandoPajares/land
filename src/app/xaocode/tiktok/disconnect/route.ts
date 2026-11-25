import { NextRequest, NextResponse } from "next/server";
import { disconnectStoredTokenVault, isN8nAuthorized } from "@/lib/xaocode/tiktok";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isN8nAuthorized(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  await disconnectStoredTokenVault();
  const response = NextResponse.json({ disconnected: true, note: "Se eliminó la sesión local. La revocación remota debe hacerse desde TikTok si corresponde." });
  return response;
}
