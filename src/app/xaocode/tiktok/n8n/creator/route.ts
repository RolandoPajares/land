import { NextRequest, NextResponse } from "next/server";
import { callTikTokJson, getValidTokenVault, isN8nAuthorized } from "@/lib/xaocode/tiktok";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isN8nAuthorized(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const vault = await getValidTokenVault();
  if (!vault) return NextResponse.json({ error: "TikTok no está conectado o el acceso expiró." }, { status: 401 });
  try {
    const payload = await callTikTokJson("/v2/post/publish/creator_info/query/", vault.accessToken);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "No se pudo consultar la información del creador en TikTok." }, { status: 502 });
  }
}
