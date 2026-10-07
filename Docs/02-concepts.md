# 2. Core Concepts & Architecture

## 2.1 The six building blocks

Everything MangoX exposes is described by JSON documents of six types. Each type lives in its own folder:

| Type | Folder | Answers the question | Example |
|---|---|---|---|
| **Entity** | `entity/` | *What does the data look like and where is it stored?* | `tag`: fields `title`, `slug`, `tag_group`; stored in collection `tag` |
| **Resource** | `resource/` | *Which URL segment exposes it?* | `/api/v1/tag` |
| **Action** | `action/` | *Which HTTP method + sub-path is an operation?* | `list` = `GET /`, `read` = `GET /:id`, `approve` = `PATCH /:id/approve` |
| **Role** | `role/` | *Who is the caller?* | `admin`, `guest`, `editor`, … |
| **Policy** | `policy/` | *May this role run this action on this resource, and with which filters/fields?* | `admin` may `list/read/create/update/delete` `tag`, sees `created_by(username,full_name)` |
| **Setting** | `setting/` | *Which policy should apply, based on data?* | "use `policy-team-read-full` if my membership role is `admin`, otherwise `policy-team-read-basic`" |

Their relationships:

```
                ┌──────────┐ 1   n ┌──────────┐
   URL  ───────►│ resource │──────►│  entity  │◄──── json_schema, relations, plugins
                └────┬─────┘       └──────────┘
                     │ matched with
                ┌────▼─────┐
 method+path ──►│  action  │
                └────┬─────┘
                     │ (resource, action, role)
                ┌────▼─────┐   optional   ┌──────────┐
   JWT role ───►│  policy  │◄─────────────│ setting  │
                └────┬─────┘   picks one  └──────────┘
                     │ root_entity, condition, data, …
                     ▼
               MongoDB query
```

## 2.2 JSON layout and scopes

```
json/
├── system/                      ← scope "system": shared defaults shipped with the code
│   ├── action/<slug>.json
│   ├── entity/<collection_name>.json
│   ├── policy/<slug>.json
│   ├── resource/<slug>.json
│   ├── role/<slug>.json
│   └── setting/<slug>.json
└── <TEAM_ID>/<TENANT>/          ← scope "<TEAM_ID>/<TENANT>": per-tenant overrides
    ├── entity/…
    ├── policy/…
    └── …
```

- The file name is the item's key: `collection_name` for entities, `slug` for everything else.
- A tenant item **replaces** the system item with the same key. Everything else is inherited from `system`.
- Items created or edited through the admin API are written **copy-on-write** into the tenant folder. Files under `json/system/` are never modified by the API, and a tenant cannot delete a system item (403).
- Other recognised types: `collection`, `code`, `form`, `rule`, `form-setting`, `api-config`.

### From files to Redis

1. At startup `schemaSync.bootstrap()` flushes the `schema:<APP_NAME>:*` keys and loads every JSON file into Redis:
   - `schema:<APP_NAME>:global:<type>` for `system`
   - `schema:<APP_NAME>:tenant:<TEAM_ID>/<TENANT>:<type>` for tenant scopes
2. Requests read the configuration from Redis (with an in-process cache in front).
3. Changes made **through the API** (`POST/PUT/DELETE /api/v1/<type>`) are written to the JSON file *and* pushed to Redis immediately. No restart is needed.
4. Changes made **by editing files by hand** are only picked up after a **restart**: the file watcher is intentionally disabled.
5. `POST /api/v1/admin/reload` reloads the in-memory entity cache from Redis. Use it when another process has rewritten the Redis keys. See [Deployment](./09-deployment.md#95-reloading-the-configuration).

## 2.3 Identities and roles

A request is executed with a **list of roles**:

| Caller | Roles used for policy matching |
|---|---|
| Anonymous call to `/api/v1/front/*` | `["guest"]`. A token is ignored on these routes |
| Authenticated user | `[user.role_name]` taken from the JWT (for example `"admin"`, `"editor"`, `"user"`) |
| Super administrator (`is_super_admin: true` or `role_system: "admin"`) | `["super_admin", "admin"]`, and the **super-admin bypass** applies (see below) |
| Authenticated, no role at all | `["default"]` |

Tokens are verified by `src/module/_auth/guards/jwt.guard.ts`:

- **HS256** tokens signed with `JWT_SECRET`. These are issued by `POST /auth/login`.
- **RS256** tokens signed by an external identity provider (SSO), verified with `SSO_PUBLIC_KEY` / `SSO_PUBLIC_KEY_PATH`. If such a token carries a `tenant_id` that differs from `TENANT`, it is rejected unless the user is a system admin.
- Revoked tokens (logout, "revoke all sessions") are rejected through a Redis blacklist.

Roles are free-form strings. `json/system/role/*.json` only lists them for admin UIs. What a role can do is defined entirely by the policies that mention it.

**Super-admin bypass.** For a super administrator no policy *has* to match. The engine still borrows the highest-priority policy written for role `admin` on that resource, to reuse its `select` (joins). Its row filters are applied as well, which matters for policies that use `@context` filters (see [Known issues](./10-known-issues.md)).

## 2.4 Request lifecycle

Take `GET /api/v1/tag?title=ilike.news` as an example:

1. **Route.** The wildcard controller (`src/module/common_v2/common.ts`) receives the request. Public calls under `/api/v1/front/*` go through `src/module/_front/front.controller.ts` instead.
2. **Authenticate.** The JWT guard verifies the token and builds the role list.
3. **Resolve resource + action** (`loadAction`, `src/module/_setting/setting-mode.ts`):
   - The first path segment (`tag`) is looked up among resources (tenant first, then system).
   - The method and the rest of the path are matched against every action's `method` + `path`: `GET` + `/` gives `list`.
   - Authenticated routes only match actions with `auth: true`; `/front/*` only matches actions with `auth: false`.
4. **Tenant check.** If the resource has `is_tenant: true`, the `x-tenant-id` header is required. Its value is injected into the body on writes and added as a `tenant_id` filter on every read, update, delete and join.
5. **Defaults.** For list calls `limit` defaults to `10`, `page` is converted to `skip`, and the default order is `-created_at,-updated_at,-timestamp,-_id`.
6. **Policy** (`builderQuery`, `src/module/common_v2/helper/builder.ts`):
   1. If a **setting** exists for (resource, action, first role), its dispatcher may pin a specific policy.
   2. Candidate **policies** = those whose `resource`, `action` and `role` all match, sorted by `piority` (highest first).
   3. For each candidate: run its `data` context queries and its `code_context`, then evaluate `condition_context`. **The first policy that passes wins.**
   4. If none passes: **403 Forbidden**.
   5. Writes: the body is checked against `condtion_body` (and an optional `form`).
   6. Reads, updates and deletes: the policy's `condition` is merged into the client query. The policy's `select` replaces the client's, and its filters are ANDed.
7. **Execute.** The query runs against the policy's `root_entity`. The core service:
   - applies the entity's `json_schema` (validation and field filtering on writes, projection on reads);
   - builds the aggregation pipeline (filters, `$lookup` joins, sort, paging);
   - runs the entity's plugins.
8. **Post-process.** The optional policy `code` hook may transform the result, and an optional `trigger` may fire.
9. **Respond** with the standard envelope.

## 2.5 What runs where

| Concern | Code |
|---|---|
| Boot, MongoDB/Redis connection | `src/index.ts`, `src/configs/core/unified.ts`, `src/configs/core/bootstrap.ts` |
| JSON files ↔ Redis | `src/core_v2/store/json-store.ts`, `src/core_v2/store/schema-sync.ts`, `src/core_v2/schema/manager.ts` |
| Admin CRUD of JSON configuration | `src/module/_setting/setting.controller.ts`, `setting.adapter.ts` |
| Resource/action/policy/setting lookup | `src/module/_setting/setting-mode.ts` |
| Policy engine | `src/module/common_v2/helper/builder.ts`, `excute.ts`, `helper.ts`, `condition.ts` |
| Query language → intermediate query | `src/core_v2/query/converter.ts` |
| Intermediate query → MongoDB pipeline | `src/core_v2/adapters/mongodb/` |
| Validation (AJV), field filtering | `src/core_v2/schema/validator.ts`, `src/core_v2/authorization/authorization.ts` |
| Relations | `src/core_v2/schema/loader.ts`, `src/core_v2/adapters/base/relationship-registry.ts` |
| Plugins | `src/core_v2/plugins/definitions/*.plugin.ts` |

## 2.6 Database adapters

Each entity chooses its adapter with `databaseType`:

| Value | Status | Notes |
|---|---|---|
| `mongodb` | ✅ supported | The default. Every shipped entity uses it |
| `rest` | ✅ supported | Proxies the entity to an external REST API described by an `api-config` record (`api_config` on the entity). Filtering, select, sort and paging are passed through according to that config's `capabilities` |

> SQLite or SQL backends are **not** available in this version. Some comments still mention SQLite, but no SQL adapter is registered.
