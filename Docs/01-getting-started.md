# 1. Getting Started

This guide takes you from a fresh clone to a running MangoX Core server with an admin account and a first successful API call.

## 1.1 Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **Node.js** | 22.x (the Docker images use 22.19) | Runtime |
| A package manager | npm, pnpm or yarn | The repo ships lockfiles for all three; pick one and stick to it |
| Native build tools | `python3`, `make`, a C/C++ compiler | `bcrypt` and `sharp` compile native code on install |
| **MongoDB** | 5.0+ (standalone or replica set) | Stores all business data (users, content, …) |
| **Redis** | 6+ | **Required.** Holds the runtime copy of the JSON configuration, caches, and BullMQ queues |
| MinIO or S3-compatible storage (e.g. Cloudflare R2) | optional | Only needed for the media/upload endpoints |
| SMTP server | optional | Only needed for e-mail (OTP, password reset, form notifications) |

> **Redis eviction policy.** BullMQ queues require `maxmemory-policy noeviction`. At startup MangoX checks the policy and tries to fix it (`src/utils/redis-eviction-check.ts`). On managed Redis services where `CONFIG SET` is not allowed, set it in your provider's console.

## 1.2 Install

```bash
git clone <your-fork-url> mangox-core
cd mangox-core
npm install          # or: pnpm install / yarn install
```

## 1.3 Configure the environment

MangoX reads its configuration from environment variables (loaded from a `.env` file at the project root via `dotenv`). Create `.env`:

```dotenv
# ── App ───────────────────────────────────────────────────────────────
PORT=5557
NODE_ENV=development
APP_NAME=mangox            # used in Redis keys: schema:<APP_NAME>:...
PREFIX_API=/api/v1         # recommended: keep it equal to /api/v1 (see note below)

# ── Tenant identity ───────────────────────────────────────────────────
TEAM_ID=default-team       # scope for tenant JSON overrides: json/<TEAM_ID>/<TENANT>/
TENANT=my-site

# ── MongoDB ───────────────────────────────────────────────────────────
MONGODB_URL=mongodb://localhost:27017/mangox

# ── Redis ─────────────────────────────────────────────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=
REDIS_DB=0
REDIS_PREFIX=default

# ── Security ──────────────────────────────────────────────────────────
JWT_SECRET=change-me-to-a-long-random-string
RELOAD_TOKEN=change-me-too
```

> **`PREFIX_API`.** The dynamic CRUD routes (the ones driven by your JSON) are always mounted under `/api/v1`. Auth, user, media and admin routes are mounted under `PREFIX_API`. Setting `PREFIX_API=/api/v1` puts everything under one prefix. If you leave it empty, those routes are mounted at the root (`/auth/login`, …).

The complete list of variables is in [Deployment → Environment reference](./09-deployment.md#92-environment-reference).

## 1.4 Connecting to MongoDB

MangoX opens a single `MongoClient` with `MONGODB_URL` and uses **the database named in the URL path** (`mongoClient.db()`):

```
mongodb://<user>:<password>@<host>:<port>/<database>?<options>
                                          ^^^^^^^^^^ this database is used
```

Examples:

```dotenv
# Local, no auth
MONGODB_URL=mongodb://localhost:27017/mangox

# With credentials stored in the admin database
MONGODB_URL=mongodb://app:s3cret@db.internal:27017/mangox?authSource=admin

# Replica set
MONGODB_URL=mongodb://app:s3cret@db1:27017,db2:27017,db3:27017/mangox?replicaSet=rs0&authSource=admin

# MongoDB Atlas
MONGODB_URL=mongodb+srv://app:s3cret@cluster0.abcde.mongodb.net/mangox?retryWrites=true&w=majority
```

Tips:

- If the URL has no database path, the driver falls back to the database `test`.
- Collections are created on first write. The physical collection of an entity is its `mongodb_save_data` (see [Entities](./03-entities.md#33-storage-fields)).
- At startup MangoX creates the unique indexes it needs for slugs (idempotent).
- `IS_REPLICA_SET=true` tells the app it may use transactions. It is not required: dynamic cron jobs do not use change streams.

You can check connectivity before starting the server:

```bash
mongosh "$MONGODB_URL" --eval 'db.runCommand({ ping: 1 })'
```

## 1.5 Connecting to Redis

Redis is mandatory: at boot MangoX loads every JSON file under `json/` into Redis, and every request reads its configuration from there.

```dotenv
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=
REDIS_DB=0                 # pick a dedicated DB number per deployment
REDIS_PREFIX=default       # key prefix for caches
REDIS_TLS=false            # true for rediss:// (most managed Redis offerings)
# REDIS_TLS_INSECURE=true  # skip certificate verification (not recommended)
# REDIS_URL=redis://...    # alternative single-URL form used by some clients
```

Check it:

```bash
redis-cli -h localhost -p 6379 -n 0 PING
redis-cli -h localhost -p 6379 -n 0 CONFIG GET maxmemory-policy   # should be noeviction
```

## 1.6 Connecting to object storage (optional)

Only needed if you use the media endpoints:

```dotenv
STORAGE_MODE=minio
MINIO_ENDPOINT=play.min.io            # or https://<account>.r2.cloudflarestorage.com
MINIO_PORT=9000
MINIO_USE_SSL=true
MINIO_REGION=auto
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_BUCKET_NAME=mangox-media
MINIO_PUBLIC=https://cdn.example.com  # public base URL used to build file links
```

Create the bucket beforehand.

For local development without object storage, store uploads on disk instead:

```dotenv
STORAGE_MODE=local
LOCAL_STORAGE_PATH=./uploads                      # default
LOCAL_STORAGE_PUBLIC_URL=http://localhost:5557/uploads
```

## 1.7 Run the server

```bash
# Development: watch mode with tsx
npm run start:dev

# Development: type-check + nodemon (requires the local binaries in node_modules/.bin)
npm run dev

# Production
npm run build        # compiles src/ → dist/ with tsc
npm start            # node dist/index.js
```

A healthy startup log looks like this:

```
[Core Unified] Loading entity schema (json → Redis)...
[SchemaSync] system/entity: 36
[SchemaSync] system/policy: 60
...
[Core V2] MongoDB connected
[Core V2] Redis cache initialized
[Core V2] Initialization complete!
[SERVER] is running at http://localhost:5557
```

Swagger UI is served at `http://localhost:5557/docs`.

## 1.8 Create the first administrator

There is **no public registration endpoint**. Create the first super administrator directly in MongoDB. Passwords are stored as bcrypt hashes. This one-off script uses the `bcrypt` and `mongodb` packages already installed with the project:

```bash
node -e '
const { MongoClient } = require("mongodb");
const bcrypt = require("bcrypt");
(async () => {
  const client = await new MongoClient(process.env.MONGODB_URL).connect();
  const now = new Date();
  await client.db().collection("user").updateOne(
    { email: "admin@example.com" },
    { $set: {
        email: "admin@example.com",
        username: "admin",
        full_name: "Administrator",
        password: bcrypt.hashSync("ChangeMe!123", 10),
        is_super_admin: true,
        role_system: "admin",
        role_name: "admin",
        is_active: true,
        updated_at: now },
      $setOnInsert: { created_at: now } },
    { upsert: true });
  console.log("admin@example.com / ChangeMe!123");
  await client.close();
})();
'
```

(Run it with your `.env` loaded, e.g. `set -a; source .env; set +a` first.)

`scripts/seed-e2e-user.ts` does the same for an end-to-end test user. Note that it writes to a database named `mangoads` regardless of the URL.

## 1.9 Your first requests

**Log in:**

```bash
curl -s -X POST http://localhost:5557/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"ChangeMe!123"}'
```

The response contains `accessToken` and `refreshToken`. Export the access token:

```bash
export TOKEN=eyJhbGciOi...
```

**List the entities known to the server** (served from the JSON configuration):

```bash
curl -s http://localhost:5557/api/v1/entity -H "Authorization: Bearer $TOKEN"
```

**Create and read a tag.** `tag` is a tenant resource (`is_tenant: true`), so the `x-tenant-id` header is required. Its value partitions the data: every document is stamped with it and every query is filtered by it.

```bash
curl -s -X POST http://localhost:5557/api/v1/tag \
  -H "Authorization: Bearer $TOKEN" -H "x-tenant-id: my-site" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello world","slug":"hello-world"}'

curl -s "http://localhost:5557/api/v1/tag?select=title,slug&order=-created_at" \
  -H "Authorization: Bearer $TOKEN" -H "x-tenant-id: my-site"
```

**Read it anonymously** through the public endpoint (allowed by `policy-tag-guest`):

```bash
curl -s "http://localhost:5557/api/v1/front/tag" -H "x-tenant-id: my-site"
```

## 1.10 Response format

Successful responses are wrapped in an envelope. List endpoints return the rows in `data` together with paging metadata:

```json
{
  "statusCode": 200,
  "data": [ { "_id": "…", "title": "Hello world", "slug": "hello-world" } ],
  "count": 1,
  "pagination": { "...": "..." }
}
```

Errors always have the same shape:

```json
{ "is_err": true, "statusCode": 403, "code": "FORBIDDEN",
  "message": "No policy matches role + resource (access denied)", "data": null }
```

| Status | Typical cause |
|---|---|
| 400 `VALIDATION_FAILED` | Body does not match the entity's `json_schema` (`fields` lists the offending fields) |
| 400 `Resource not found` | No resource/action matches the URL and method |
| 400 `Error tenant` | The resource is a tenant resource and `x-tenant-id` is missing |
| 401 | Missing, expired or revoked token |
| 403 `FORBIDDEN` | No policy matches the caller's role for this resource + action |
| 409 `DUPLICATE_KEY` | A unique index was violated (for example a duplicate slug) |

## Next steps

- Understand the building blocks: [Core concepts](./02-concepts.md)
- Model your own data: [Entities](./03-entities.md)
- Lock it down: [Policies](./05-policies.md)
