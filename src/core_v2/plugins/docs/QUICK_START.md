# Core V2 Quick Start Guide

## 5-Minute Setup

### Step 1: Initialize Core V2

```typescript
import { initCoreV2, getCoreV2 } from './configs/core-global-v2';

// In your app startup
await initCoreV2();

// Get core service instance
const core = getCoreV2();
```

### Step 2: Create a Route Handler

```typescript
import { getCoreV2 } from './configs/core-global-v2';

// GET /api/v1/posts
async function getPosts(request, reply) {
  const core = getCoreV2();

  const user = {
    user_id: request.user?.id || 'anonymous',
    roles: request.user?.roles || ['guest'],
    tenant_id: request.headers['x-tenant-id'],
  };

  const result = await core.findAll(
    request.query,   // { limit, skip, order, select, ...filters }
    'post',          // collection name
    user,
    { databaseType: 'mongodb' }
  );

  return result;
}

// GET /api/v1/posts/:id
async function getPost(request, reply) {
  const core = getCoreV2();

  const result = await core.findById(
    'post',
    request.params.id,
    request.query,
    user,
    { databaseType: 'mongodb' }
  );

  return result;
}

// POST /api/v1/posts
async function createPost(request, reply) {
  const core = getCoreV2();

  const result = await core.create(
    'post',
    request.body,
    user,
    { databaseType: 'mongodb' }
  );

  return result;
}

// PUT /api/v1/posts/:id
async function updatePost(request, reply) {
  const core = getCoreV2();

  const result = await core.update(
    'post',
    request.params.id,
    request.body,
    user,
    { databaseType: 'mongodb' }
  );

  return result;
}

// DELETE /api/v1/posts/:id
async function deletePost(request, reply) {
  const core = getCoreV2();

  const result = await core.delete(
    'post',
    request.params.id,
    user,
    { databaseType: 'mongodb' }
  );

  return result;
}
```

---

## Common Query Examples

### Basic Queries

```bash
# Get all posts
GET /api/v1/posts

# With pagination
GET /api/v1/posts?limit=10&skip=0

# With sorting (newest first)
GET /api/v1/posts?order=-created_at

# With field selection
GET /api/v1/posts?select=title,slug,created_at
```

### Filtering

```bash
# Exact match
GET /api/v1/posts?status=1

# Greater than
GET /api/v1/posts?price[$gt]=100

# Contains text
GET /api/v1/posts?title[$contains]=news

# In array
GET /api/v1/posts?category[$in]=cat1,cat2,cat3

# Multiple filters (AND)
GET /api/v1/posts?status=1&is_pinned=true
```

### Relationships

```bash
# Include category
GET /api/v1/posts?select=*,category()

# Include multiple relations
GET /api/v1/posts?select=*,category(),featured_image(),created_by()

# Nested relations
GET /api/v1/posts?select=*,category(parent_id())

# Specific fields from relation
GET /api/v1/posts?select=title,category.title,category.slug
```

### Pagination

```bash
# Page-based
GET /api/v1/posts?limit=10&page=2

# Offset-based
GET /api/v1/posts?limit=10&skip=10

# Response includes pagination info
{
  "data": [...],
  "count": 100,
  "pagination": {
    "current_page": 2,
    "last_page": 10,
    "total": 100,
    "hasMore": true
  }
}
```

---

## Entity Configuration

### Required Fields in Entity Collection

```json
{
  "_id": "ObjectId",
  "schema_name": "post",
  "collection_name": "post",
  "mongodb_save_data": "post-type-content",

  // Plugin flags
  "use_timestamp": true,
  "use_soft_delete": true,
  "use_locale": true,
  "use_slug": true,
  "use_pinned": true,
  "use_parent": false,
  "use_history": true,
  "use_block": true,

  // JSON Schema for validation
  "json_schema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "slug": { "type": "string" },
      "category": {
        "type": "string",
        "widget": "relation",
        "typeRelation": {
          "_id": "category",
          "type": "n-1"
        }
      }
    },
    "required": ["title", "slug"]
  }
}
```

### Relationship Types

| Type in Schema | Core Type | Result |
|---------------|-----------|--------|
| `n-1` | `many-to-one` | Object |
| `1-1` | `one-to-one` | Object |
| `1-n` | `one-to-many` | Array |
| `n-n` | `many-to-many` | Array |

---

## Plugin Effects

### `use_timestamp`

Automatically sets:
- `created_at` on insert
- `updated_at` on insert/update

### `use_soft_delete`

- DELETE sets `deleted: true` instead of removing
- GET queries exclude `deleted: true` items

### `use_locale`

- Validates locale uniqueness on insert
- Populates `languages` field with available locales

### `use_slug`

- Generates unique slug from title
- Manages seopath records for SEO

### `use_pinned`

- Sorts by `pinned` field (lower = higher priority)
- `is_pinned: true` items appear first

### `use_parent`

- Supports parent-child hierarchy
- Can return tree structure with `?tree=true`

---

## Error Handling

```typescript
import { isCoreError, isAuthorizationError } from './core_v2';

try {
  const result = await core.findAll(...);
  return result;
} catch (error) {
  if (isAuthorizationError(error)) {
    return reply.status(403).send({
      message: 'Access denied',
      statusCode: 403,
    });
  }

  if (isCoreError(error)) {
    return reply.status(error.statusCode || 500).send({
      message: error.message,
      statusCode: error.statusCode,
      code: error.code,
    });
  }

  throw error;
}
```

---

## Tips & Best Practices

### 1. Always Pass User Context

```typescript
// Good
const user = {
  user_id: request.user.id,
  roles: request.user.roles,
  tenant_id: request.headers['x-tenant-id'],
};

// Bad - missing context causes RBAC issues
const user = { roles: ['guest'] };
```

### 2. Use Select for Performance

```typescript
// Good - only fetch needed fields
{ select: 'title,slug,created_at' }

// Bad - fetches everything including large fields
{ select: '*' }
```

### 3. Handle Post-Type Content

```typescript
// For post-type entities, use the schema name
const result = await core.findAll(
  { ...params, post_type: 'tin-tuc' },
  'post-type-content',
  user,
  {
    postTypeCollectionName: 'tin-tuc',
    databaseType: 'mongodb'
  }
);
```

### 4. Skip RBAC for Internal Operations

```typescript
// Internal/system operations can skip RBAC
const result = await core.findAll(
  params,
  'system-collection',
  systemUser,
  { skipRbac: true }
);
```

### 5. Use Correct Operators

```typescript
// String search
{ 'title[$contains]': 'search term' }

// Array membership
{ 'category[$in]': 'id1,id2,id3' }

// Numeric comparison
{ 'price[$gte]': '100' }
```

---

## Troubleshooting

### "Access denied" Error

1. Check user roles in rolepermission collection
2. Verify collection is not in bypassAccessList
3. Check if action (GET-ALL, POST, etc.) is allowed

### Empty `languages` Field

1. Ensure `use_locale: true` in entity config
2. Check if `locale` plugin is in `mainPlugins`

### Relationships Return Array Instead of Object

1. Check relationship type in entity schema (`n-1` = object)
2. Verify relationship is registered in relationshipRegistry

### Missing Fields in Response

1. Check RBAC field permissions
2. Verify plugin is enabled in entity config
3. Check select clause includes the field
