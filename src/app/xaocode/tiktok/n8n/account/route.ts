import { NextRequest, NextResponse } from "next/server";
import { callTikTokGet, getValidTokenVault, isN8nAuthorized } from "@/lib/xaocode/tiktok";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isN8nAuthorized(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const vault = await getValidTokenVault();
  if (!vault) return NextResponse.json({ error: "TikTok no está conectado o el acceso expiró." }, { status: 401 });
  try {
    const payload = await callTikTokGet("/v2/user/info/?fields=open_id,avatar_url,display_name,profile_deep_link", vault.accessToken);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "No se pudo consultar la cuenta conectada." }, { status: 502 });
  }
}
