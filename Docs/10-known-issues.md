# 10. Known Issues & Limitations

This page lists behaviours of the current code that differ from what the configuration format suggests. Each item gives the location in the code and a workaround. Check this page before relying on one of these features.

## 10.1 Settings never dispatch

- **Where:** `src/module/common_v2/helper/excute.ts` (`executeSetting`) reads `setting.Case`; the shipped settings use `case`.
- **Effect:** no setting ever selects a policy. Selection falls back to `piority` + `condition_context`.
- **Workaround:** use `condition_context` + `piority` ([Recipe 8.6](./08-recipes.md#86-full-access-if-x-otherwise-basic-access)). Or fix the dispatcher, e.g. `const cases = setting.case || setting.Case || [];`.

## 10.2 `@options:resource_id` is never populated

- **Where:** no code path sets `options.resource_id` (see `src/module/common_v2/common.ts`).
- **Effect:** the variable stays unresolved in `policy-team-read-basic/-full`, `policy-tenant-read-basic/-full`, `setting-team-read` and `setting-tenant-read`. Their context queries return nothing, so the reads they govern return no data.
- **Workaround:** detail reads already carry the id as an `_id` filter from the URL. Write conditions that do not depend on `resource_id`, for example `_id=in.@context:my_memberships:data:team_id` with a membership query keyed on `user_id` only.

## 10.3 Team roles are not assigned automatically

- **Where:** roles come from the JWT's `role_name` (`src/module/common_v2/common.ts`, `buildRoles`). Nothing in this build derives `team_admin`, `team_manager` or `team_user` from `user_team` memberships.
- **Effect:** policies for those roles only apply when the token itself carries such a role, e.g. issued by an external SSO provider.
- **Workaround:** issue tokens with those role names, or rewrite the policies for the roles your tokens actually carry. Their membership checks (`data` + `@context`) still work.

## 10.4 Super administrators and `@context` filters

- **Where:** `src/module/common_v2/helper/builder.ts` (super-admin branch).
- **Effect:** super admins reuse the `condition` of the top-priority `admin` policy, **including its filters**, but its `data` queries are not run. A filter like `_id=in.@context:…` stays unresolved and matches nothing.
- **Workaround:** keep `admin`-role policies free of `@context` filters.

## 10.5 `rel(*)` probably returns only `_id`

- **Where:** `src/core_v2/query/converter.ts`. `*` inside parentheses is treated as a field literally named `*`.
- **Effect:** `templates(*)`, `groupfield_id(*)`, `member(*)`, … may populate only the related `_id`. This conclusion comes from reading the code; verify it on your data.
- **Workaround:** use `rel()` (empty parentheses) for the whole document, or list the fields: `rel(title,slug)`.

## 10.6 Joined users never include `email`

- **Where:** `src/core_v2/adapters/mongodb/converters/join-converter.ts`.
- **Effect:** `password`, `email`, `role` and `role_system` are always stripped from joined `user` documents, even when selected (e.g. `created_by(username,full_name,email)`).
- **Workaround:** query `/api/v1/user` directly when an email is really needed.

## 10.7 `form` on a policy drops the submitted body

- **Where:** `src/module/common_v2/helper/builder.ts`, `form` branch.
- **Effect:** the filtered body is built from form-setting defaults only, so the client's values are discarded.
- **Workaround:** do not use `form` on policies until this is fixed; use `condtion_body` and the entity's `json_schema` instead.

## 10.8 Flags and fields that look enforced but are not

| Field | Reality |
|---|---|
| `policy.is_active`, `setting.is_active` | Not checked. Remove the file or the role to disable |
| `resource.action[]` | Not checked. Policies are the only gate |
| `json_schema.properties.<field>.readonly` / `require` | UI only. Use the root `required[]` array and policy rules |
| `entity.unique_keys` | No index is created |
| `entity.use_seo_path` | SEO paths follow `use_slug` |
| `"false"` (string) as a `use_*` value | Counts as **enabled**. `collection`, `cron-job`, `rule` and `role` ship with `use_sync_relationship_multiply_language: "false"` |

## 10.9 Validation quirks

- **`PATCH` is not partial for validation:** core updates validate as `PUT`, so `required` fields must be present on every update.
- **Lower-case `datetime` widget:** not validated as a date; stored as a plain string. Use `dateTime` for format checking.
- **`date` widget:** mapped to the `date-time` format, which requires a time part. Date-only values may be rejected.
- **`function` widget overrides `type`:** it always validates as a string. `api-config` fields declared as `object` with this widget (`endpoint_map`, `extra_headers`, `request_template`) may reject object values.
- **`not=(single condition)`** produces a top-level `$not`, which MongoDB rejects. Use the inverse operator (`neq`, `nin`, `not_contains`, …).

## 10.10 Tenant header is a partition key, not an authorization check

- **Where:** `src/module/common_v2/common.ts`. The `x-tenant-id` value is not compared with `TENANT` or with the user's memberships.
- **Effect:** within one deployment, any authenticated caller whose policy allows a resource can read other `tenant_id` partitions by changing the header.
- **Workaround:** run one deployment (one MongoDB database) per tenant, as described in [Deployment §9.4](./09-deployment.md#94-running-several-tenants), or validate the header in a proxy.

## 10.11 Code records run unsandboxed

- **Where:** `src/module/common_v2/helper/excute.ts` (`executeCode`) runs records with `new AsyncFunction(...)` in the server process.
- **Effect:** whoever can write `code` records can run arbitrary code. The shipped `policy-code-admin` grants the `admin` role full CRUD on `code`.
- **Workaround:** restrict the `code` resource to `super_admin`, and review code records like source code.

## 10.12 Deployment

- **`json/` is required at runtime.** Startup wipes the Redis schema keys and reloads them from `json/`, but `Dockerfile.single-tenant` does not copy `json/` into the image. Mount it. See [Deployment §9.1](./09-deployment.md#91-deployment-model).
- **Hand edits need a restart.** The file watcher is disabled; only API edits are synced live.
- **Context queries return at most 20 rows** unless their `condtion` sets `limit`.
- **`scripts/seed-e2e-user.ts`** writes to the database `mangoads` regardless of `MONGODB_URL`.
- **SQL adapters.** Comments still mention SQLite, but only the `mongodb` and `rest` adapters exist.
