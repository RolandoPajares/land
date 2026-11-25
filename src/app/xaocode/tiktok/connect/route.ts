import { NextResponse } from "next/server";
import { buildTikTokAuthorizationUrl, createOAuthState, saveOAuthStateForCallback, TikTokConfigurationError } from "@/lib/xaocode/tiktok";
import { TikTokStorageConfigurationError } from "@/lib/xaocode/tiktok-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const state = createOAuthState();
    await saveOAuthStateForCallback(state);
    const response = NextResponse.redirect(buildTikTokAuthorizationUrl(state));
    return response;
  } catch (error) {
    const message = error instanceof TikTokConfigurationError || error instanceof TikTokStorageConfigurationError ? error.message : "La conexión de TikTok no está configurada.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
