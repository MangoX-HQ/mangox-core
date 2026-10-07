# 7. Settings — Dynamic Policy Dispatch

A **setting** chooses which policy to apply **based on data**. You can do the same with several policies plus `condition_context` and `piority` (see [Policies §5.7](./05-policies.md#57-condition_context--conditional-policies)). A setting puts the decision in one place instead: "load X, look at field Y, and pick policy A, B or C".

Location: `json/system/setting/<slug>.json`.
Admin API: `GET/POST /api/v1/setting`, `GET/PUT/PATCH/DELETE /api/v1/setting/:slug`.

> ⚠️ **Read [Known issues](./10-known-issues.md#101-settings-never-dispatch) before relying on settings.** In the current code the dispatcher reads the key `Case` (capital C), while the shipped files use `case`.

## 7.1 Example

`json/system/setting/setting-team-read.json`:

```json
{
  "title": "setting team read — dispatch policy by the caller's role_name on the team",
  "slug": "setting-team-read",
  "description": "GET /team/:id — load the caller's membership of the team, then pick the full or basic read policy.",
  "resource": "team",
  "action": "read",
  "role": "team_admin",
  "context_data_resource": [
    {
      "entity": "user_team",
      "condtion": "user_id=eq.@options:user_id&team_id=eq.@options:resource_id&is_active=neq.false",
      "alias": "membership"
    }
  ],
  "switch": "membership:data:role_name",
  "case": [
    { "value": "admin",   "policy": "policy-team-read-full" },
    { "value": "manager", "policy": "policy-team-read-full" },
    { "value": "user",    "policy": "policy-team-read-basic" }
  ],
  "is_active": true,
  "system": true
}
```

Reading `GET /api/v1/team/<id>` as a `team_admin`:

1. `membership` = the caller's `user_team` records for that team.
2. `switch` resolves `membership → data → role_name`, e.g. `"manager"`.
3. The first matching case wins: `policy-team-read-full`.
4. The engine then looks for policies matching (team, read, caller roles) **and** having that slug.

## 7.2 Field reference

| Field | Description |
|---|---|
| `slug` | Unique id / file name |
| `resource` | Resource slug (string, or array of slugs) |
| `action` | Action slug (string, or array) |
| `role` | Role (string, or array). Compared with the caller's **first** role only |
| `context_data_resource` | Context queries, same format as a policy's `data` (`entity`, `condtion`, `alias`). Only `@options:` variables are resolved |
| `switch` | `:`-separated path into the context, e.g. `membership:data:role_name` |
| `case` | Ordered list of `{ "value", "policy" }` |
| `title`, `description`, `is_active`, `system` | Informational. `is_active` is **not** checked |

### Case values

A case `value` is either a plain value (compared with `eq`) or an `operator.value` string using the filter operators of the [query language](./06-query-language.md#operators):

```json
"case": [
  { "value": "in.[admin,owner]", "policy": "policy-project-full" },
  { "value": "neq.guest",        "policy": "policy-project-member" },
  { "value": "guest",            "policy": "policy-project-readonly" }
]
```

## 7.3 Rules

- At most one setting applies per (resource, action, first role). A tenant setting replaces a system setting with the same slug.
- The chosen policy must **still** match the request's resource, action and roles. A setting cannot grant access that no policy grants.
- If no case matches, normal policy selection by `piority` applies.
- Context results are cached in-process for 30 seconds.

## 7.4 Settings vs. `condition_context`

| Use a setting when… | Use `condition_context` + `piority` when… |
|---|---|
| One lookup decides between many policies | Each policy has its own independent condition |
| You want the decision table in one file | You want each policy to be self-contained |
| The decision value is a single field (`switch`) | The decision combines several fields with `and` / `or` |
