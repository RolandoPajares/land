# xaoCode + TikTok + n8n

La integración usa rutas server-side de Next.js y almacena el vault cifrado en Redis vía REST. n8n no debe enviar cookies del navegador ni recibir tokens de TikTok.

## Variables de Vercel

Mantén las variables TikTok ya configuradas y confirma también estas variables en Production:

```text
N8N_INTEGRATION_SECRET
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

También se aceptan `KV_REST_API_URL` y `KV_REST_API_TOKEN` como nombres alternativos. El valor de `TIKTOK_REDIRECT_URI` debe ser exactamente:

```text
https://land-rouge-alpha.vercel.app/xaocode/tiktok/callback
```

## Autorización inicial

Abrir en el navegador:

```text
GET https://land-rouge-alpha.vercel.app/xaocode/tiktok/connect
```

El callback guarda el token cifrado en Redis y no lo devuelve:

```text
GET https://land-rouge-alpha.vercel.app/xaocode/tiktok/callback
```

No se deben copiar `code`, `access_token` ni `refresh_token` a n8n, logs, issues o commits.

## Autenticación n8n

Todas las rutas privadas requieren:

```http
Authorization: Bearer {{$env.N8N_INTEGRATION_SECRET}}
```

El secreto se configura como credencial o variable segura dentro de n8n. Nunca se coloca en el JSON del repositorio.

## Consultar conexión

```text
GET /xaocode/tiktok/status
```

Respuesta segura:

```json
{
  "connected": true,
  "openId": "...",
  "scopes": ["user.info.basic", "video.publish", "video.upload"],
  "accessTokenExpiresAt": "2026-11-24T12:00:00.000Z",
  "refreshTokenExpiresAt": null,
  "connectedAt": "2026-11-24T11:00:00.000Z"
}
```

Los tokens nunca aparecen en esta respuesta. La renovación ocurre server-side antes de llamar a TikTok.

## Consultar la cuenta conectada

```text
GET /xaocode/tiktok/n8n/account
```

La ruta consulta `GET https://open.tiktokapis.com/v2/user/info/` con `user.info.basic` y devuelve únicamente la respuesta de perfil autorizada, nunca el access token.

## Consultar opciones del creador

```text
POST /xaocode/tiktok/n8n/creator
```

Body vacío. La respuesta proviene de:

```text
POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/
```

Usa `privacy_level_options`, `max_video_post_duration_sec`, `comment_disabled`, `duet_disabled` y `stitch_disabled` para construir la aprobación del contenido.

## Registrar una aprobación concreta

Antes de publicar, una persona responsable debe aprobar el contenido concreto. n8n registra esa aprobación una sola vez:

```text
POST /xaocode/tiktok/n8n/approvals
```

Ejemplo para `PULL_FROM_URL`:

```json
{
  "approval_id": "aprobacion-20261124-001",
  "approved": true,
  "approved_by": "responsable-xaocode",
  "approved_at": "2026-11-24T12:00:00Z",
  "expires_at": "2026-11-25T12:00:00Z",
  "source": "PULL_FROM_URL",
  "video_url": "https://media.example.com/video.mp4",
  "title": "Contenido aprobado para Sandbox",
  "privacy_level": "SELF_ONLY",
  "disable_comment": false,
  "disable_duet": false,
  "disable_stitch": false,
  "video_cover_timestamp_ms": 0
}
```

La aplicación calcula y guarda `content_hash`. La aprobación queda ligada a la URL, título, privacidad y opciones exactas. No se puede cambiar el contenido después de aprobarlo.

## Iniciar publicación o carga MP4

```text
POST /xaocode/tiktok/n8n/publish
```

Body:

```json
{
  "approval_id": "aprobacion-20261124-001",
  "idempotency_key": "workflow-123-video-001"
}
```

La respuesta `202` contiene un registro sin tokens:

```json
{
  "duplicate": false,
  "publication": {
    "idempotencyKey": "workflow-123-video-001",
    "approvalId": "aprobacion-20261124-001",
    "status": "submitted",
    "publishId": "...",
    "createdAt": "2026-11-24T12:01:00.000Z"
  }
}
```

Para `FILE_UPLOAD`, la aprobación debe contener `video_size`, `chunk_size` y `total_chunk_count`. La respuesta tendrá `status: "upload_pending"` y `uploadUrl`. n8n debe hacer un `PUT` directo a esa URL con `Content-Type: video/mp4` y `Content-Range`; no debe registrar esa URL en logs públicos.

La misma `idempotency_key` no puede iniciar dos publicaciones. TikTok también recibe únicamente la privacidad permitida por `creator_info/query`.

## Consultar el resultado

```text
POST /xaocode/tiktok/n8n/publish/status
```

Body:

```json
{
  "publish_id": "v_pub_file~v2-1.example"
}
```

La ruta consulta:

```text
POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
```

## Desconectar

```text
POST /xaocode/tiktok/disconnect
```

Elimina el vault cifrado local. La revocación remota debe realizarse desde TikTok si la cuenta lo requiere.

## Orden sugerido del workflow n8n

1. `GET /status`.
2. `POST /creator`.
3. Crear aprobación humana del contenido concreto.
4. `POST /approvals`.
5. `POST /publish` con `approval_id` e `idempotency_key`.
6. Si devuelve `upload_pending`, hacer `PUT` del MP4 a `uploadUrl`.
7. Esperar y consultar `POST /publish/status`.

No ejecutar el paso 5 sin una aprobación verificable. En Sandbox, prueba únicamente con `SELF_ONLY` y con archivos de prueba no públicos.
