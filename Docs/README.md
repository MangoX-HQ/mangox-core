# MangoX Core Documentation

MangoX Core is a **configuration-driven API server for MongoDB**. You describe your data model and your access rules in plain JSON files; MangoX turns them into a REST API with fine-grained, per-role policies — no controller code required.

It follows the spirit of [PostgREST](https://postgrest.org) (a database exposed as a REST API, with a URL query language for filtering, selecting and joining), but is built for MongoDB and is more flexible:

| | PostgREST | MangoX Core |
|---|---|---|
| Database | PostgreSQL | MongoDB |
| Schema source | SQL DDL | JSON files (`json/`) — editable at runtime through the API |
| Access control | PostgreSQL roles + row-level security | JSON **policies**: per role × resource × action, with row filters, field whitelists, joins, context lookups, body validation and post-processing hooks |
| Joins | Foreign keys | Relations declared in the entity JSON (`widget: "relation"`), populated with `select=rel(...)` |
| Extras | — | Built-in plugins: slugs/SEO paths, multi-language records, trees, content blocks, approval workflow, history, soft delete, timestamps |

Under the hood MangoX is a [Fastify](https://fastify.dev) application. It reads the JSON configuration, caches it in **Redis**, and translates every HTTP request into a **MongoDB** aggregation pipeline after applying the matching policy.

## How it fits together

```
HTTP request ──► Fastify ──► JWT guard ──► resolve resource + action (from the URL)
                                              │
                                              ▼
                                  find matching POLICY (role × resource × action)
                                              │  merges the policy's condition into the query,
                                              │  validates the body, loads context data
                                              ▼
                              Query converter ──► MongoDB aggregation pipeline
                                              │
                                              ▼
                              plugins (slug, locale, tree, history, …) ──► JSON response
```

## Table of contents

| # | Document | What you will learn |
|---|---|---|
| 1 | [Getting started](./01-getting-started.md) | Install, configure, connect MongoDB/Redis, run the server, create the first admin, make your first call |
| 2 | [Core concepts & architecture](./02-concepts.md) | The six building blocks (entity, resource, action, policy, role, setting), the JSON layout, the request lifecycle |
| 3 | [Entities](./03-entities.md) | Declaring collections, fields, validation, relations and feature flags (`json/system/entity/*.json`) |
| 4 | [Resources & actions](./04-resources-and-actions.md) | How URLs map to resources and actions; authenticated vs public endpoints |
| 5 | [Policies](./05-policies.md) | The full policy reference: matching, priority, row filters, field selection, context data, body validation, hooks |
| 6 | [Query language](./06-query-language.md) | `select`, joins, filter operators, `and`/`or`, ordering, pagination, `@options` / `@context` variables |
| 7 | [Settings (policy dispatch)](./07-settings.md) | Choosing a policy dynamically from data (e.g. by the caller's membership role) |
| 8 | [Recipes](./08-recipes.md) | Step-by-step examples: a new public entity, owner-only access, team membership filters, field whitelists |
| 9 | [Deployment](./09-deployment.md) | Docker images, environment reference, schema reload, production checklist |
| 10 | [Known issues & limitations](./10-known-issues.md) | Behaviours of the current code you should know about before relying on a feature |

## A 30-second example

The files below are all it takes to expose a `tag` collection with an admin CRUD API and a read-only public API.

`json/system/entity/tag.json` (abridged) — the data model:

```json
{
  "title": "Tag",
  "collection_name": "tag",
  "mongodb_save_data": "tag",
  "databaseType": "mongodb",
  "public_entity": true,
  "json_schema": {
    "type": "object",
    "required": ["title", "slug"],
    "properties": {
      "title":     { "type": "string", "widget": "shortAnswer", "title": "Title" },
      "slug":      { "type": "string", "widget": "UriKeyGen",   "title": "Slug" },
      "tag_group": { "type": "string", "widget": "relation",    "title": "Tag Group",
                     "typeRelation": { "title": "tag-group", "_id": "tag-group", "type": "1-n" } }
    }
  }
}
```

`json/system/resource/tag.json` — the URL segment:

```json
{ "title": "tag", "slug": "tag", "entity": ["tag"], "is_tenant": true,
  "action": ["list", "read", "create", "update", "delete"] }
```

`json/system/policy/policy-tag-admin.json` — who may do what:

```json
{
  "slug": "policy-tag-admin",
  "resource": ["tag"],
  "action": ["list", "read", "create", "update", "delete"],
  "role": ["admin"],
  "root_entity": ["tag"],
  "condition": "select=*,created_by(username,full_name),tag_group,tag_group(title,slug)",
  "piority": "0"
}
```

`json/system/policy/policy-tag-guest.json` — anonymous read access:

```json
{
  "slug": "policy-tag-guest",
  "resource": ["tag"],
  "action": ["list-public", "read-public"],
  "role": ["guest"],
  "root_entity": ["tag"],
  "condition": "select=*,tag_group,tag_group(title,slug)"
}
```

Result:

```bash
# admin (JWT with role "admin")
curl -H "Authorization: Bearer $TOKEN" -H "x-tenant-id: my-site" \
     "http://localhost:5557/api/v1/tag?title=ilike.news&order=-created_at&limit=20"

# anyone, no token
curl -H "x-tenant-id: my-site" "http://localhost:5557/api/v1/front/tag"
```

Both responses contain the tag documents with `tag_group` replaced by `{ _id, title, slug }`, and the public one never exposes more than its policy allows.
