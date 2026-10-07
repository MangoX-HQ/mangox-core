# 8. Recipes

Step-by-step examples you can copy. Each recipe lists the JSON files to add. If you add the files by hand, restart the server afterwards. If you `POST` the same documents to `/api/v1/<type>`, they apply immediately.

All examples assume `PREFIX_API=/api/v1`, an admin token in `$TOKEN`, and the tenant header `x-tenant-id: my-site`.

---

## 8.1 Expose a new collection

**Goal:** a `product` collection with full CRUD for admins and a public catalogue.

**1. Entity:** `json/system/entity/product.json`

```json
{
  "title": "Product",
  "collection_name": "product",
  "mongodb_save_data": "product",
  "databaseType": "mongodb",
  "public_entity": true,
  "use_timestamp": true,
  "use_slug": true,
  "json_schema": {
    "type": "object",
    "required": ["title", "price"],
    "properties": {
      "title":       { "title": "Title", "type": "string", "widget": "shortAnswer", "maxLength": 200 },
      "slug":        { "title": "Slug", "type": "string", "widget": "UriKeyGen" },
      "price":       { "title": "Price", "type": "number", "widget": "numberInput", "min": 0 },
      "status":      { "title": "Status", "type": "string", "widget": "select",
                       "choices": [ { "key": "Draft", "value": "draft" }, { "key": "Published", "value": "published" } ],
                       "default": "draft" },
      "category":    { "title": "Category", "type": "string", "widget": "relation",
                       "typeRelation": { "title": "category", "_id": "category", "type": "n-1" } },
      "cost_price":  { "title": "Cost price (internal)", "type": "number", "widget": "numberInput" }
    }
  }
}
```

**2. Resource:** `json/system/resource/product.json`

```json
{ "title": "product", "slug": "product", "entity": ["product"], "is_tenant": true,
  "action": ["list", "read", "create", "update", "delete", "list-public", "read-public"] }
```

**3. Admin policy:** `json/system/policy/policy-product-admin.json`

```json
{
  "title": "policy product admin",
  "slug": "policy-product-admin",
  "resource": ["product"],
  "action": ["list", "read", "create", "update", "delete"],
  "role": ["admin"],
  "root_entity": ["product"],
  "condition": "select=*,category,category(title,slug),created_by(username,full_name),updated_by(username,full_name)",
  "piority": "0"
}
```

**4. Public policy:** `json/system/policy/policy-product-guest.json`. It only returns published products, never shows `cost_price`, and always sorts by price.

```json
{
  "title": "policy product guest",
  "slug": "policy-product-guest",
  "resource": ["product"],
  "action": ["list-public", "read-public"],
  "role": ["guest"],
  "root_entity": ["product"],
  "condition": "select=title,slug,price,category,category(title,slug)&status=eq.published&order=price",
  "piority": "0"
}
```

**5. Try it:**

```bash
curl -X POST http://localhost:5557/api/v1/product \
  -H "Authorization: Bearer $TOKEN" -H "x-tenant-id: my-site" -H "Content-Type: application/json" \
  -d '{"title":"Blue Mug","price":12.5,"cost_price":4,"status":"published"}'
# → slug "blue-mug" is generated, created_at/updated_at/created_by are set

curl "http://localhost:5557/api/v1/front/product?title=ilike.mug" -H "x-tenant-id: my-site"
# → only title, slug, price, category (+ system fields); never cost_price; never drafts
```

---

## 8.2 Users can only see and edit their own records

**Goal:** role `author` manages its own `article`s; `admin` sees everything.

`created_by` is filled in automatically on create, from the token's user id, so filter on it:

```json
{
  "slug": "policy-article-author",
  "resource": ["article"],
  "action": ["list", "read", "create", "update", "delete"],
  "role": ["author"],
  "root_entity": ["article"],
  "condition": "select=*&created_by=eq.@options:user_id"
}
```

This is equivalent to adding `"scope": "self"` to the policy. Because `condition` also applies to updates and deletes, `PUT /api/v1/article/<someone-else's-id>` matches no document.

---

## 8.3 Different fields for different roles

**Goal:** support staff can read customers but never see `tax_id` or `internal_notes`.

```json
{
  "slug": "policy-customer-support",
  "resource": ["customer"],
  "action": ["list", "read"],
  "role": ["support"],
  "root_entity": ["customer"],
  "condition": "select=full_name,email,phone,company,address.city,address.country"
}
```

The policy's `select` replaces whatever the client asks for, so `?select=tax_id` returns nothing extra. Nested fields (`address.city`) can be whitelisted individually.

---

## 8.4 Public form submissions

**Goal:** anonymous visitors may submit a contact request; nobody anonymous may read requests.

Entity `contact-request` must have `"public_entity": true` and a `json_schema` with the accepted fields. Declared fields are the only ones stored; everything else is dropped.

```json
{
  "slug": "policy-contact-request-guest",
  "resource": ["contact-request"],
  "action": ["create-public"],
  "role": ["guest"],
  "root_entity": ["contact-request"],
  "condition": "",
  "condtion_body": "email=notnull.1&message=notnull.1&status=null.1"
}
```

`condtion_body` rejects submissions without an email or a message, and stops visitors from setting `status` themselves.

```bash
curl -X POST http://localhost:5557/api/v1/front/contact-request \
  -H "x-tenant-id: my-site" -H "Content-Type: application/json" \
  -d '{"email":"jane@example.com","message":"Hello!"}'
```

Add `policy-contact-request-admin` with `list` / `read` / `update` for the staff role.

---

## 8.5 Access based on membership (context queries)

**Goal:** members of a project see the project's tasks. Membership is stored in `project_member` documents `{ user_id, project_id, role }`.

```json
{
  "slug": "policy-task-member",
  "resource": ["task"],
  "action": ["list", "read"],
  "role": ["user"],
  "root_entity": ["task"],
  "data": [
    { "entity": "project_member",
      "condtion": "user_id=eq.@options:user_id&select=project_id&limit=1000",
      "alias": "my_projects" }
  ],
  "condition": "select=*,project(title)&project=in.@context:my_projects:data:project_id"
}
```

How it works:

1. `my_projects` loads every membership of the caller.
2. `@context:my_projects:data:project_id` becomes the list of their project ids, e.g. `["66a…","66b…"]`.
3. The `task` query is restricted to `project ∈ that list`. With no memberships, the list is empty and nothing matches.

---

## 8.6 "Full access if X, otherwise basic access"

**Goal:** project owners see the budget fields of a project; other members see the basics only. Build it from two policies with `condition_context` and `piority`:

```json
{
  "slug": "policy-project-owner",
  "resource": ["project"],
  "action": ["read"],
  "role": ["user"],
  "root_entity": ["project"],
  "piority": "10",
  "data": [
    { "entity": "project_member", "alias": "membership",
      "condtion": "user_id=eq.@options:user_id&role=eq.owner&select=project_id" }
  ],
  "condition_context": { "combinator": "and", "rules": [ { "value": "membership" } ] },
  "condition": "select=*&_id=in.@context:membership:data:project_id"
}
```

```json
{
  "slug": "policy-project-member",
  "resource": ["project"],
  "action": ["read"],
  "role": ["user"],
  "root_entity": ["project"],
  "piority": "0",
  "data": [
    { "entity": "project_member", "alias": "membership",
      "condtion": "user_id=eq.@options:user_id&select=project_id" }
  ],
  "condition": "select=title,description,status&_id=in.@context:membership:data:project_id"
}
```

The owner policy has the higher `piority` and is tried first. If the caller owns no project (`membership` is empty), its `condition_context` fails and the member policy is used.

---

## 8.7 Override a system policy for one tenant

Copy the file into the tenant scope with the **same slug** and change it:

```
json/system/policy/policy-page-guest.json                  ← shared default
json/<TEAM_ID>/<TENANT>/policy/policy-page-guest.json      ← wins for this tenant
```

Or do it through the API. Edits made through the API are written copy-on-write to the tenant folder. `PATCH` merges the given fields; `PUT` replaces the whole document:

```bash
curl -X PATCH http://localhost:5557/api/v1/policy/policy-page-guest \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "condition": "select=title,slug,content&status=eq.published" }'
```

---

## 8.8 Add a new role

1. Optional: describe it for admin UIs in `json/system/role/editor.json`: `{ "title": "editor", "slug": "editor", "is_active": true }`.
2. Write policies listing `"role": ["editor"]` for every resource and action editors need.
3. Give users the role. The role is read from the JWT's `role_name`; at login it is taken from the user document's `role_name` field:

```bash
mongosh "$MONGODB_URL" --eval 'db.user.updateOne({ email: "ed@example.com" }, { $set: { role_name: "editor" } })'
```

The user must log in again to get a token with the new role.

---

## 8.9 Debugging "403 Forbidden"

Check, in order:

1. **Role:** decode the JWT (e.g. on jwt.io) and look at `role_name`. Public `/front` routes always use `guest`.
2. **Action:** method and path must match an action. `DELETE /res/:id` has no built-in action; use `?ids=`.
3. **Policy match:** `resource`, `action` and `role` arrays must all contain the request's values. Slugs are case-sensitive.
4. **`condition_context`:** if every candidate has one and all of them fail, the result is 403.
5. **Empty results instead of 403:** usually an unresolved `@options` / `@context` variable, or a context query that returned nothing.

Set `DEBUG=true` to get detailed engine logs (`[common]`, `loadAction`, policy selection).
