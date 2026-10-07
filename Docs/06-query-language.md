# 6. Query Language

Clients use the same PostgREST-style query language in the URL that policies use in `condition`, `data[].condtion` and `condtion_body`.

```
GET /api/v1/news?select=title,slug,category(title)&status=eq.published&or=(views=gt.100,is_featured=eq.true)&order=-published_at&limit=20&page=2
```

Remember that a policy's `select` **replaces** the client's `select`, and policy filters are **ANDed** with the client's filters (see [Policies §5.4](./05-policies.md#54-condition--what-the-role-sees)).

## 6.1 Filters

```
<field>=<operator>.<value>
```

Without a recognised operator the comparison is `eq`, so `status=published` is the same as `status=eq.published`. Nested fields use dot notation: `mail.host=eq.smtp.example.com`.

### Operators

| Operator | Example | MongoDB |
|---|---|---|
| `eq` | `status=eq.published` | `$eq` |
| `neq` | `is_active=neq.false` | `$ne` |
| `gt`, `gte`, `lt`, `lte` | `price=gte.100` | `$gt`, `$gte`, `$lt`, `$lte` |
| `in` | `role_name=in.[admin,manager]` | `$in` (a scalar is wrapped in an array) |
| `nin` | `status=nin.[draft,archived]` | `$nin` |
| `like`, `ilike`, `contains` | `title=ilike.hello` | case-insensitive **substring** match (`%` is *not* a wildcard here) |
| `startswith`, `endswith` | `slug=startswith.news-` | case-insensitive prefix / suffix |
| `not_contains`, `not_startswith`, `not_endswith` | `title=not_contains.test` | negated forms of the above |
| `regex` | `code=regex.^VN-[0-9]+$` | case-insensitive regular expression |
| `exists` | `avatar=exists.true` | `$exists: true` |
| `null`, `notnull` | `deleted_at=null.1`, `parent_id=notnull.1` | `= null`, `≠ null` |
| `between`, `not_between` | `price=between.[10,50]` | inclusive range |

`is.null` is **not** supported. Use `field=null` or `field=null.1`.

### Values

| Written | Parsed as |
|---|---|
| `true`, `false`, `null` | boolean / null |
| `42` | number (digits only) |
| `2026-01-31T00:00:00Z` | date |
| `"00123"` | string. Quotes force a string and are removed |
| `[a,b,c]` | array. **Brackets are required** for `in`, `nin` and `between` |
| anything else | string |

Ids are converted for you: values of `_id`, `*._id` and `id` become `ObjectId`s, and `id` is renamed to `_id`.

### Value functions

| Function | Value |
|---|---|
| `now()` | current date-time |
| `today()` | today at 00:00 |
| `addDays(n)`, `subDays(n)` | now ± n days |
| `nowSubDaysNotTime(n)` | today − n days, at 00:00 |
| `toObjectId(x)`, `arrayToObjectId([..])` | explicit ObjectId conversion |
| `currentUser(x)` | a property of the current user |

```
published_at=lte.now()&expires_at=gt.now()
created_at=gte.subDays(7)
```

## 6.2 `select` and joins

`select` is a comma-separated list of fields and relations:

| Token | Meaning |
|---|---|
| `*` | every field declared in the entity's `json_schema`, plus system fields |
| `title,slug` | only these fields (system fields such as `_id`, `created_at`, `slug`, `title`, `locale` are always included) |
| `mail.host` | a nested field |
| `rel()` | join relation `rel` and return the **whole** related document |
| `rel(a,b)` | join `rel`, returning only fields `a`, `b` (and `_id`) of the related document |
| `rel(a,sub())` | nested join: populate `sub` inside the related document |
| `rel(field=op.val)` | join with a filter on the related documents (**left join**: parents without a match are kept) |
| `rel(!field=op.val)` | join with a filter that also **drops parents** without a match (**inner join**) |

`rel` is the field name of a relation declared in the entity (`widget: "relation"`), or one of the implicit relations `created_by`, `updated_by`, file fields, and reverse relations `mangox_<source>_<field>`. Unknown relation names are ignored silently.

The populated value **replaces** the stored id(s):

```json
// select=*,tag_group(title,slug)
{ "_id": "…", "title": "Mongo", "tag_group": { "_id": "…", "title": "Databases", "slug": "databases" } }
```

Single object vs array depends on the relation type: `1-1` and `n-1` give an object, `1-n` and `n-n` give an array. See [Entities §3.6](./03-entities.md#36-relations).

**Why do some policies list a relation twice** (`tag_group,tag_group(title,slug)`)? With an explicit field list, a joined field is only kept in the final projection if its name is also selected. With `*` the duplicate is harmless. `created_by` and `updated_by` are system fields and are always kept.

Examples:

```
select=*,created_by(username,full_name),updated_by(username,full_name)
select=title,slug,category,category(title,slug)
select=*,templates(_id,title,header(),footer(),sidebar())
select=*,comments(!status=eq.approved)        ← only items with at least one approved comment
```

## 6.3 Logical operators

| Syntax | Meaning |
|---|---|
| `a=eq.1&b=eq.2` | AND (separate parameters). A parameter name may appear only once; repeat a field inside `and=()` instead |
| `and=(a=eq.1,b=eq.2)` | AND |
| `or=(a=eq.1,b=eq.2)` | OR |
| `not=(a=eq.1,b=eq.2)` | NOR (none of them) |
| `filters=a=eq.1;b=eq.2` | AND list separated by `;` |

Groups nest, and commas inside `()`, `[]` or quotes are handled correctly:

```
or=(status=eq.published,and=(status=eq.draft,created_by=eq.@options:user_id))
```

## 6.4 Ordering

```
order=-published_at,title
```

A `-` prefix means descending. The default order for list calls is `-created_at,-updated_at,-timestamp,-_id`, and an extra `created_at` tie-breaker is always appended.

## 6.5 Pagination

| Parameter | Default | Notes |
|---|---|---|
| `limit` | `10` | maximum `1000` |
| `page` | `1` | converted to `skip = (page − 1) × limit` |
| `skip` / `offset` | — | ignored on list endpoints; use `page` |

The total number of matching documents is always returned with the list.

## 6.6 Special parameters

| Parameter | Effect |
|---|---|
| `locale=en` | Filters by `locale`, and filters `locale_id` joins to the same language (entities with `use_locale`). On a detail call, `GET /<res>/<id>?locale=en` returns the `en` version of the record group |
| `tree=true` | Return a nested tree (entities with `use_parent`) |
| `history=false` | Do not join history entries (entities with `use_history`) |
| `ids=a,b` | On `DELETE`: the ids to delete |

## 6.7 Variables (policies only)

Inside policy strings you can reference request and context values. They are not available to clients.

| Variable | Value |
|---|---|
| `@options:user_id` | authenticated user id |
| `@options:tenant_id` | `x-tenant-id` header value |
| `@options:roles` | caller roles |
| `@options:body:<field>` | request body field (create/update) |
| `@options:headers:<name>` | request header |
| `@context:<alias>:data:<field>` | all values of `<field>` across the rows of context query `<alias>` |
| `@context:<alias>:count` | number of rows of context query `<alias>` |

See [Policies §5.5](./05-policies.md#55-variables) for details and examples.

## 6.8 Cheat sheet

```text
# Published articles in a category, newest first, page 2
?status=eq.published&category=eq.66f…&order=-published_at&limit=12&page=2

# Search by title, return title + slug + author name
?title=ilike.mongodb&select=title,slug,created_by(full_name)

# Items expiring within 7 days (a key may appear only once, so group repeated fields in and=())
?and=(expires_at=gte.today(),expires_at=lte.addDays(7))

# Everything except drafts and archived items
?status=nin.[draft,archived]

# Either featured or popular
?or=(is_featured=eq.true,views=gte.1000)
```
