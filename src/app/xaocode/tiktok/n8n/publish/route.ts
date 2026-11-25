import { NextRequest, NextResponse } from "next/server";
import { callTikTokJson, getValidTokenVault, isN8nAuthorized } from "@/lib/xaocode/tiktok";
import { consumeApproval, deletePublication, loadPublication, reservePublication, saveApproval, savePublication, type PublicationRecord } from "@/lib/xaocode/tiktok-store";

export const runtime = "nodejs";

type PublishBody = { approval_id?: string; idempotency_key?: string };

export async function POST(request: NextRequest) {
  if (!isN8nAuthorized(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as PublishBody | null;
  if (!body?.approval_id || !body.idempotency_key) return NextResponse.json({ error: "approval_id e idempotency_key son obligatorios." }, { status: 400 });
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(body.approval_id) || !/^[A-Za-z0-9_.:-]{8,120}$/.test(body.idempotency_key)) return NextResponse.json({ error: "Identificadores inválidos." }, { status: 400 });

  const existing = await loadPublication(body.idempotency_key);
  if (existing) return NextResponse.json({ duplicate: true, publication: existing }, { status: 409, headers: { "Cache-Control": "no-store" } });

  const approval = await consumeApproval(body.approval_id);
  if (!approval) return NextResponse.json({ error: "La aprobación no existe, ya fue utilizada o expiró." }, { status: 409 });
  if (new Date(approval.expiresAt).getTime() <= Date.now()) return NextResponse.json({ error: "La aprobación está expirada." }, { status: 409 });

  const processing: PublicationRecord = {
    idempotencyKey: body.idempotency_key,
    contentHash: approval.contentHash,
    approvalId: approval.approvalId,
    status: "processing",
    createdAt: new Date().toISOString(),
  };
  if (!(await reservePublication(body.idempotency_key, processing))) {
    await saveApproval(approval);
    const duplicate = await loadPublication(body.idempotency_key);
    return NextResponse.json({ duplicate: true, publication: duplicate }, { status: 409 });
  }

  try {
    const vault = await getValidTokenVault();
    if (!vault) throw new Error("TikTok no está conectado o el acceso expiró.");
    if (!vault.scopes.includes("video.publish")) throw new Error("La cuenta no tiene video.publish autorizado.");

    const creator = await callTikTokJson("/v2/post/publish/creator_info/query/", vault.accessToken) as { data?: { privacy_level_options?: string[] } };
    const options = creator.data?.privacy_level_options ?? [];
    const privacy = approval.postInfo.privacy_level;
    if (typeof privacy !== "string" || !options.includes(privacy)) throw new Error("La privacidad solicitada no está permitida por TikTok para este creador.");

    if (approval.source === "FILE_UPLOAD" && !vault.scopes.includes("video.upload")) throw new Error("La cuenta no tiene video.upload autorizado.");
    const payload = await callTikTokJson("/v2/post/publish/video/init/", vault.accessToken, { post_info: approval.postInfo, source_info: approval.sourcePayload });
    const data = (payload as { data?: { publish_id?: string; upload_url?: string } }).data;
    if (!data?.publish_id) throw new Error("TikTok no devolvió publish_id.");
    const completed: PublicationRecord = {
      ...processing,
      status: approval.source === "FILE_UPLOAD" ? "upload_pending" : "submitted",
      publishId: data.publish_id,
      uploadUrl: approval.source === "FILE_UPLOAD" ? data.upload_url : undefined,
    };
    await savePublication(body.idempotency_key, completed);
    return NextResponse.json({ duplicate: false, publication: completed }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await deletePublication(body.idempotency_key);
    await saveApproval(approval);
    const message = error instanceof Error ? error.message : "No se pudo iniciar la publicación.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
