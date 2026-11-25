import { NextRequest, NextResponse } from "next/server";
import { isN8nAuthorized } from "@/lib/xaocode/tiktok";
import { hashValue, saveApproval, type StoredApproval } from "@/lib/xaocode/tiktok-store";

export const runtime = "nodejs";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const PRIVACY_LEVELS = new Set(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]);

type ApprovalBody = {
  approval_id?: string;
  approved?: boolean;
  approved_by?: string;
  approved_at?: string;
  expires_at?: string;
  source?: "PULL_FROM_URL" | "FILE_UPLOAD";
  video_url?: string;
  video_size?: number;
  chunk_size?: number;
  total_chunk_count?: number;
  title?: string;
  privacy_level?: string;
  disable_comment?: boolean;
  disable_duet?: boolean;
  disable_stitch?: boolean;
  video_cover_timestamp_ms?: number;
};

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export async function POST(request: NextRequest) {
  if (!isN8nAuthorized(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as ApprovalBody | null;
  if (!body?.approved || !body.approval_id || !ID_PATTERN.test(body.approval_id)) return NextResponse.json({ error: "Se requiere una aprobación explícita con approval_id válido." }, { status: 400 });
  if (!body.approved_by || body.approved_by.length > 160) return NextResponse.json({ error: "approved_by es obligatorio." }, { status: 400 });
  const approvedAt = body.approved_at ? new Date(body.approved_at) : new Date();
  const expiresAt = body.expires_at ? new Date(body.expires_at) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(approvedAt.getTime()) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return NextResponse.json({ error: "Fechas de aprobación inválidas o expiradas." }, { status: 400 });
  if (body.privacy_level && !PRIVACY_LEVELS.has(body.privacy_level)) return NextResponse.json({ error: "privacy_level no permitido." }, { status: 400 });

  const source = body.source ?? "PULL_FROM_URL";
  const sourcePayload = source === "PULL_FROM_URL"
    ? body.video_url && /^https:\/\//i.test(body.video_url) ? { source, video_url: body.video_url } : null
    : positiveInteger(body.video_size) && positiveInteger(body.chunk_size) && positiveInteger(body.total_chunk_count)
      ? { source, video_size: body.video_size, chunk_size: body.chunk_size, total_chunk_count: body.total_chunk_count }
      : null;
  if (!sourcePayload) return NextResponse.json({ error: "Los datos del video no son válidos para el método seleccionado." }, { status: 400 });

  const postInfo = {
    title: typeof body.title === "string" ? body.title.slice(0, 150) : "",
    privacy_level: body.privacy_level ?? "SELF_ONLY",
    disable_comment: body.disable_comment ?? false,
    disable_duet: body.disable_duet ?? false,
    disable_stitch: body.disable_stitch ?? false,
    video_cover_timestamp_ms: body.video_cover_timestamp_ms ?? 0,
  };
  const approval: StoredApproval = {
    approvalId: body.approval_id,
    contentHash: hashValue(JSON.stringify({ sourcePayload, postInfo })),
    approvedBy: body.approved_by,
    approvedAt: approvedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source,
    sourcePayload,
    postInfo,
  };
  await saveApproval(approval);
  return NextResponse.json({ approved: true, approval_id: approval.approvalId, content_hash: approval.contentHash, expires_at: approval.expiresAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
