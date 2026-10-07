# 4. Resources & Actions

MangoX does **not** generate one route per resource. Two wildcard controllers receive every request and resolve it at runtime:

| Prefix | Controller | Authentication | Roles used |
|---|---|---|---|
| `/api/v1/<resource>/…` | `src/module/common_v2/common.ts` | JWT required | the caller's roles |
| `/api/v1/front/<resource>/…` | `src/module/_front/front.controller.ts` | none | always `guest` |

Resolution:

1. The **first path segment** selects the **resource** (by its key or `slug`; tenant scope first, then system).
2. The **HTTP method + remaining path** select the **action**: an action matches when its `method` equals the request method and `[resource, ...action.path]` matches the URL segment by segment (`:name` captures a parameter).
   - Authenticated routes only consider actions with `auth: true`.
   - `/front` routes only consider actions with `auth: false`.
3. The (resource, action, roles) triple selects the [policy](./05-policies.md).

## 4.1 Resources

Location: `json/system/resource/<slug>.json`.

```json
{
  "title": "tag",
  "slug": "tag",
  "entity": ["tag"],
  "is_tenant": true,
  "action": ["list", "read", "create", "update", "delete"],
  "main": true,
  "description": "Content tags"
}
```

| Field | Kind | Description |
|---|---|---|
| `slug` | **engine** | URL segment: `/api/v1/<slug>` |
| `is_tenant` | **engine** | If `true`, every request must send `x-tenant-id`. The value is stamped on written documents as `tenant_id` and every read, update, delete and join is filtered by it. Missing header → `400 Error tenant` |
| `entity` | documentation | Entities served by the resource. The collection actually queried is the policy's `root_entity` |
| `action` | documentation | Actions offered by the resource. **Not enforced**: any action can be used on any resource, and **the policy is the only gate**. Keep the list accurate for admin UIs and humans |
| `title`, `description`, `main`, `is_base`, `mongorest` | UI | Not read by the engine |

> Because `action` is not enforced, never write a policy granting an action you do not want exposed. Granting `list-public` to `guest` makes `GET /api/v1/front/<resource>` public, whether or not the resource lists that action.

## 4.2 Actions

Location: `json/system/action/<slug>.json`. Actions are global and shared by every resource.

```json
{
  "title": "Approve",
  "slug": "approve",
  "method": "PATCH",
  "path": "/:id/approve",
  "auth": true
}
```

| Field | Kind | Description |
|---|---|---|
| `slug` | **engine** | Name referenced by policies (`"action": ["approve"]`) and settings |
| `method` | **engine** | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | **engine** | Path after the resource segment: `/`, `/:id`, `/:id/approve`, … Named parameters are merged into the query, so `:id` becomes an `_id` filter |
| `auth` | **engine** | `true` → served under `/api/v1/<resource>`; `false` → served under `/api/v1/front/<resource>` |
| `title`, `type`, `header`, `body`, `locale`, `tenant_id`, `external`, `reason` | UI | Not read by the HTTP layer |

## 4.3 Built-in actions and resulting endpoints

| Action | Method | Path | `auth` | Endpoint | Executes |
|---|---|---|---|---|---|
| `list` | GET | `/` | true | `GET /api/v1/<res>` | find many |
| `read` | GET | `/:id` | true | `GET /api/v1/<res>/:id` | find filtered by `_id` |
| `create` | POST | `/` | true | `POST /api/v1/<res>` | insert |
| `update` | PUT | `/:id` | true | `PUT /api/v1/<res>/:id` | partial update of the matched document(s) |
| `delete` | DELETE | `/` | true | `DELETE /api/v1/<res>?ids=<id1>,<id2>` | delete many (`ids` → `id=in.[…]`) |
| `approve` | PATCH | `/:id/approve` | true | `PATCH /api/v1/<res>/:id/approve` | approval workflow step |
| `cancel` | PATCH | `/:id/cancel` | true | `PATCH /api/v1/<res>/:id/cancel` | approval workflow step |
| `list-public` | GET | `/` | false | `GET /api/v1/front/<res>` | find many as `guest` |
| `read-public` | GET | `/:id` | false | `GET /api/v1/front/<res>/:id` | find filtered by `_id`, as `guest` |
| `create-public` | POST | `/` | false | `POST /api/v1/front/<res>` | insert as `guest` (needs `public_entity: true`) |

Notes:

- `DELETE /api/v1/<res>/:id` has **no** built-in action. Use `?ids=`, or add your own action (`"method": "DELETE", "path": "/:id"`).
- `PUT|PATCH /api/v1/<res>/many` is a fixed bulk-update route.
- If no action matches, authenticated routes answer `400 Resource not found` and `/front` routes answer `404`.

## 4.4 Custom actions

Add a file to `json/system/action/` (or a tenant folder) and reference its slug from a policy. Example: an extra read-only endpoint that a policy can restrict to published items.

```json
{
  "title": "Featured (public)",
  "slug": "featured-public",
  "method": "GET",
  "path": "/featured",
  "auth": false
}
```

```json
{
  "slug": "policy-news-featured",
  "resource": ["news"],
  "action": ["featured-public"],
  "role": ["guest"],
  "root_entity": ["news"],
  "condition": "select=title,slug,featured_image()&is_featured=eq.true&order=-published_at"
}
```

`GET /api/v1/front/news/featured` now returns featured news only.

Every GET action runs the same *find* operation. What makes `read` a detail endpoint is only its `:id` parameter, which becomes an `_id` filter. Path parameters of custom actions are merged into the query the same way: `/:slug` turns into a `slug` filter.

## 4.5 Routes that are not configuration-driven

These are implemented in code and take precedence over the wildcard:

| Path | Purpose |
|---|---|
| `/api/v1/{entity, action, resource, policy, role, rule, setting, form-setting, api-config}` | Admin CRUD of the JSON configuration (served from the JSON files, admin only for writes). `GET /<type>`, `POST /<type>`, `GET/PUT/PATCH/DELETE /<type>/:slug` (`PUT` replaces, `PATCH` merges) |
| `<PREFIX_API>/auth/*` | `login`, `refresh-token`, `logout`, `me`, `permissions`, `change-password`, `forgot-password`, `reset-password`, `google`, `github` |
| `<PREFIX_API>/user` | User management |
| `<PREFIX_API>/admin/reload` | Reload the configuration from Redis |
| `<PREFIX_API>/media…` | Uploads to MinIO/S3 |
| `/api/v1/front/{sitemap, form-builder, cv, detail…}` | Specialised public endpoints |
| `/docs` | Swagger UI |
