# 9. Deployment

## 9.1 Deployment model

One MangoX process serves **one tenant scope** (`TEAM_ID` + `TENANT`), with its own MongoDB database and its own Redis database:

```
                 ┌────────────────────────────────────────────┐
  clients ──────►│  MangoX Core (Node.js / Fastify)  :PORT     │
                 │   json/ (mounted)  ──boot──►  Redis         │
                 └───────┬───────────────┬───────────────┬────┘
                         ▼               ▼               ▼
                     MongoDB          Redis       MinIO / S3 / R2 (optional)
```

At **startup** the server:

1. Checks the Redis eviction policy.
2. Flushes the `schema:<APP_NAME>:*` keys and loads every JSON file from `json/` into Redis.
3. Connects to MongoDB, builds the relationship registry and plugins, and ensures slug indexes.
4. Starts listening on `PORT` (`0.0.0.0`).

> **The `json/` directory must be available at runtime** (at `<app>/json`). Step 2 wipes the configuration keys in Redis first. A container started without `json/` therefore runs with an **empty configuration**. Mount it (as `docker/docker-compose.yml` does) or copy it into the image.

## 9.2 Environment reference

### Application

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `PORT` | ✅ | `3000` | HTTP port |
| `NODE_ENV` | | — | `production` disables test routes |
| `APP_NAME` | ✅ | `THAILY` | Namespace of the Redis schema keys (`schema:<APP_NAME>:…`). Use a unique value per deployment sharing a Redis DB |
| `PREFIX_API` | recommended | — | Prefix of auth/user/media/admin routes. Use `/api/v1` |
| `TEAM_ID` | | — | First part of the tenant scope (`json/<TEAM_ID>/<TENANT>/`) |
| `TENANT` (or `TENANT_SLUG`) | | — | Tenant slug. SSO tokens for another tenant are rejected |
| `TIME_ZONE` | | — | Time zone used for date handling |
| `DEBUG` | | `false` | `true` prints detailed engine traces |
| `CRON_JOB` | | — | `true` enables dynamic cron jobs (the `cron-job` collection; reload with `POST /cron/reload`) |
| `UPLOAD_MAX_FILE_SIZE_MB` | | `50` | Upload size limit |

### MongoDB

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `MONGODB_URL` | ✅ | `mongodb://localhost:27017/mangoads` | Connection string. **The database in the URL path is used** |
| `IS_REPLICA_SET` | | `false` | Set `true` on replica sets / Atlas |

### Redis

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `REDIS_HOST` | ✅ | `localhost` | |
| `REDIS_PORT` | ✅ | `6379` | |
| `REDIS_USERNAME` | | `default` | |
| `REDIS_PASSWORD` | | empty | |
| `REDIS_DB` | ✅ | `0` | Use a dedicated DB number per deployment |
| `REDIS_PREFIX` | | `default` | Key prefix for caches |
| `REDIS_PREFIX_JSON` | | `REDIS_PREFIX` | Key prefix for JSON caches |
| `REDIS_TLS` | | `false` | `true` for TLS (`rediss://`) |
| `REDIS_TLS_INSECURE` | | `false` | Skip certificate verification |
| `REDIS_URL` | | — | Single-URL alternative used by some clients |
| `REDIS_CACHE_TTL` | | `3600` | Query cache TTL in seconds |

### Authentication

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `JWT_SECRET` | ✅ | empty | HS256 signing secret for tokens issued by `/auth/login`. **Use a long random value** |
| `SSO_PUBLIC_KEY` | | — | PEM public key (`\n`-escaped) to verify RS256 tokens issued by an external identity provider |
| `SSO_PUBLIC_KEY_PATH` | | — | Alternative: path to the PEM file |
| `RELOAD_TOKEN` | recommended | — | Shared secret for `POST /admin/reload` (header `x-reload-token`) |
| `TOKEN_REVOKE_TTL` | | `604800` | Seconds a revoked token stays blacklisted |
| `OTP_TTL_SECONDS`, `OTP_LENGTH`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN`, `OTP_RATELIMIT_WINDOW`, `OTP_RATELIMIT_MAX` | | `OTP_TTL_SECONDS=300` | One-time password settings |
| `GOOGLE_CLIENT_ID` | | — | Enables `POST /auth/google` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | | — | Enable `POST /auth/github` |

### Media storage

| Variable | Default | Description |
|---|---|---|
| `STORAGE_MODE` | `minio` | `minio` (any S3-compatible service) or `local` |
| `LOCAL_STORAGE_PATH` | `./uploads` | With `local` |
| `LOCAL_STORAGE_PUBLIC_URL` | — | Public base URL of local files |
| `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL` (`true`), `MINIO_REGION` (`auto`) | | Endpoint |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | | Credentials |
| `MINIO_BUCKET_NAME` | | Main bucket |
| `MINIO_PUBLIC` | | Public base URL used to build file links |
| `MINIO_COMPRESS_BUCKET_NAME`, `MINIO_COMPRESS_WEBP_QUALITY` (`80`), `MINIO_COMPRESS_SIZES`, `MINIO_GENERATE_THUMB`, `MINIO_THUMB_SIZE` (`200`), `MINIO_REGENERATE_ON_UPLOAD` | | Image compression queue |
| `MINIO_CV_BUCKET_NAME`, `MINIO_CV_PUBLIC` | | Bucket for private documents |

### Mail and integrations

| Variable | Default | Description |
|---|---|---|
| `MAIL_HOST`, `MAIL_PORT` (`587`), `MAIL_FROM`, `MAIL_PASSWORD` | `localhost` | SMTP fallback. Per-tenant SMTP can also be stored in the `config-settings` entity |
| `CORE_B_URL`, `CORE_B_API_KEY` | — | Default target of the `rest` adapter |
| `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN` | — | Cache purge integration |

## 9.3 Docker

The repository ships two Dockerfiles:

| File | Package manager | Image contents | Default port |
|---|---|---|---|
| `Dockerfile` | pnpm | the whole project (including `json/`) | 3000 |
| `Dockerfile.single-tenant` | yarn | `dist/`, `node_modules/`, `package.json` only | 5557 |

Build:

```bash
docker build -f Dockerfile.single-tenant -t mangox-core:latest .
```

Run. Note the `json/` mount, and that the port matches `PORT`:

```bash
cp docker/single-tenant.env.example .env.production    # then fill in the values
docker run -d --name mangox \
  --env-file .env.production \
  -v "$(pwd)/json:/app/json:ro" \
  -p 5557:5557 \
  --restart unless-stopped \
  mangox-core:latest
docker logs -f mangox
```

`:ro` is fine if you only change the configuration through Git and restarts. Drop it if admins edit the configuration through the API, because the API writes JSON files.

With Compose (`docker/docker-compose.yml`, adjust image and ports):

```yaml
services:
  mangox:
    image: mangox-core:latest
    env_file: ../.env
    ports: ["5557:5557"]
    volumes:
      - ../json:/app/json
    restart: unless-stopped
```

Publishing to a registry: `docker/push.ghcr.sh` builds and pushes to GitHub Container Registry (`GHCR_USER` + `CR_PAT` with `write:packages`; `PLATFORM=linux/amd64,linux/arm64` for multi-arch).

## 9.4 Running several tenants

Run one container per tenant, each with its own `.env`:

- a different `TENANT` (and optionally `TEAM_ID`), a different `PORT` or host port;
- its own `MONGODB_URL` database;
- its own `REDIS_DB`, **or** a distinct `APP_NAME` if several tenants share one Redis DB. The startup flush deletes `schema:<APP_NAME>:*`, so two deployments with the same `APP_NAME` and DB would erase each other's configuration.

Tenant-specific configuration goes into `json/<TEAM_ID>/<TENANT>/…` and overrides `json/system/`.

## 9.5 Reloading the configuration

| You changed… | Do |
|---|---|
| Configuration through the admin API (`/api/v1/policy`, …) | Nothing: it is live immediately |
| JSON files on disk | Restart the process/container |
| Redis keys directly (another process rewrote them) | `POST /api/v1/admin/reload` |

```bash
curl -X POST http://<host>:5557/api/v1/admin/reload -H "x-reload-token: $RELOAD_TOKEN"
# or with a super-admin JWT: -H "Authorization: Bearer <token>"
# → { "message": "Schema reloaded from Redis", "scope": "<TEAM_ID>/<TENANT>", "cache_flushed": …, "took_ms": … }
```

Check what is in Redis:

```bash
redis-cli -h <host> -p <port> -a <password> -n <REDIS_DB> KEYS 'schema:<APP_NAME>:*'
```

## 9.6 External identity provider (SSO)

MangoX can trust tokens issued by another service (an admin studio, an identity provider):

1. The provider signs **RS256** JWTs with its private key. The payload includes `sub`/`id`, `email`, `role_system`, `role_name` and `tenant_id`.
2. MangoX verifies them with `SSO_PUBLIC_KEY` (or `SSO_PUBLIC_KEY_PATH`).
3. A token whose `tenant_id` is not `TENANT` is rejected unless the user is a system admin.

HS256 tokens from `/auth/login` keep working alongside.

## 9.7 Production checklist

- [ ] `NODE_ENV=production`
- [ ] Strong, unique `JWT_SECRET` and `RELOAD_TOKEN`
- [ ] MongoDB with authentication and TLS; least-privilege user on the app database only
- [ ] Redis with a password, a dedicated DB number, and `maxmemory-policy noeviction`
- [ ] `json/` mounted (or baked into the image) and under version control
- [ ] Every public (`guest`) policy reviewed: field whitelists, publication filters
- [ ] The `code` resource restricted to super administrators (code records run unsandboxed)
- [ ] Reverse proxy terminating TLS in front of the app (Fastify is started with `trustProxy: true`)
- [ ] CORS reviewed (the default allows every origin)
- [ ] `/docs` (Swagger UI) exposed only if intended
