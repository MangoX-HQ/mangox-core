# 3. Entities

An **entity** describes one kind of record: its fields, validation rules, relations, storage location and which built-in behaviours (plugins) it uses.

- Location: `json/system/entity/<collection_name>.json` (or a tenant override folder)
- Admin API: `GET/POST /api/v1/entity`, `GET/PUT/PATCH/DELETE /api/v1/entity/:slug`

Many entity files also contain fields used only by the MangoX admin UI (form layout, help texts, tab lists…). This page marks every field as **engine** (the backend acts on it) or **UI** (stored and returned, but ignored by the backend).

## 3.1 Minimal entity

```json
{
  "title": "Lead",
  "collection_name": "lead",
  "mongodb_save_data": "lead",
  "databaseType": "mongodb",
  "public_entity": false,
  "use_timestamp": true,
  "json_schema": {
    "type": "object",
    "required": ["email"],
    "properties": {
      "full_name":   { "title": "Full name", "type": "string", "widget": "shortAnswer" },
      "email":       { "title": "Email",     "type": "string", "widget": "shortAnswer", "filter": true },
      "priority":    { "title": "Priority",  "type": "string", "widget": "select",
                       "choices": [ { "key": "Low", "value": "low" },
                                    { "key": "Medium", "value": "medium" },
                                    { "key": "High", "value": "high" } ] },
      "assigned_to": { "title": "Owner", "type": "string", "widget": "relation",
                       "typeRelation": { "title": "user", "_id": "user", "type": "1-n" } },
      "tags":        { "title": "Tags", "type": "array", "widget": "tags", "items": { "type": "string" } },
      "submission_count": { "title": "Submissions", "type": "number", "widget": "numberInput" }
    }
  },
  "ui_schema": {
    "ui:order": ["full_name", "email", "priority", "assigned_to", "tags", "submission_count"]
  }
}
```

An entity on its own is not reachable over HTTP. You also need a [resource](./04-resources-and-actions.md) and at least one [policy](./05-policies.md).

## 3.2 Identity fields

| Field | Kind | Description |
|---|---|---|
| `title` | UI | Human-readable name |
| `collection_name` | **engine** | Logical name and unique key of the entity. It is also the file name. Policies refer to it in `root_entity`, and relations target it |
| `slug` | UI | Rarely used on entities; prefer `collection_name` |
| `system` | UI | Marks a built-in entity |
| `status`, `reason` | UI | Admin metadata |

## 3.3 Storage fields

| Field | Kind | Description |
|---|---|---|
| `databaseType` | **engine** | Adapter: `"mongodb"` (default) or `"rest"` (see [Concepts](./02-concepts.md#26-database-adapters)) |
| `mongodb_save_data` | **engine** | **Physical MongoDB collection** the documents are stored in |
| `mongodb_collection_name` | engine (public pages only) | Used by the `/front` detail, sitemap and post-type helpers to map URL slugs to entities. The core engine does not route storage with it |
| `api_config` | **engine** | With `databaseType: "rest"`: the slug of the `api-config` record that describes the remote API |

### Polymorphic storage (several entities, one collection)

If `mongodb_save_data` differs from `collection_name`, several logical entities share one physical collection:

- every document is stamped with `collection_name: "<logical name>"` (or with the field named by `discriminator_field`, if set);
- every read and join on the entity automatically filters on that discriminator.

```json
{ "collection_name": "news",   "mongodb_save_data": "post" }
{ "collection_name": "events", "mongodb_save_data": "post" }
```

Both entities store into `post`, and `GET /api/v1/news` only returns news.

## 3.4 Access flag

| Field | Kind | Description |
|---|---|---|
| `public_entity` | **engine** | Must be `true` for **public creates** (`POST /api/v1/front/<resource>`). On public reads, it controls whether the requested `select` is honoured as a projection. Public reads still need a `guest` policy |

## 3.5 `json_schema` — fields and validation

`json_schema` is a [JSON Schema](https://json-schema.org) object extended with MangoX attributes. When a record is written, the engine:

1. converts `json_schema` into an AJV schema (widgets are mapped to types and formats, see below);
2. validates the body. AJV runs with `coerceTypes: true` (for example `"5"` becomes `5` for a number) and `removeAdditional: true`;
3. **drops every field that is not declared** in `json_schema`, unless it is a system field or a field added by an enabled plugin;
4. on `POST`, fills top-level `default` values.

On reads, the projection is limited to declared fields plus system fields. `password` is never returned.

**System fields** are always allowed and returned:
`_id, created_at, updated_at, created_by, updated_by, tenant_id, collection_name, status_approve, slug, title, system, locale, locale_id, post_type, blocks_position, blocks_position_data, parent_id, parent_id_obj, children, is_root, position, deleted, deleted_at, deleted_by`.

### Root keywords

| Keyword | Kind | Description |
|---|---|---|
| `type` | engine | Always `"object"` |
| `properties` | engine | The fields (see below) |
| `required` | **engine** | Array of required field names, enforced on `POST` **and** `PUT` |
| `dependencies` | UI | Ignored by the engine |

### Field attributes used by the engine

| Attribute | Description |
|---|---|
| `type` | `string`, `number`, `integer`, `boolean`, `object`, `array`. Default: `string`. `object` + `properties` and `array` + `items.properties` nest |
| `widget` | Drives type conversion; see the table below |
| `default` | Value filled in on `POST` (top-level fields only) |
| `choices` | Allowed values → AJV `enum`. Either `[{ "key": "Label", "value": "stored" }]` or a string `"Label:value\nLabel2:value2"` |
| `isMultiple` | `select` / `radio`: value is an array of `choices` |
| `allowNull` | `select` / `radio`: `null` is accepted |
| `min`, `max` | `numberInput` / `range`: become `minimum` / `maximum` |
| `minLength`, `maxLength`, `pattern`, `format-data` | String constraints on text widgets. `format-data`: `email`, `phone`, `uri`, `url`, `date`, … |
| `typeRelation`, `refValue` | Declare a relation (see [§3.6](#36-relations)) |

### Widgets → stored type

| Widget | Stored / validated as |
|---|---|
| `shortAnswer`, `longAnswer`, `UriKeyGen` | string (plus length/format/pattern constraints) |
| `textarea`, `textArea`, `richText`, `json`, `tags` | the declared `type` |
| `numberInput`, `range` | number (`min`/`max` honoured) |
| `boolean` | boolean |
| `checkbox` | boolean, or an array of unique `choices` values |
| `select`, `radio` | string from `choices` (array with `isMultiple`, nullable with `allowNull`) |
| `password` | string, **hashed with bcrypt on write** |
| `date`, `dateTime`, `date-time` | string in `date-time` format |
| `datetime` (lower-case) | plain string (no format check) |
| `relation` | string **or** array of strings (ids or `refValue` values) |
| `file`, `multipleFiles`, `multiImage` | string or array (media ids); joined to `media` |
| `condition`, `href` | **object** (overrides the declared `type`) |
| `function`, `icon`, `break`, `dataWidget` | **string** (overrides the declared `type`) |

### Field attributes used only by the admin UI

`title`, `description`, `filter`, `hidden`, `readonly`, `require` (singular, per field: use the root `required` array for real enforcement), `expanded`, `typeSelect` (`once` / `single` / `multiple`), `depend_field`, `refValueAdmin`, `refValueRelation`, `fieldRelation`, `customRole`, `returnValue`, `objectKey`, `typeUrl`, `defaultLanguage`, `displayFormat`, `formatDate`, `appearance`, `typeUI`, `disabled`, and `typeRelation.filter`.

> `readonly` is **not** enforced by the engine. To make a field read-only for a role, leave it out of what that role can write. You can use the policy's `condtion_body` or a `form` for that (see [Policies](./05-policies.md)).

## 3.6 Relations

A field becomes a relation when it has `"widget": "relation"` **and** a `typeRelation`:

```json
"tag_group": {
  "title": "Tag Group",
  "type": "string",
  "widget": "relation",
  "typeRelation": { "title": "tag-group", "_id": "tag-group", "type": "1-n" },
  "refValue": "locale_id"
}
```

| Key | Meaning |
|---|---|
| `typeRelation.title` | **Target entity** (`collection_name`). The engine resolves the target from `typeRelation.collection`, then `entity`, then `title`, then `collection_name`. Keep `title` and `_id` equal to the target name |
| `typeRelation._id` | Target entity, used by the admin UI, the `use_get_parent` plugin and public detail pages |
| `typeRelation.type` | Cardinality; see below |
| `refValue` | Field of the **target** that the stored value refers to. Default: `_id`. Examples: `slug`, `locale_id`, `collection_name`, `code` |

| `type` | Meaning | Shape after populate |
|---|---|---|
| `1-1` | one-to-one | single object |
| `n-1` (`*-1`) | many-to-one | single object |
| `1-n` (`1-*`), or missing | one-to-many | array |
| `n-n` | many-to-many | array |

How relations behave:

- **Storage.** The field stores a string or an array of strings. When `refValue` is `_id`, string ids are converted to `ObjectId` inside the join, so you can store plain strings.
- **Populate.** Relations are only joined when a `select` asks for them: `select=*,tag_group(title,slug)` (see [Query language](./06-query-language.md#62-select-and-joins)). The populated value replaces the stored id(s).
- **Implicit relations.** `created_by` and `updated_by` always relate to `user`. `file` and `multipleFiles` widgets relate to `media`.
- **Reverse relations.** For every relation, a reverse relation named `mangox_<source>_<field>` is registered on the target, so you can populate "children" from the parent side.
- **Sensitive data.** Joined `user` documents never include `password`, `email`, `role` or `role_system`.
- **Nested relations.** A relation inside an `object` (for example `section.domain`) is registered as `section_domain`.

## 3.7 Feature flags (plugins)

Flags are top-level booleans. A plugin runs unless its flag is `false` or missing. **Use real booleans**: the string `"false"` counts as *enabled*.

| Flag | Kind | Effect |
|---|---|---|
| `use_timestamp` | **engine** | Sets `created_at` / `updated_at` on insert and `updated_at` on update |
| `use_slug` | **engine** | Generates `slug` from `title` (lower-case, accents stripped, hyphenated) unless one is sent. Guarantees uniqueness per entity and tenant (`-2`, `-3`, … on clashes) and maintains `seopath` records (`/news/my-article` → document) |
| `use_locale` | **engine** | Multi-language records. Each translation is a document sharing a `locale_id`. Sets `locale_id = _id` and `locale` (default `vi`) on insert, rejects duplicate (`locale_id`, `locale`) pairs, and returns `languages: [...]` on reads. `?locale=en` filters joins by language |
| `languages` | **engine** | `[{ "locale": "en", "slug": "news" }, …]`: URL prefix of the entity per language, used for SEO paths and public pages |
| `use_sync_relationship_multiply_language` | **engine** | After an update, copies relation fields whose `refValue` is `locale_id` to the other language versions of the record |
| `use_parent` | **engine** | Tree structure via `parent_id`. With `?tree=true`, reads return a nested tree (up to 3 levels) ordered by `position` |
| `use_get_parent` | **engine** | String, e.g. `"category,tag"`. A filter `category=eq.<id>` also matches all descendants of `<id>` |
| `use_block` | **engine** | Page-builder blocks: `blocks_position` items are stored as `block-content` documents. Single reads return `blocks_position_data` |
| `use_approval_process` | **engine** | Editorial workflow on `status_approve` (draft → review → published…) driven by `rule` records per role, with `publish_start` / `publish_end` windows. Guests only see published records |
| `use_history` | **engine** | Writes a `history` entry on every insert, update and delete; reads include the last 20 entries (`?history=false` to omit) |
| `use_soft_delete` | **engine** | `DELETE` sets `deleted`, `deleted_at`, `deleted_by` instead of removing; reads hide deleted records |
| `use_pinned` | **engine** | Sorts by `pinned` (ascending, default 999) first and adds `is_pinned` |
| `use_form_builder` | **engine** | Returns every stored field (bypasses the schema projection), for free-form submissions |
| `use_generate_fields` | **engine** | String, e.g. `"code:uuidv4"`: fills listed fields with a UUID on insert when empty |
| `use_posttype` | **engine** | Sets `post_type` to the entity name on create; enables `entity_slug/slug` public URLs |
| `use_seo_path` | UI | SEO paths are actually controlled by `use_slug` |
| `use_parent_delete_childs`, `use_content_review`, `use_like`, `use_comment`, `use_save`, `use_import`, `comment_mode` | UI | Not implemented by the engine |

## 3.8 Other top-level fields (UI only)

`ui_schema` (form layout: `ui:order`, `ui:widget`), `entity_setting`, `settings`, `meta_data`, `entity_group`, `customTabsList`, `tenant_view`, `unique_keys`.

> `unique_keys` is **not** turned into a MongoDB index. Create unique indexes yourself if you need them (slug uniqueness is handled by `use_slug`).

## 3.9 Checklist for a new entity

1. Create `json/system/entity/<name>.json` (or `json/<TEAM_ID>/<TENANT>/entity/<name>.json`) with `collection_name`, `mongodb_save_data`, `databaseType` and `json_schema`. Alternatively `POST /api/v1/entity` with the same body.
2. Create a resource (`json/system/resource/<name>.json`).
3. Create at least one policy per role that needs access.
4. Restart the server if you edited the files by hand; changes made through the API apply immediately.

A complete walkthrough is in [Recipes](./08-recipes.md#81-expose-a-new-collection).
