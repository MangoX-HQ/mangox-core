# MangoX Core

MangoX Core is a **configuration-driven API server for MongoDB**. You describe your data model and access rules in JSON files; MangoX turns them into a REST API with fine-grained, per-role policies — no controller code required.

It follows the spirit of [PostgREST](https://postgrest.org) (a URL query language for filtering, selecting and joining), but is built for MongoDB:

- **Entities** — collections, fields, validation and relations declared in JSON, editable at runtime through the API
- **Policies** — per role × resource × action, with row filters, field whitelists, joins, context lookups, body validation and post-processing hooks
- **Query language** — `select`, joins (`select=*,author(name)`), filter operators, `and`/`or`, ordering, pagination
- **Built-in plugins** — slugs/SEO paths, multi-language records, trees, content blocks, approval workflow, history, soft delete, timestamps
- **Multi-tenant** — per-tenant configuration overrides and data partitioned by the `x-tenant-id` header

Under the hood it is a [Fastify](https://fastify.dev) app: the JSON configuration is cached in **Redis**, and every request is turned into a **MongoDB** aggregation pipeline after the matching policy is applied.

📖 **Full documentation:** https://oss-nine.vercel.app

## Requirements

- Node.js 22.x
- MongoDB 5.0+
- Redis 6+ with `maxmemory-policy noeviction` (required: configuration cache and BullMQ queues)
- Native build tools (`python3`, `make`, a C/C++ compiler) for `bcrypt` and `sharp`
- Optional: MinIO / S3-compatible storage (media uploads), SMTP (e-mail)

## Quick start

```bash
npm install          # or pnpm install / yarn install — pick one
```

Create a `.env` at the project root:

```dotenv
PORT=5557
NODE_ENV=development
APP_NAME=mangox
PREFIX_API=/api/v1

TEAM_ID=default-team
TENANT=my-site

MONGODB_URL=mongodb://localhost:27017/mangox

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=
REDIS_DB=0
REDIS_PREFIX=default

JWT_SECRET=change-me-to-a-long-random-string
RELOAD_TOKEN=change-me-too
```

The server loads its configuration from a `json/` folder at the project root (`json/system/{entity,resource,action,policy,role,setting}/*.json`, plus per-tenant overrides in `json/<TEAM_ID>/<TENANT>/`). That folder is not part of this repository — provide it before starting (the Docker setup mounts it as a volume).

```bash
npm run start:dev    # watch mode (tsx)
```

The API listens on `http://localhost:5557`, with Swagger UI at `/docs`.

See [Getting started](https://oss-nine.vercel.app/getting-started) for creating the first administrator and making your first calls, and [Deployment](https://oss-nine.vercel.app/deployment) for the full environment reference.

## Scripts

| Command | Description |
|---|---|
| `npm run start:dev` | Development server with watch mode (`tsx`) |
| `npm run dev` | Type-check in watch mode + `nodemon` |
| `npm run build` | Compile `src/` → `dist/` with `tsc` |
| `npm start` | Run the compiled server (`dist/index.js`) |
| `npm test` | Run the Jest test suite (`test:watch`, `test:coverage` also available) |
| `npm run security-check` | Static analysis with Semgrep (TypeScript, OWASP Top 10, secrets) |

## Docker

```bash
docker build -t mangox-core .
docker run --env-file .env -v "$PWD/json:/app/json" -p 5557:5557 mangox-core
```

`docker/` contains the compose file, base/dev images and `single-tenant.env.example`; `Dockerfile.single-tenant` builds an image for a single tenant whose schema is pre-seeded in Redis.

## Project layout

```
src/
├── index.ts          # entry point
├── configs/          # boot, MongoDB/Redis connection
├── core_v2/          # engine: schema store, query converter, adapters, plugins, validation
├── module/
│   ├── common_v2/    # configuration-driven CRUD controller + policy engine
│   ├── _front/       # public (/api/v1/front/*) routes
│   ├── _auth/        # login, JWT guard, SSO
│   ├── _setting/     # admin CRUD of the JSON configuration
│   ├── _media/       # uploads (MinIO / local)
│   └── …             # user, cron, approval, analytics, MCP, …
├── middleware/  routes/  jobs/  utils/
```

## Documentation

| Topic | |
|---|---|
| [Core concepts](https://oss-nine.vercel.app/concepts) | Entity, resource, action, policy, role, setting; request lifecycle |
| [Entities](https://oss-nine.vercel.app/entities) | Fields, validation, relations, plugins |
| [Resources & actions](https://oss-nine.vercel.app/resources-and-actions) | How URLs map to operations |
| [Policies](https://oss-nine.vercel.app/policies) | Full access-control reference |
| [Query language](https://oss-nine.vercel.app/query-language) | Filters, joins, ordering, pagination |
| [Recipes](https://oss-nine.vercel.app/recipes) | Step-by-step examples |
| [Known issues](https://oss-nine.vercel.app/known-issues) | Current limitations |

## License

MIT
