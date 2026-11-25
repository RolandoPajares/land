import { NextRequest, NextResponse } from "next/server";
import { getValidTokenVault, isN8nAuthorized, vaultToPublicStatus } from "@/lib/xaocode/tiktok";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isN8nAuthorized(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const vault = await getValidTokenVault();
  if (!vault) return NextResponse.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(vaultToPublicStatus(vault), { headers: { "Cache-Control": "no-store" } });
}
