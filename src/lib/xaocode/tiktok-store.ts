import { createHash, randomBytes } from "node:crypto";

const TOKEN_KEY = "xaocode:tiktok:account:v1";
const STATE_PREFIX = "xaocode:tiktok:oauth-state:v1:";
const APPROVAL_PREFIX = "xaocode:tiktok:approval:v1:";
const PUBLICATION_PREFIX = "xaocode:tiktok:publication:v1:";
const LOCK_PREFIX = "xaocode:tiktok:lock:v1:";

export type StoredApproval = {
  approvalId: string;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  source: "PULL_FROM_URL" | "FILE_UPLOAD";
  sourcePayload: Record<string, unknown>;
  postInfo: Record<string, unknown>;
};

export type PublicationRecord = {
  idempotencyKey: string;
  contentHash: string;
  approvalId: string;
  status: "processing" | "upload_pending" | "submitted";
  publishId?: string;
  uploadUrl?: string;
  createdAt: string;
};

export class TikTokStorageConfigurationError extends Error {}

function storageConfig() {
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL)?.trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)?.trim();
  if (!url || !token) {
    throw new TikTokStorageConfigurationError(
      "Faltan UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN (o sus alias KV_REST_API_URL/KV_REST_API_TOKEN).",
    );
  }
  return { url: url.replace(/\/$/, ""), token };
}

async function command<T>(parts: unknown[]): Promise<T> {
  const { url, token } = storageConfig();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(parts),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error("El almacenamiento seguro no respondió correctamente.");
  return payload.result as T;
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function saveTokenVault(ciphertext: string, ttlSeconds: number): Promise<void> {
  await command(["SET", TOKEN_KEY, ciphertext, "EX", Math.max(60, ttlSeconds)]);
}

export async function loadTokenVault(): Promise<string | null> {
  return command<string | null>(["GET", TOKEN_KEY]);
}

export async function deleteTokenVault(): Promise<void> {
  await command(["DEL", TOKEN_KEY]);
}

export async function saveOAuthState(state: string): Promise<void> {
  await command(["SET", `${STATE_PREFIX}${hashValue(state)}`, "1", "EX", 600]);
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const result = await command<string | null>(["GETDEL", `${STATE_PREFIX}${hashValue(state)}`]);
  return result === "1";
}

export async function saveApproval(approval: StoredApproval): Promise<void> {
  await command(["SET", `${APPROVAL_PREFIX}${approval.approvalId}`, JSON.stringify(approval), "EX", 86400]);
}

export async function loadApproval(approvalId: string): Promise<StoredApproval | null> {
  const value = await command<string | null>(["GET", `${APPROVAL_PREFIX}${approvalId}`]);
  return value ? (JSON.parse(value) as StoredApproval) : null;
}

export async function consumeApproval(approvalId: string): Promise<StoredApproval | null> {
  const value = await command<string | null>(["GETDEL", `${APPROVAL_PREFIX}${approvalId}`]);
  return value ? (JSON.parse(value) as StoredApproval) : null;
}

export async function reservePublication(idempotencyKey: string, record: PublicationRecord): Promise<boolean> {
  const result = await command<string | number>([
    "SET",
    `${PUBLICATION_PREFIX}${hashValue(idempotencyKey)}`,
    JSON.stringify(record),
    "EX",
    86400,
    "NX",
  ]);
  return result === "OK" || result === 1;
}

export async function loadPublication(idempotencyKey: string): Promise<PublicationRecord | null> {
  const value = await command<string | null>(["GET", `${PUBLICATION_PREFIX}${hashValue(idempotencyKey)}`]);
  return value ? (JSON.parse(value) as PublicationRecord) : null;
}

export async function savePublication(idempotencyKey: string, record: PublicationRecord): Promise<void> {
  await command(["SET", `${PUBLICATION_PREFIX}${hashValue(idempotencyKey)}`, JSON.stringify(record), "EX", 86400]);
}

export async function deletePublication(idempotencyKey: string): Promise<void> {
  await command(["DEL", `${PUBLICATION_PREFIX}${hashValue(idempotencyKey)}`]);
}

export async function acquireRefreshLock(refreshToken: string): Promise<string | null> {
  const lockValue = cryptoRandomId();
  const result = await command<string | number>([
    "SET",
    `${LOCK_PREFIX}${hashValue(refreshToken)}`,
    lockValue,
    "EX",
    30,
    "NX",
  ]);
  return result === "OK" || result === 1 ? lockValue : null;
}

export async function releaseRefreshLock(refreshToken: string, lockValue: string): Promise<void> {
  const key = `${LOCK_PREFIX}${hashValue(refreshToken)}`;
  await command(["EVAL", "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, lockValue]);
}

function cryptoRandomId(): string {
  return randomBytes(16).toString("hex");
}
