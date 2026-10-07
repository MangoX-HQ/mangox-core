# REST API Adapter — Federation Transport

Cho phép một Core instance gọi dữ liệu từ một Core instance khác (hoặc bất kỳ REST API nào)
thông qua HTTP, thay vì kết nối trực tiếp đến database.

---

## 1. Tại sao cần?

Hiện tại mỗi Core instance giao tiếp trực tiếp với database (MongoDB, PostgreSQL...).
Khi hệ thống phát triển thành nhiều services, có những tình huống:

- **Multi-tenant isolation**: tenant A và tenant B chạy trên 2 Core instance riêng, Core A cần đọc một số dữ liệu từ Core B
- **Federated data**: dữ liệu `user` nằm ở Core Auth, dữ liệu `order` nằm ở Core Commerce — cần join trong query
- **Third-party API**: gọi dữ liệu từ Shopify, Stripe, external CRM... như thể chúng là collections nội bộ
- **Read replica via API**: thay vì kết nối DB replica trực tiếp, gọi qua một Core instance chuyên read

---

## 2. Kiến trúc tổng quan

```
┌──────────────────────────────────────────────────────┐
│                     Core A                           │
│                                                      │
│  Request                                             │
│    │                                                 │
│    ▼                                                 │
│  QueryConverter                                      │
│  URL params → IntermediateQuery                      │
│    │                                                 │
│    ▼                                                 │
│  Authorization (Core A RBAC)                         │
│  + inject security filters                           │
│    │                                                 │
│    ▼                                                 │
│  AdapterRegistry                                     │
│  collection 'user' → RestApiAdapter  ───────────┐    │
│  collection 'post' → MongoDBAdapter             │    │
│                                                 │    │
└─────────────────────────────────────────────────│────┘
                                                  │
                          HTTP GET /api/v1/user?  │
                          status=eq."active"&     │
                          tenant_id=eq."abc"       │
                                                  │
┌─────────────────────────────────────────────────│────┐
│                     Core B                      │    │
│                                                 │    │
│  ◄───────────────────────────────────────────── ┘    │
│    │                                                 │
│    ▼                                                 │
│  QueryConverter → IntermediateQuery                  │
│    │                                                 │
│    ▼                                                 │
│  Authorization (Core B RBAC)                         │
│    │                                                 │
│    ▼                                                 │
│  MongoDBAdapter → Execute                            │
│    │                                                 │
│    ▼                                                 │
│  Response { data: [...], count: N }                  │
│                                                 │    │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
                    Core A normalize
                    → QueryResult<T>
                    → trả về client
```

---

## 3. Flow chi tiết: Parse → Intermediate → Serialize lại

Query đi qua **2 vòng parse** — một ở Core A, một ở Core B.

```
[Client]
  │
  │  GET /api/v1/user?status=eq."active"&limit=10
  │
  ▼
[Core A — QueryConverter]
  │  Parse URL params → IntermediateQuery
  │
  │  {
  │    type: 'read',
  │    collection: 'user',
  │    filter: { field: 'status', operator: 'eq', value: 'active' },
  │    pagination: { limit: 10 }
  │  }
  │
  ▼
[Core A — AuthorizationService]
  │  Check RBAC → inject security conditions
  │
  │  {
  │    type: 'read',
  │    collection: 'user',
  │    filter: { field: 'status', operator: 'eq', value: 'active' },
  │    securityFilters: [
  │      { field: 'tenant_id', operator: 'eq', value: 'abc' }  ← inject
  │    ],
  │    pagination: { limit: 10 }
  │  }
  │
  ▼
[Core A — RestApiAdapter.convertQuery()]
  │  Serialize IntermediateQuery → MongoREST URL params
  │
  │  GET https://core-b/api/v1/user
  │      ?status=eq."active"
  │      &tenant_id=eq."abc"      ← security filter đã inject
  │      &limit=10
  │
  ▼
[Core B — nhận request như HTTP thông thường]
  │  QueryConverter → IntermediateQuery → MongoDBAdapter → Execute
  │
  ▼
[Core B — Response]
  │  { data: [...], count: 5, pagination: { ... } }
  │
  ▼
[Core A — normalize → QueryResult<T>]
  │
  ▼
[Client — nhận kết quả]
```

**Tại sao không forward thẳng mà phải qua Intermediate?**

Vì bước Intermediate ở Core A là nơi:
1. **RBAC của Core A** kiểm tra user có quyền gọi collection này không
2. **Security filters được inject** (tenant isolation, ownership checks...)
3. **Field projection được filter** theo policy của Core A
4. **Plugins của Core A** có thể transform query (vd: locale plugin thêm language filter)

Nếu passthrough thẳng → bỏ qua toàn bộ security layer của Core A.

---

## 4. Cấu hình Adapter

```typescript
// Collection routing config
const collectionAdapterMap = {
  // Local collections → MongoDB trực tiếp
  post:    { type: 'mongodb', url: 'mongodb://localhost:27017/main' },
  comment: { type: 'mongodb', url: 'mongodb://localhost:27017/main' },

  // Remote collections → gọi qua Core B
  user:    {
    type: 'rest',
    baseUrl: 'https://core-auth.internal/api/v1',
    auth: { type: 'bearer', token: process.env.CORE_B_TOKEN },
  },
  role:    {
    type: 'rest',
    baseUrl: 'https://core-auth.internal/api/v1',
    auth: { type: 'bearer', token: process.env.CORE_B_TOKEN },
  },

  // Third-party API
  shopify_product: {
    type: 'rest',
    baseUrl: 'https://my-shop.myshopify.com/api/2023-10',
    auth: { type: 'apikey', token: process.env.SHOPIFY_TOKEN },
    filterStyle: 'custom',
    filterSerializer: (filters) => ({ /* custom mapping */ }),
    responseMapping: { dataKey: 'products', countKey: 'count' },
  },
};
```

---

## 5. Các trường hợp đặc biệt

### 5.1 JOIN giữa local và remote collection

```
Query: GET /api/v1/post?select=*,user(name,avatar)

post  → MongoDBAdapter (local)
user  → RestApiAdapter (Core B)
```

**Vấn đề**: MongoDB `$lookup` không thể join sang Core B.

**Giải pháp**: RestApiAdapter xử lý join kiểu **client-side join**:

```
1. Fetch posts từ MongoDB
   [{ _id: '1', title: 'Hello', author_id: 'u1' }, ...]

2. Collect unique author_ids: ['u1', 'u2', 'u3']

3. Fetch users từ Core B:
   GET /api/v1/user?_id=in.["u1","u2","u3"]&select=name,avatar

4. Merge kết quả:
   [{ _id: '1', title: 'Hello', user: { name: 'Alice', avatar: '...' } }, ...]
```

Performance note: N+1 query được tránh bằng batch fetch (1 request, không phải N requests).

---

### 5.2 Filter trên field của remote collection

```
Query: GET /api/v1/post?user.role=eq."admin"
(Lấy posts của users có role = admin)
```

**Vấn đề**: `user.role` nằm ở Core B, không thể filter trực tiếp trong MongoDB.

**Giải pháp**: 2 bước query:

```
1. Fetch user_ids từ Core B:
   GET /api/v1/user?role=eq."admin"&select=_id
   → ['u1', 'u3', 'u7']

2. Fetch posts với filter đã resolve:
   GET /api/v1/post?author_id=in.["u1","u3","u7"]
```

Đây gọi là **subquery resolution** — cần detect và handle tự động.

---

### 5.3 Write operations (create/update/delete)

```
POST /api/v1/user    → forward body → Core B POST /api/v1/user
PATCH /api/v1/user/1 → forward body → Core B PATCH /api/v1/user/1
DELETE /api/v1/user?ids=1,2 → Core B DELETE /api/v1/user?ids=1,2
```

**Lưu ý**: Plugins của Core A (timestamp, slug...) vẫn chạy trước khi gửi.
Core B cũng chạy plugins của nó → có thể bị **double-run** (vd: timestamp được set 2 lần).

**Giải pháp**: Dùng header `X-Skip-Plugins: timestamp,slug` để Core B biết skip.

---

### 5.4 Authentication & Token propagation

Có 2 mode:

**Mode 1 — Service token** (Core A dùng token cố định để gọi Core B):
```
Core A → Core B với token của service account
Core B authorize theo service account's permissions
```

**Mode 2 — User token passthrough** (forward token của end user):
```
Core A nhận request từ user (token: user_jwt)
Core A forward token này sang Core B
Core B authorize theo quyền của user thực sự
```

Mode 2 an toàn hơn nhưng cần Core B tin tưởng token từ Core A.

---

### 5.5 Pagination consistency

Khi mix local + remote trong 1 response:

```
GET /api/v1/post?limit=10

Core A fetch 10 posts từ MongoDB
Core A cần enrich thêm user data từ Core B

→ Core B pagination hoàn toàn độc lập
→ Không thể sort/paginate toàn bộ kết quả merged
```

**Giải pháp**: Paginate theo primary source (MongoDB), remote chỉ là enrichment.

---

### 5.6 Error handling & fallback

```
Core B timeout / unavailable
  ↓
RestApiAdapter throws RestAdapterError

Options:
  a) Hard fail — trả error về client
  b) Partial response — trả data local, field remote = null
  c) Stale cache — dùng cached response từ lần gọi trước
```

Config per collection:
```typescript
user: {
  type: 'rest',
  baseUrl: '...',
  fallback: 'partial',   // 'fail' | 'partial' | 'cache'
  timeout: 3000,
  retries: 2,
}
```

---

### 5.7 Circular dependency

```
Core A gọi Core B
Core B trong quá trình xử lý lại gọi Core A
→ infinite loop
```

**Giải pháp**: Request ID propagation + loop detection header:
```
X-Request-Chain: core-a → core-b
```
Khi Core B thấy `core-b` đã trong chain → reject với lỗi circular dependency.

---

## 6. Field projection (select) — Core vs Third-party

`select` hoạt động khác nhau tùy loại target API.

### Core-to-Core — server-side projection ✓

Core B hiểu MongoREST `?select=field1,field2` → projection xảy ra tại database, chỉ field được chọn đi qua wire.

```
IntermediateQuery.select = ['title', 'slug']
  → ?select=title,slug
  → Core B: MongoDB $project { title:1, slug:1 }
  → Response chỉ có 2 fields
```

### Third-party API — client-side projection

API ngoài (Shopify, Stripe...) không hiểu `select`, trả về fixed schema toàn bộ fields. RestApiAdapter phải tự filter response sau khi nhận:

```
IntermediateQuery.select = ['title', 'price']
  → Shopify API không hỗ trợ → trả về 40+ fields
  → RestApiAdapter filter thủ công:
    data.map(item => pick(item, ['title', 'price']))
```

Config:
```typescript
// Core-to-Core: projection server-side
core_b_user: {
  type: 'rest',
  baseUrl: 'https://core-b/api/v1',
  clientSideProjection: false,
}

// Third-party: filter thủ công
shopify_product: {
  type: 'rest',
  baseUrl: 'https://my-shop.myshopify.com/api/2023-10',
  clientSideProjection: true,   // ← bật khi API không hỗ trợ select
}
```

Tương tự cho **sort** và **filter**: third-party API có thể không hỗ trợ → phải sort/filter client-side sau khi fetch.

| Feature | Core-to-Core | Third-party |
|---------|-------------|-------------|
| select | Server-side (Core B) | Client-side (sau fetch) |
| filter | Server-side (Core B) | Có thể phải client-side |
| sort | Server-side (Core B) | Có thể phải client-side |
| pagination | Server-side (Core B) | Fetch all rồi paginate |

### Nguyên tắc: không silently compensate

Nếu API không hỗ trợ filter/sort/pagination, **không nên âm thầm fetch all rồi xử lý client-side**.
Thay vào đó, khai báo capabilities và throw lỗi rõ ràng khi user dùng feature không được hỗ trợ:

```
RestAdapterError: Collection 'shopify_product' does not support dynamic filtering.
Requested: { status: eq."active" }
→ Remove the filter or use a filterable collection.
```

Client-side fallback chỉ chấp nhận được với **static/tiny datasets** (currency codes, country list...).
Với bất kỳ collection nào có thể grow → fail fast, không compensate ngầm.

```typescript
interface RestAdapterCapabilities {
  filter: boolean;     // hỗ trợ filter động
  select: boolean;     // hỗ trợ field projection
  sort: boolean;       // hỗ trợ sort
  pagination: boolean; // hỗ trợ limit/offset
}

// Khai báo trong config
shopify_product: {
  type: 'rest',
  baseUrl: '...',
  capabilities: { filter: false, select: false, sort: true, pagination: true }
}
```

---

## 7. So sánh các mode

| | Full Intermediate | Passthrough |
|---|---|---|
| RBAC của Core A | ✅ Có | ❌ Không |
| Security filters inject | ✅ Có | ❌ Không |
| Plugin transforms | ✅ Có | ❌ Không |
| Performance | Chậm hơn (2x parse) | Nhanh hơn |
| Use case | Production, security-critical | Internal trusted services |

Passthrough implementation:
```typescript
// Bỏ qua CoreService hoàn toàn, proxy thẳng
app.get('/api/v1/:collection', async (req, reply) => {
  if (isRemoteCollection(req.params.collection)) {
    return proxy(req, CORE_B_URL); // forward raw request
  }
  return coreService.findAll(...);
});
```

---

## 8. Implementation checklist

- [ ] Thêm `'rest'` vào `DatabaseType`
- [ ] Tạo `RestApiAdapter` implements `IDatabaseAdapter`
- [ ] Tạo `RestQueryConverter` — IntermediateQuery → MongoREST params
- [ ] Tạo `RestQueryExecutor` — fetch + normalize response
- [ ] Config schema cho `RestAdapterConfig`
- [ ] Register factory trong `AdapterRegistry`
- [ ] Collection routing (per-collection adapter selection)
- [ ] Client-side join handler
- [ ] Error handling + fallback strategies
- [ ] Circular dependency detection
- [ ] Token propagation config
