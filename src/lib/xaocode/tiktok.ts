import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  acquireRefreshLock,
  consumeOAuthState,
  deleteTokenVault,
  loadTokenVault,
  releaseRefreshLock,
  saveOAuthState,
  saveTokenVault,
} from "@/lib/xaocode/tiktok-store";

export const TIKTOK_TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
export const TIKTOK_AUTHORIZE_ENDPOINT = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API_ENDPOINT = "https://open.tiktokapis.com";
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"] as const;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const localRefreshLocks = new Map<string, Promise<TikTokTokenVault>>();

export type TikTokTokenVault = {
  accessToken: string;
  refreshToken: string;
  openId: string;
  scopes: string[];
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number | null;
  connectedAt: number;
};

type TikTokTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  scope?: string;
  expires_in?: number;
  refresh_expires_in?: number;
};

export class TikTokConfigurationError extends Error {}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TikTokConfigurationError(`Falta la variable de entorno ${name}.`);
  return value;
}

export function getTikTokConfig() {
  return {
    clientKey: getRequiredEnv("TIKTOK_CLIENT_KEY"),
    clientSecret: getRequiredEnv("TIKTOK_CLIENT_SECRET"),
    redirectUri: getRequiredEnv("TIKTOK_REDIRECT_URI"),
    encryptionKey: getRequiredEnv("TIKTOK_TOKEN_ENCRYPTION_KEY"),
  };
}

export function getN8nSecret(): string {
  return getRequiredEnv("N8N_INTEGRATION_SECRET");
}

export function createOAuthState(): string {
  return randomBytes(32).toString("hex");
}

export async function saveOAuthStateForCallback(state: string): Promise<void> {
  await saveOAuthState(state);
}

export async function consumeOAuthStateForCallback(state: string): Promise<boolean> {
  return consumeOAuthState(state);
}

export function buildTikTokAuthorizationUrl(state: string): string {
  const { clientKey, redirectUri } = getTikTokConfig();
  const url = new URL(TIKTOK_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(getTikTokConfig().encryptionKey, "utf8").digest();
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function encryptTokenVault(vault: TikTokTokenVault): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(vault), "utf8"), cipher.final()]);
  return [encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join(".");
}

export function decryptTokenVault(value: string): TikTokTokenVault | null {
  try {
    const [ivValue, tagValue, encryptedValue] = value.split(".");
    if (!ivValue || !tagValue || !encryptedValue) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), decode(ivValue));
    decipher.setAuthTag(decode(tagValue));
    const plaintext = Buffer.concat([decipher.update(decode(encryptedValue)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<TikTokTokenVault>;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.openId || !Array.isArray(parsed.scopes)) return null;
    if (typeof parsed.accessTokenExpiresAt !== "number" || typeof parsed.connectedAt !== "number") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      openId: parsed.openId,
      scopes: parsed.scopes.filter((scope): scope is string => typeof scope === "string"),
      accessTokenExpiresAt: parsed.accessTokenExpiresAt,
      refreshTokenExpiresAt: typeof parsed.refreshTokenExpiresAt === "number" ? parsed.refreshTokenExpiresAt : null,
      connectedAt: parsed.connectedAt,
    };
  } catch {
    return null;
  }
}

function vaultTtl(vault: TikTokTokenVault): number {
  return vault.refreshTokenExpiresAt
    ? Math.max(60, Math.floor((vault.refreshTokenExpiresAt - Date.now()) / 1000))
    : 60 * 60 * 24 * 30;
}

export async function persistTokenVault(vault: TikTokTokenVault): Promise<void> {
  await saveTokenVault(encryptTokenVault(vault), Math.min(vaultTtl(vault), 60 * 60 * 24 * 180));
}

export async function getStoredTokenVault(): Promise<TikTokTokenVault | null> {
  const ciphertext = await loadTokenVault();
  return ciphertext ? decryptTokenVault(ciphertext) : null;
}

export async function disconnectStoredTokenVault(): Promise<void> {
  await deleteTokenVault();
}

export async function exchangeAuthorizationCode(code: string): Promise<TikTokTokenResponse> {
  const { clientKey, clientSecret, redirectUri } = getTikTokConfig();
  const response = await fetch(TIKTOK_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as TikTokTokenResponse;
  if (!response.ok || !payload.access_token || !payload.refresh_token || !payload.open_id) throw new Error("TikTok no devolvió tokens válidos.");
  return payload;
}

export async function refreshTikTokToken(vault: TikTokTokenVault): Promise<TikTokTokenVault> {
  const { clientKey, clientSecret } = getTikTokConfig();
  const response = await fetch(TIKTOK_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: vault.refreshToken }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as TikTokTokenResponse;
  if (!response.ok || !payload.access_token || !payload.refresh_token) throw new Error("No se pudo renovar el acceso de TikTok.");
  const refreshed = {
    ...vault,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessTokenExpiresAt: Date.now() + (payload.expires_in ?? 0) * 1000,
    refreshTokenExpiresAt: payload.refresh_expires_in ? Date.now() + payload.refresh_expires_in * 1000 : vault.refreshTokenExpiresAt,
  };
  await persistTokenVault(refreshed);
  return refreshed;
}

export async function getValidTokenVault(): Promise<TikTokTokenVault | null> {
  const vault = await getStoredTokenVault();
  if (!vault) return null;
  if (vault.accessTokenExpiresAt - Date.now() > REFRESH_WINDOW_MS) return vault;
  const lockKey = createHash("sha256").update(vault.refreshToken, "utf8").digest("hex");
  const localLock = localRefreshLocks.get(lockKey);
  if (localLock) return localLock.catch(() => null);
  const refreshPromise = refreshWithDistributedLock(vault);
  localRefreshLocks.set(lockKey, refreshPromise);
  try {
    return await refreshPromise;
  } catch {
    return null;
  } finally {
    localRefreshLocks.delete(lockKey);
  }
}

async function refreshWithDistributedLock(vault: TikTokTokenVault): Promise<TikTokTokenVault> {
  const lockValue = await acquireRefreshLock(vault.refreshToken);
  if (lockValue) {
    try {
      return await refreshTikTokToken(vault);
    } finally {
      await releaseRefreshLock(vault.refreshToken, lockValue);
    }
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    const latest = await getStoredTokenVault();
    if (latest && latest.accessToken !== vault.accessToken && latest.accessTokenExpiresAt > Date.now()) return latest;
  }
  throw new Error("Otra instancia está renovando el token.");
}

export function isN8nAuthorized(request: NextRequest): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expected = process.env.N8N_INTEGRATION_SECRET?.trim();
  if (!expected || !provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function vaultToPublicStatus(vault: TikTokTokenVault) {
  return {
    connected: true,
    openId: vault.openId,
    scopes: vault.scopes,
    accessTokenExpiresAt: new Date(vault.accessTokenExpiresAt).toISOString(),
    refreshTokenExpiresAt: vault.refreshTokenExpiresAt ? new Date(vault.refreshTokenExpiresAt).toISOString() : null,
    connectedAt: new Date(vault.connectedAt).toISOString(),
  };
}

export async function callTikTokJson(path: string, accessToken: string, body?: unknown) {
  const response = await fetch(`${TIKTOK_API_ENDPOINT}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("TikTok rechazó la solicitud.");
  return payload;
}

export async function callTikTokGet(path: string, accessToken: string) {
  const response = await fetch(`${TIKTOK_API_ENDPOINT}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("TikTok rechazó la consulta.");
  return payload;
}
