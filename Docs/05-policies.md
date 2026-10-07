# 5. Policies

A **policy** grants one or more **roles** the right to run one or more **actions** on one or more **resources**, and states exactly what they may see or change:

- which documents they can see or change (row filters);
- which fields come back, and which relations are joined;
- extra data to load first, to decide access dynamically ("am I a member of this team?");
- rules the request body must satisfy;
- code to run on the result.

Location: `json/system/policy/<slug>.json`, overridable per tenant.
Admin API: `GET/POST /api/v1/policy`, `GET/PUT/PATCH/DELETE /api/v1/policy/:slug`.

> **Default deny.** If no policy matches the caller's role for a (resource, action) pair, the request is rejected with **403**. Super administrators are the only exception (see [§5.9](#59-super-administrators)).

## 5.1 Anatomy

```json
{
  "title": "policy lead user",
  "slug": "policy-lead-user",
  "resource": ["lead"],
  "action": ["list", "read", "update"],
  "role": ["user"],
  "root_entity": ["lead"],
  "condition": "select=*,assigned_to(username,full_name)&assigned_to=eq.@options:user_id",
  "data": [],
  "condition_context": null,
  "condtion_body": "",
  "code_context": "",
  "code": "",
  "piority": "0"
}
```

This policy lets users with role `user` list, read and update **only the leads assigned to them**, and populates `assigned_to` with the user's name.

> Two field names are misspelled in the format and must be written exactly like this: **`piority`** and **`condtion_body`**. Inside `data[]` entries, the key is **`condtion`**.

## 5.2 Field reference

### Matching

| Field | Type | Description |
|---|---|---|
| `slug` | string | Unique id; also the file name. A tenant policy with the same slug replaces the system one |
| `resource` | string[] | Resource slugs the policy applies to |
| `action` | string[] | Action slugs (`list`, `read`, `create`, `update`, `delete`, `list-public`, …) |
| `role` | string[] | Roles granted. The policy matches if **any** of the caller's roles is listed |
| `piority` | string or number | Higher is tried first. Default `0` |

### Execution

| Field | Type | Description |
|---|---|---|
| `root_entity` | string[] | The entity (`collection_name`) actually queried or written. The first element is used |
| `condition` | query string | Row filters, `select` (fields + joins) and `order`, merged into every read, update and delete. **Ignored on create** |
| `data` | array | Context queries run before the policy is evaluated: `[{ "entity", "condtion", "alias" }]` |
| `condition_context` | object or `null` | Rule tree evaluated against the context data. If false, this policy is skipped and the next candidate is tried |
| `condtion_body` | query string | Rules the **request body** must satisfy on create and update (`400 Data validation failed` otherwise) |
| `code_context` | string | Name of a `code` record run **before** evaluation; its returned object is merged into the context |
| `code` | string | Name of a `code` record run **after** the database operation; its return value replaces the response |
| `scope` | `"self"` | Shortcut that adds `created_by=eq.@options:user_id` to `condition` |
| `form` | string | Slug of a `form-setting` that fixes which body fields are accepted, their defaults and read-only fields. ⚠️ Currently drops the submitted values; see [Known issues §10.7](./10-known-issues.md#107-form-on-a-policy-drops-the-submitted-body) |
| `trigger` | object | Side effect run after a successful write |
| `mcp_actions` | string[] | Subset of `action` exposed as MCP tools to AI agents |

### Informational (not read by the engine)

`title`, `description`, `type` (`"local"`), `system`, `is_active`.

> `is_active: false` does **not** disable a policy. To disable one, remove it, or remove the role from `role`.

## 5.3 How a policy is selected

For each request:

1. If a [setting](./07-settings.md) exists for (resource, action, first role), it may pin one policy slug.
2. Candidates are all policies where `resource ∋ resource`, `action ∋ action`, and `role ∩ caller roles ≠ ∅`.
3. Candidates are sorted by `piority`, descending.
4. For each candidate, in order:
   1. run its `data` queries;
   2. run its `code_context`;
   3. evaluate `condition_context`.

   **The first candidate that passes is used.** The others are ignored: policies are **not** merged.
5. If none passes → `403 FORBIDDEN`.

This makes layered rules possible. For example:

```
piority 10  policy-team-read-full   role team_admin   condition_context: membership.role_name = admin   → all fields
piority  0  policy-team-read-basic  role team_admin   (no condition_context)                            → safe fields only
```

## 5.4 `condition` — what the role sees

`condition` uses the same query language as the URL (see [Query language](./06-query-language.md)). It is merged with the client's query string like this:

| Part of `condition` | Merge rule |
|---|---|
| `select=…` | **Replaces** the client's `select` completely. The client cannot request more fields or joins than the policy allows |
| `order=…` | Appended after the client's order (a lower-priority tie-breaker) |
| any filter (`field=op.value`, `or=(…)`, `and=(…)`, …) | ANDed with the client's filters. **The client can narrow results but can never widen them** |

Examples taken from `json/system/policy/`:

```text
# Admin sees everything, with the author's name joined
select=*,created_by(username,full_name),updated_by(username,full_name)

# Guests see everything, with the tag group's title and slug joined
select=*,tag_group,tag_group(title,slug)

# Field whitelist, including nested fields (the SMTP password is never exposed)
select=title,locale,mail.is_active,mail.host,mail.port,mail.secure,mail.user,mail.from,mail.from_name

# Owner-only rows
select=*,assigned_to(username,full_name)&assigned_to=eq.@options:user_id

# Rows from teams I belong to (context lookup, see 5.6)
select=_id,title,slug,plan,quota&_id=in.@context:my_memberships:data:team_id
```

Special values:

| `condition` | Meaning |
|---|---|
| `""` (empty) | No restriction: the client's own query is used as is, including any `select` and joins it asks for |
| `"select="` | No filters. The client's `select` is ignored: every schema field is returned, without joins |
| `"select=*"` | Same as above. Add `rel(...)` tokens to join relations |

On **update** and **delete**, the filters of `condition` limit which documents can be modified. With the owner-only example above, `PUT /api/v1/lead/<id>` on someone else's lead matches nothing.

> Do not put `limit`, `page`, `skip` or `count` in `condition`. They would be treated as field filters.

## 5.5 Variables

Policy strings can reference request data and context data. Values are inserted before parsing.

| Syntax | Value |
|---|---|
| `@options:user_id` | Id of the authenticated user |
| `@options:tenant_id` | Value of `x-tenant-id` (tenant resources only) |
| `@options:roles` | Caller's roles (array) |
| `@options:path` | URL path segments (array) |
| `@options:body:<field>` | A field of the request body (create/update only) |
| `@options:headers:<name>` | A request header (names without `-` only) |
| `@context:<alias>:data:<field>` | Values of `<field>` across **all** rows returned by the `data` query named `<alias>` (flattened, de-duplicated array) |
| `@context:<alias>:count` | Number of rows returned by that query |

The path separator is `:`. Nested and array fields flatten automatically: `@context:my_user_teams:data:tenant_roles:tenant_id` returns every `tenant_id` found in every row's `tenant_roles` array.

An unresolved variable stays as literal text, so the filter matches nothing. That is a safe failure mode: it denies access instead of leaking data.

## 5.6 `data` — context queries

`data` loads extra records before the policy is evaluated. Each entry:

```json
{ "entity": "user_team",
  "condtion": "user_id=eq.@options:user_id&is_active=neq.false",
  "alias": "my_memberships" }
```

| Key | Description |
|---|---|
| `entity` | Entity to query (`collection_name`) |
| `condtion` | Query string (filters, `select`, `limit`, …); `@options:` variables are resolved |
| `alias` | Name used in `@context:<alias>:…` and in `condition_context` |

Behaviour:

- Queries run in parallel with **admin rights** (no policy, no tenant filter). Filter explicitly.
- At most **20 rows** are returned by default; add `&limit=1000` if you need more.
- Results are cached in-process for 30 seconds, keyed by (entity, resolved condition).
- A `data` query cannot reference another alias. Chain logic through `condition` instead.

Real example (`policy-tenant-list-team-member.json`): one policy covers three kinds of membership by loading three lists and OR-ing them:

```json
{
  "slug": "policy-tenant-list-team-member",
  "resource": ["tenant"],
  "action": ["list"],
  "role": ["team_admin", "team_manager", "team_user"],
  "root_entity": ["tenant"],
  "data": [
    { "entity": "user_team", "alias": "my_admin_teams",
      "condtion": "user_id=eq.@options:user_id&role_name=eq.admin&is_active=neq.false" },
    { "entity": "user_team", "alias": "my_manager_teams",
      "condtion": "user_id=eq.@options:user_id&role_name=eq.manager&is_active=neq.false" },
    { "entity": "user_team", "alias": "my_user_teams",
      "condtion": "user_id=eq.@options:user_id&role_name=eq.user&is_active=neq.false" }
  ],
  "condition": "select=*,team_id(title,slug)&or=(team_id=in.@context:my_admin_teams:data:team_id,_id=in.@context:my_manager_teams:data:assigned_tenants,_id=in.@context:my_user_teams:data:tenant_roles:tenant_id)"
}
```

What each role sees:

- **Team admins** see every tenant of their teams.
- **Managers** see the tenants they are assigned to.
- **Users** see the tenants they have a role in.

If a list is empty, its branch matches nothing.

## 5.7 `condition_context` — conditional policies

A rule tree (react-querybuilder format) evaluated against the context. `null` always passes.

```json
"condition_context": {
  "combinator": "and",
  "rules": [
    { "field": "membership.role_name", "operator": "in", "value": ["admin", "manager"] },
    { "field": "membership.is_active", "operator": "neq", "value": false }
  ]
}
```

- `field` is `<alias>.<path>`, evaluated on the **first row** of that alias.
- Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `exists`, `notexists`, `contains`.
- Groups nest: `{ "combinator": "or", "rules": [ …, { "combinator": "and", "rules": [ … ] } ] }`.
- Shorthand `{ "value": "<alias>" }` passes when the alias returned at least one row.

If it evaluates to false, the engine moves on to the next policy by `piority`. Combine this with a fallback policy to build "if … then full access, else basic access" rules.

## 5.8 `condtion_body` — validating writes

On create and update, the body is checked in memory against `condtion_body` (same query syntax, with variables):

```text
# Users may only create leads assigned to themselves, with a valid priority
assigned_to=eq.@options:user_id&priority=in.[low,medium,high]
```

Failure → `Data validation failed`. This runs **before** the entity's `json_schema` validation, which still applies afterwards.

`like` and `ilike` in `condtion_body` use SQL-style wildcards (`%`, `_`), unlike database filters.

## 5.9 Super administrators

Super admins (`is_super_admin: true` or `role_system: "admin"`) bypass policy matching. On reads, updates and deletes the engine borrows the **highest-priority policy for role `admin`** on the resource, and applies its `condition` (its `select`/joins **and** its filters). Its `data`, `condition_context` and `code` are not run.

Practical consequences:

- Always provide an `admin` policy per resource, with a useful `select` (joins).
- Do not use `@context` filters in `admin` policies: the context is empty for super admins, so such filters match nothing.

## 5.10 Hooks: `code_context` and `code`

Both hooks reference a record of the `code` type by name. The record's `code` property holds the **body** of an async function with the parameters `(data, options, helpers)`:

```json
{
  "slug": "mask-phone",
  "code": "for (const row of data.data || []) { if (row.phone) row.phone = row.phone.slice(0, 3) + '****'; } return data;"
}
```

| Hook | Runs | `data` argument | Effect |
|---|---|---|---|
| `code_context` | Before `condition_context` | The context (`{ <alias>: <query result>, … }`) | A returned object is merged into the context |
| `code` | After the database operation | The operation result | The return value **replaces** the response; `undefined` keeps the original |

Errors are logged and swallowed: the original data is returned.

> ⚠️ **Security.** Code records run as **unsandboxed JavaScript inside the server process** (`new AsyncFunction(...)`). Anyone who can create or edit `code` records can run arbitrary code on your server and read every secret it holds. Keep the `code` resource restricted to trusted super administrators, and review code records like you review source code.

## 5.11 Guest (public) policies

Anonymous calls under `/api/v1/front/*` always run with role `guest`, and only match actions whose `auth` is `false`:

```json
{
  "slug": "policy-page-guest",
  "resource": ["page"],
  "action": ["list-public", "read-public"],
  "role": ["guest"],
  "root_entity": ["page"],
  "condition": "select=*,templates(*)"
}
```

Guidelines:

- **Whitelist fields** in `select` for anything sensitive. Never use `select=*` on entities that contain secrets or personal data.
- Add publication filters to `condition`, e.g. `status=eq.published&published_at=lte.now()`.
- Public **creates** (`create-public`, e.g. contact forms) additionally require `public_entity: true` on the entity. Combine them with `condtion_body` to constrain what can be submitted.

## 5.12 Shipped policies at a glance

| Pattern | Examples | Roles |
|---|---|---|
| Full CRUD with audit joins | `policy-tag-admin`, `policy-page-admin`, `policy-lead-admin` | `admin` |
| Public read | `policy-tag-guest`, `policy-page-guest`, `policy-menu-guest` | `guest` |
| Configuration types, no projection (`select=`) | `policy-entity-admin`, `policy-policy-admin`, `policy-resource-admin` | `admin` |
| Owner rows | `policy-lead-user` | `user` |
| Membership-based (context queries) | `policy-team-list-membership`, `policy-tenant-list-team-member`, `policy-user_team-list-team-member` | `team_admin`, `team_manager`, `team_user` |
| Basic vs full by membership role | `policy-team-read-basic` / `-full`, `policy-tenant-read-basic` / `-full` (+ settings) | team roles |
| Platform administration | `policy-team-admin`, `policy-tenant-admin`, `user-team-admin` | `super_admin` |
| Media for editorial roles | `policy-media-editor` | `writer`, `checker`, `publisher`, `editor`, `manager` |
