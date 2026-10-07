# `_front` Legacy API — Migration Spec

Tổng hợp toàn bộ API trong `current_code/src/module/_front/` để hình dung trước khi migrate sang `mgs-core-v2`. Mỗi endpoint kèm: hành vi runtime, transform đặc thù, và đánh giá khả năng chuyển sang data-driven (action + policy JSON) hay phải giữ controller TS.

## Status Legend

| Marker | Nghĩa |
|---|---|
| 🟢 **Pure** | Chỉ seed JSON (action + policy + entity setting). KHÔNG cần code TS, KHÔNG cần `code` record. |
| 🟢🌳 **Pure + plugin** | Pure nhưng dùng plugin có sẵn (`use_parent` cho tree, `use_locale` cho i18n, …) |
| 🟡 **Hybrid** | Pure được phần lớn, cần `code` record ngắn (≤20 dòng JS-in-DB) cho 1 transform nhỏ. |
| 🔴 **TS** | Bắt buộc controller TS riêng (multipart upload, cross-tenant aggregation, populate nested ≥3 cấp). |
| ⚪ **Skip** | Không thuộc front route (auth required → admin route, hoặc đã có module khác như `_auth`). |

## Mục lục

| # | Endpoint | Auth | Status | Phân loại |
|---|---|---|---|---|
| 1 | `GET /front/:entityName` | No | 🟢 | Generic CRUD |
| 2 | `GET /front/:entityName/:id` | No | 🟢 | Generic CRUD |
| 3 | `PUT /front/:entityName/:id` | No | 🟢 | Generic CRUD (siết policy) |
| 4 | `GET /front/:entityName/:id/children` *(URL mới)* | No | 🟢🌳 | Tree/Hierarchy |
| 5 | `GET /front/post-type` | No | 🟢 | Post-type meta |
| 6 | `GET /front/post-type-content` | No | 🟢 | Post-type content |
| 7 | `GET /front/seopath/:slug` *(URL mới)* | No | 🟢 | Seopath lookup (thay 1-layer detail) |
| 8 | `GET /front/seopath/:postType/:slug` *(URL mới)* | No | 🟢 | Seopath 2-layer |
| 9 | `GET /front/detail-v2/:slug` | JWT | ⚪ | Chuyển admin route |
| 10 | `GET /front/detail-v2/:postType/:SEOSlug` | JWT | ⚪ | Chuyển admin route |
| 11 | `GET /front/comment` | No | 🟡 | Comment list (children_count cần `code`) |
| 12 | `POST /front/comment` | No | 🟢 | Comment submit |
| 13 | `GET /front/layout` | No | 🔴 | Populate group-field cấp 3 |
| 14 | `POST /front/form-builder-content/:slug` | No | 🔴 | Multipart + email |
| 15 | `GET /front/sitemap/page` | No | 🟡 | Strip slug regex via `code` |
| 16 | `GET /front/sitemap/post` | No | 🟡 | Strip slug regex via `code` |
| 17 | `POST /front/sitemap/post-v2` | No | 🔴 | Fan-out parallel multi-locale |
| 18 | `GET /front/sitemap/blocks` | No | 🔴 | Cross-tenant aggregation |
| 19 | `POST /front/auth/login` | No | ⚪ | Đã có ở `_auth` |
| 20 | `GET /front/auth/me` | JWT | ⚪ | Đã có ở `_auth` |
| (–) | `uploadCVDocument` | – | 🔴 | Multipart, internal |

**Tóm số**: 🟢 8 endpoint pure, 🟢🌳 1 với plugin, 🟡 3 hybrid, 🔴 5 phải TS, ⚪ 4 skip/reuse.

---

## 1. `GET /front/:entityName` — List entity (generic)

**Controller**: `FrontContoller.getEntityList`

**Mục đích**: Trả về danh sách record của bất kỳ collection nào (post, category, page, …) cho người dùng cuối.

**Input**
- Path: `entityName`
- Query: filter bất kỳ (MongoREST), `post_type`, `is_pinned=true|false`, `order`, `relationDeep`, `select`, `locale`, `limit`, `page`
- Header: `x-tenant-id` (nếu collection cần tenant)

**Pipeline**
1. `applyFilterMode(queryData)` — nếu `appSettings.filter_mode === 'OLD'` thì chạy `convertSearchSyntax` chuyển query string cũ sang MongoREST
2. `convertPinnedFilter`: `is_pinned=true → pinned=eq.999`, `false → pinned=neq.999`
3. Trừ `block-content`, thêm `or=(status=eq."1",status=exists.false)` — chỉ lấy active hoặc record không có status
4. Lấy `relationDeep` từ params (nếu có) → `options.relationDeep`
5. `options.postTypeCollectionName = queryData.post_type` (nếu có)
6. `frontService.findAllQuery(entityName, queryData, [user?.role_name ?? 'default'], options)`

**Service `findAllQuery` làm gì**
- `order_pinned=false` thì bỏ `pinned` khỏi order, ngược lại prepend `pinned,`
- Ghép `order=pinned,<user_order>,-created_at,-updated_at` + dedupe
- Force `or=status=eq."1",status=exists.false`
- Build `select` theo `appSettings.select_mode`:
  - Mode mới: gọi `getSelect()` đọc `entity_setting.fe_list` (whitelist do admin set per entity)
  - Mode cũ: walk `relationshipRegistry` build select chuỗi `relA(relB(),relC(or=(locale=exists.false,locale=eq.${locale})))` 2 cấp, skip `updated_by/created_at/updated_at/status/tenant_id/locale_id/role/blocks_position/email`
- Default `limit=10`, page→skip
- Override `tenant_id` từ header (xóa khi entity ∈ `LIST_COLLECTION_WITHOUT_TENANT = ['tenant','user','entity','group-field','media']`)
- `coreGlobal.getCore().findAll(...)`
- Enrich `meta_data`: lookup `entity` collection theo `mongodb_collection_name`, lấy `languages.locale → slug`, build `path = "${postTypeSlug}/${slug}"`. Set `item.meta_data = {slug, type:'direct', redirect_to:null, entity, entity_field, path: {[locale]: path}}`
- `sanitizeSensitiveFields(data, collectionName, 'GET-LIST')`: strip `password/role/role_name/email/role_system/status/updated_by/history/reason/rule/language/json_schema/ui_schema` ở mọi cấp (recursive), trừ collection `form-builder`
- `processFileFields`: với array media (có `_id+filename+created_at`), build `path = "${minio.public}/${bucketName}/${fileName}"`. Field thuộc `['featured_image','avatar','cover','image','file','attachment']` thì chuyển array 1 phần tử → object

**Output**: `{data: [...], count, statusCode, pagination}`

**Migration**: 🟢 **Pure** — action `list-public` + policy guest với `select=...` whitelist + plugin `use_pinned`, `use_soft_delete`, `use_locale`. Meta_data slug enrichment đã có trong `common_v2.common.service._getQuery`. Sensitive fields → policy `select=` (whitelist). Pinned/status filter → `policy.condition`. **Chỉ cần seed JSON.**

---

## 2. `GET /front/:entityName/:id` — Detail entity

**Controller**: `FrontContoller.getEntityDetails`

**Mục đích**: Lấy 1 record theo `_id`.

**Pipeline**
- Tương tự (1) nhưng dùng `coreGlobal.getCore().findById(collection, queryData, id, roles, options)`
- Force `or=(status=eq."1",status=exists.false)`
- Select build từ `getSelect(collection)` (mode mới đọc `entity_setting.fe_detail`) hoặc walk relation
- Sanitize sensitive fields
- Trả về `{data: result.data[0]}` (unwrap mảng 1 phần tử)

**Migration**: 🟢 **Pure** — action `read-public` `path:/:id` (đã seed), policy guest với select.

---

## 3. `PUT /front/:entityName/:id` — Update từ front

**Controller**: `FrontContoller.update`

**Mục đích**: Cho phép front cập nhật record (use case ban đầu giới hạn `['tenant','group-field']`, nhưng comment-out → giờ mở hết)

**Pipeline**: `frontService.update({entityName, id, body, roles, options})` → `coreGlobal.getCore().update(...)` → sanitize sensitive fields

**Lưu ý nguy hiểm**: Phiên bản comment-out giới hạn `allows_entities`. Phiên bản hiện tại không filter, ai cũng PUT được bất kỳ entity. Khi migrate phải SIẾT bằng policy guest condition.

**Migration**: 🟢 **Pure** — action `update-public` PUT, policy guest với `condition` cực chặt + `form` trỏ form-setting để whitelist writable fields (vd. chỉ cho update `tenant.theme_config`, `group-field.fields`).

---

## 4. `GET /front/:entityName/:id/children` *(URL mới)* — Lấy children theo parent_id

**Controller cũ**: `FrontContoller.getChildren` — URL cũ `/front/children/:entityName/:id`

**Mục đích**: Lấy tất cả record có `parent_id=<id>`, có `children_count` cho mỗi child (đệ quy 1 cấp).

**Đề xuất URL mới**: `/front/<entity>/:parent_id/children` — segment-first là resource, hợp pattern `loadAction`. Action `path:"/:parent_id/children"`.

**Cách làm pure**:
- Action `list-children-public` `path:"/:parent_id/children"` method `GET` auth `false`
- Policy guest condition: `select=...` whitelist + filter implicit qua params (params.parent_id merge vào queryData → filter `parent_id=eq.<id>`)
- Entity bật `use_parent: true` → plugin `parent.plugin.ts` đã có

**Bonus full tree** (nếu cần): client gửi `?tree=true` → `use_parent` plugin auto:
- Filter `is_root=eq.true` (chỉ lấy root)
- Sort `position desc`
- `after` phase: `buildTreeFromFlat` build nested tree

**`children_count` per child**: KHÔNG có plugin native. Cần `code` post-process ngắn (~10 dòng) → đẩy lên **🟡 Hybrid** nếu cần count. Bỏ count → **🟢 Pure**.

**Migration**: 🟢🌳 **Pure + plugin** (nếu bỏ children_count) hoặc 🟡 **Hybrid** (nếu giữ count).

---

## 5. `GET /front/post-type` — List entity có `use_posttype=true`

**Controller**: `FrontContoller.getPostTypeList`

**Mục đích**: Liệt kê tất cả post-type (entity với `use_posttype: true`).

**Pipeline**
1. Force `queryData.select = '*'`, `use_posttype: true`, lấy `tenant_id` từ header
2. `convertPinnedFilter`
3. `frontService.findAllQuery('entity', queryData, ['default'], options)`
4. Map kết quả: `item.slug = item.mongodb_collection_name`, delete field này

**Migration**: 🟢 **Pure** — action `list-public` trên resource `post-type` (hoặc reuse `entity` resource với policy condition `use_posttype=eq.true`). Rename field `mongodb_collection_name → slug` qua `select=mongodb_collection_name:slug,*` (MongoREST alias) hoặc bỏ qua, để client tự xử.

---

## 6. `GET /front/post-type-content` — Content của 1 post-type

**Controller**: `FrontContoller.getPostTypeContent`

**Mục đích**: Lấy danh sách content thuộc 1 post-type cụ thể (qua field `post_type=<collection_name>`).

**Pipeline**
1. `applyFilterMode`
2. **`is_pinned` logic NGƯỢC** (chú thích `intentional`): `true → pinned=neq.999`, `false → pinned=eq.999`
3. Lấy `relationDeep` từ query
4. `frontService.findAllQuery('post-type-content', queryData, ['default'], {...options, postTypeCollectionName: queryData.post_type, tenant_id})`

**`findAllQuery` nhánh `post-type-content`** (khi `postTypeCollectionName` undefined VÀ collection === 'post-type-content'):
- `select = selectPostTypeContent` (`-history,-status,-updated_by,-reason,-rule,-tenant_id,-languages`)
- `coreGlobal.getCore().findAll(queryData, 'post-type-content', roles, options)`
- Mỗi item: lookup `relationshipRegistry.getForTable(item.post_type)`, build relation map: collect ids per relation
- Bulk fetch các collection target (locale-aware: `or=(locale=exists.false,locale=eq.${locale})`)
- Index theo `foreignField` (`_id` hoặc field khác)
- `processNestedRelations`: 1 cấp nữa, vd. `tag.tag_group → tag-group` (hardcoded config `nestedRelationConfig`)
- Map data: replace id values bằng full object (array hoặc single)
- Bonus: replace `created_by` ObjectId bằng user object
- Build `meta_data` per item (post-type slug từ `entity.languages[locale].slug`)
- Sanitize sensitive + processFileFields

**Migration**: 🟢 **Pure** (theo hướng v2 mới):

Thay vì 1 collection `post-type-content` polymorphic, mỗi post-type là 1 entity riêng trong v2 (entity `post`, `category`, `news`, …) với `json_schema` declare relation tường minh. Khi đó:

- `/front/post?post_type=blog` → không cần. Đổi thành `/front/post` (resource `post`)
- `select=*,category(),tag(),featured_image()` viết tường minh trong `policy.condition`
- Relation expansion locale-aware → plugin `use_locale` lo (`select=*,category(or=(locale=exists.false,locale=eq.@options:locale))`)
- `is_pinned` ngược → policy chuyên cho từng resource có thể tùy biến

Kết quả: KHÔNG cần endpoint `/front/post-type-content` polymorphic nữa, mỗi post-type là 1 endpoint riêng. Cleaner và pure data-driven.

---

## 7. `GET /front/seopath/:slug` *(URL mới)* — Detail 1-layer qua seopath

**Controller cũ**: `FrontContoller.detailOneLayerApi` — URL cũ `/front/detail/:slug`

**Mục đích cũ**: Front gọi 1 slug, service tự tìm collection thật qua seopath, fetch record, build meta_data.

**Pipeline cũ (13 bước)**
1. Lấy entity meta `slug='page'`
2. Build `fullPathSlug = "${slug}**${entity._id}---${tenant_id}**"`
3. `core.findAll({slug: fullPathSlug}, 'seopath')`
4. → 404 nếu không có
5. Lấy `entity_id`, gọi `findById('entity')`
6. Gard against `use_posttype`
7. Build select theo `entity_save_data`
8. `findById(entity_save_data, select, related_id[0])` fetch record thật
9. Filter `status === '1'`
10. Lấy locale versions
11. Build `meta_data` với path map locale

**Đề xuất v2 (đổi URL + lùi 1 bước)**:

Thay vì 1 endpoint trả full content + meta, tách thành **2 endpoint thuần CRUD**:
- `GET /front/seopath/:slug` → trả seopath record (resource `seopath`, action `read-by-slug-public`, `path:/:slug`)
- Client đọc `seopath.entity_save_data` + `seopath.related_id[0]`
- Client gọi tiếp `GET /front/<entity_save_data>/<related_id>` → record thật

**Cách làm pure**:
- Action `read-by-slug-public` `slug:"read-by-slug-public", path:"/:slug", method:"GET", auth:false`
- Policy guest cho resource `seopath`: `condition: "select=*,entity_id()"` (populate entity meta luôn)

**Vấn đề `**markers**` trong seopath.slug**: nếu schema seopath vẫn lưu slug với `**entity_id---tenant_id**`, không match được. **Phải clean seopath schema**: thêm field `clean_slug` (plain) hoặc bỏ markers — chỉnh ngay trong pipeline lưu seopath. Sau khi clean, filter `slug=eq.<value>` chạy thẳng.

**Migration**: 🟢 **Pure** (sau khi clean seopath.slug). Client làm 2 call thay vì 1 — chấp nhận được vì SEO routing thường cache. Nếu muốn 1 call: dùng `policy.code` để chain fetch related (~15 dòng JS-in-DB) → 🟡 Hybrid.

---

## 8. `GET /front/seopath/:postType/:slug` *(URL mới)* — Detail 2-layer qua seopath

**Controller cũ**: `FrontContoller.detailTwoLayerApi` — URL cũ `/front/detail/:postType/:SEOSlug`

**Mục đích cũ**: Front gọi `/front/detail/post/news-today` → detect post-type + SEO slug → trả record của post-type-content.

**Đề xuất v2**: Tương tự (7), 2 call:
- `GET /front/seopath/:postType/:slug` → action `read-public-2-layer` `path:"/:postType/:slug"`
  - params = `{postType: "post", slug: "news-today"}` → filter `postType=eq.post & slug=eq.news-today`
  - **Vấn đề**: seopath schema không có field `postType`. Cần dùng field thật như `entity_slug`. Action `path:"/:entity_slug/:slug"`.
- Client đọc seopath → call entity thật

**Policy guest**: 
```
condition: "select=*,entity_id()"
```

**Migration**: 🟢 **Pure** (sau khi clean seopath schema).

---

## 9-10. `GET /front/detail-v2/:slug` và `/front/detail-v2/:postType/:SEOSlug`

**Controller**: `detailOneLayerApiV2`, `detailTwoLayerApiV2` — có `preHandler: jwtGuard`

**Khác (7), (8)**:
- Không build `fullPathSlug` (dùng slug trực tiếp: `core.findAll({slug, ...query}, 'seopath')`)
- Không tự filter `status`
- Dùng `roles=['admin']` thay vì `['default']` → bypass nhiều check

**Migration**: ⚪ **Skip** (auth required → không thuộc front). Chuyển sang `common_v2` admin route với action `auth:true`, role admin có cùng quyền như (7), (8).

---

## 11. `GET /front/comment` — List comment root

**Controller**: `FrontContoller.getComments`

**Pipeline `frontService.getComments`**:
- `page→skip`
- Force `is_root: 'true'`, `or='status=eq."1"'`, `order=<user>,-created_at`
- `core.findAll(..., 'comment', ['default'])`
- Cho mỗi comment, count children: `core.findAll({parent_id: comment._id, or:'status=eq."1",status=exists.false'}, 'comment') → length`

**Migration**: 🟡 **Hybrid**. List cơ bản pure (action `list-public` trên resource `comment`, policy condition `is_root=eq.true&status=eq."1"&order=-created_at&select=*`). `children_count` per item → `code` post-process (~5 dòng) đẩy lên Hybrid. Bỏ count → 🟢 Pure.

---

## 12. `POST /front/comment` — Submit comment

**Controller**: `FrontContoller.submitComment`

**Pipeline**:
- Force `data.status = '2'` (pending moderation)
- `frontService.submitComment(data, options)`: nếu không có `parent_id` → `is_root=true`, else `false`. Sau đó `core.create('comment', data, ['admin'])` — **bypass RBAC** bằng role admin.

**Migration**: 🟢 **Pure** — action `create-public` POST trên resource `comment`. `policy.form` trỏ form-setting whitelist `[content, parent_id, author_name, author_email]` + default `status=2`. `is_root` field có thể derive bằng plugin nhỏ HOẶC để hẳn vào field (frontend gửi `parent_id=null` → is_root=true qua validation logic). Nếu cần JS để set is_root từ parent_id → ~3 dòng `code` → 🟡 Hybrid.

---

## 13. `GET /front/layout` — Layout với populate cấp 3

**Controller**: `FrontContoller.getLayout`

**Mục đích**: Lấy layout (header/footer/sidebar templates) + populate group-field từ menu.

**Pipeline**
1. Tương tự `getEntityList` với `entityName='layout'`
2. **Sau khi findAll**: walk `result.data → layout.templates[] → header/footer/sidebar[] → menu[].groupfield[]`
3. Collect tất cả ID group-field vào Set
4. Bulk fetch `core.findAll({_id: 'in.[ids]'}, 'group-field', ['admin'])`
5. Build Map `id → group-field object`
6. Walk lại nested array, replace ID bằng full object

**Migration** (cập nhật chính xác):

Core_v2 đã có populate cho 4 pattern:
- ✅ Flat single ID: `category: <id>` → `select=*,category()`
- ✅ Flat array of IDs: `tags: [id1, id2]` → `select=*,tags()`
- ✅ Object-nested path: `profile.course.department` → dot notation + `$mergeObjects` recursive (xem `join-converter.ts:555-605`)
- ❌ **Array-of-objects nested**: `templates[].header[].groupfield` → MongoDB `$lookup` flatten qua array OK nhưng `$mergeObjects` không reconstruct được cấu trúc array-of-array

Layout cũ là case ❌ (3 cấp array). 3 cách giải:

- **Cách A — Redesign schema sang relation thật** (🟢 Pure):
  ```
  layout { template_id }
  template { header_ids: [menu_id], footer_ids, sidebar_ids }
  menu { groupfield_ids: [group_field_id] }
  ```
  `select=*,template_id(*,header_ids(*,groupfield_ids()))` populate cả 3 cấp pure.

- **Cách B — Simplify embedded thành object thay vì array** (🟢 Pure):
  ```
  layout {
    template: { header: {menu_ids}, footer: {menu_ids} }
  }
  ```
  Nếu cấu trúc có thể không cần là array (chỉ 1 template/layout, 1 header/template), dot notation `template.header.menu_ids` là object-nested → `$mergeObjects` work.

- **Cách C — Giữ schema cũ, post-process TS** (🔴 TS):
  ~30 dòng walk + bulk fetch + map. Giữ controller riêng.

**Khuyến nghị**: Cách A — relation hoá. Đẹp về data model + populate pure. Trade-off: phải migrate dữ liệu layout/template/menu hiện có. Nếu không muốn migrate ngay → Cách C tạm.

---

## 14. `POST /front/form-builder-content/:slug` — Submit form

**Controller**: `FrontContoller.submitFormBuilder`

**Mục đích**: Form builder dynamic (admin tạo form qua UI), front user submit → validate + save + email.

**Pipeline**
1. Lấy `slug` (path), `locale` (query, default 'vi')
2. `frontFormBuilderService.getFormBuilder(slug, locale, options)`:
   - Query `form-builder` với `mongodb_collection_name=slug`, `locale`, select all relation
   - Trả `{formBuilder, templateMail}` (templateMail từ `template_mail[0]`)
3. **Parse multipart**:
   - Nếu `Content-Type: multipart/form-data`: stream parts
   - **Giới hạn 1 file** (throw 400 nếu nhiều hơn)
   - Extension whitelist: `.pdf, .doc, .docx, .png, .jpg, .jpeg, .gif, .webp`
   - File size ≤ `appSettings.upload.maxFileSize`
   - Upload `mediaMinioService.createObject` → `media._id`
   - Set `data[fileField] = media._id` (fileField = first file-type field trong form schema)
4. Nếu không multipart: parse JSON body
5. `frontFormBuilderService.submit(slug, locale, formData, options)`:
   - `ajvValidator.validateFull(json_schema, data)` → `{data: filteredData, errors, fieldErrors}`
   - Nếu lỗi → trả `{message, fieldErrors}`
   - Add `tenant_id`, `locale`, `page` (nếu có) vào `filteredData`
   - `db.collection('form-builder-content').insertOne(filteredData)` (raw insert, không qua core)
   - **Async email** with timeout 5s:
     - Compile `template.notification_mail.send_body` via Handlebars + filteredData
     - Mail tới `splitAndCleanEmails(send_to/cc/bcc)`
     - Attachments: nếu `attachments_field` có, query media `_id ∈ [...]` → list path từ MinIO
     - `nodemailer.sendMail` qua transport SMTP
   - Race: nếu mail > 5s → trả response, mail chạy tiếp ngầm

**Output**: `{statusCode: 200, msg: 'Form submitted successfully', data: savedRecord}`

**Migration**: 🔴 **TS controller** — multipart, MinIO upload, nodemailer, Handlebars đều cần I/O không express được trong DSL. Bắt buộc giữ controller riêng (`front-form-builder.controller.ts`).

---

## 15. `GET /front/sitemap/page` — Sitemap cho page

**Controller**: `FrontContoller.getSiteMapPage`

**Pipeline**:
- Force `status='eq."1"'`, `tenant_id` từ header
- `applyPagination` (page→skip)
- `core.findAll(queryData, 'page', ['default'])`
- Map: `{_id, slug: slug.replace(/\*\*.*?\*\*/g, ''), locale}` — strip phần `**...**` khỏi slug

**Migration**: 🟡 **Hybrid**. Action `list-public` trên resource `page` với policy condition `status=eq."1"&select=_id,slug,locale`. `code` post-process strip `**...**` regex (~3 dòng):
```js
data.data = data.data.map(i => ({...i, slug: i.slug.replace(/\*\*.*?\*\*/g, '')}));
return data;
```
Hoặc 🟢 Pure nếu clean seopath schema để slug không còn markers.

---

## 16. `GET /front/sitemap/post` — Sitemap cho post

**Controller**: `FrontContoller.getSiteMapPost`

**Pipeline**:
- Force `redirect_url: null`, `entity_save_data: 'in.post-type-content,category'`, `tenant_id`
- `core.findAll(queryData, 'seopath', ['default'])`
- Filter+map: skip nếu `entity_slug` không phải string. Build `slug = entity_slug + '/' + slug.replace(/\*\*.*?\*\*/g, '')`

**Migration**: 🟡 **Hybrid**. Tương tự (15), action `list-public` trên `seopath` với policy condition `redirect_url=null&entity_save_data=in.[post-type-content,category]&select=_id,slug,entity_slug,entity_save_data,locale`. `code` strip regex + concat entity_slug + slug (~5 dòng). 🟢 Pure nếu seopath đã clean.

---

## 17. `POST /front/sitemap/post-v2` — Sitemap nhiều post-type, parallel

**Controller**: `FrontContoller.getSiteMapPostV2`

**Mục đích**: Client gửi body `[{post_type, limit}, ...]`, server fan-out fetch tất cả post-type này × 3 locale (vi, en, jp).

**Pipeline**
1. Query `entity` collection lọc `use_posttype=true, mongodb_collection_name ∈ [body[].post_type]`
2. Cho mỗi post-type:
   - Build query `{entity_id: 'in.[postType._id]', redirect_url: null, entity_save_data: 'in.post-type-content,category', limit, order: '-created_at'}`
   - Apply page nếu có
   - `Promise.all([locale='vi', 'en', 'jp'])` fetch sitemap post per locale
   - Merge result
3. Trả `[]` (gộp tất cả)

**Migration**: 🔴 **TS controller**. Fan-out parallel + body-driven N×M (N post-types × M locales), không express được trong DSL. Giữ controller riêng.

---

## 18. `GET /front/sitemap/blocks` — Block content per tenant

**Controller**: `FrontContoller.sitemapBlocks`

**Pipeline `frontService.sitemapBlocks`**
1. List tenants: `core.findAll({status='eq."1"', select='_id,title,domain,description,theme_config,slug'}, 'tenant', ['admin'])`
2. `Promise.all` per tenant:
   - List menus: `{tenant_id: 'eq.${tenant._id}', select: '_id,title,slug,groupfield'}`
   - Collect groupfield IDs từ menu items
   - Bulk fetch `group-field` `{_id: 'in.[ids]', select: '_id,slug'}` → Map id→slug
   - Walk menus: nếu `title.toLowerCase() === 'header'` → `tenant.header = [slugs]`, tương tự `footer`
   - List blocks: `{tenant_id, deleted: 'exists.false', select: '_id,key'}` từ `block-content`
   - Unique keys (split `___` lấy phần đầu), gán vào `tenant.blocksContent`

**Migration**: 🔴 **TS controller**. Cross-tenant aggregation (list mọi tenant rồi populate menu/block/group-field cho mỗi cái) + uniqueKeys split `___` — DSL không express. Giữ controller riêng.

---

## 19. `POST /front/auth/login` — Login

**Controller**: `FrontContoller.login`

**Pipeline**
- Validate body `{email, password}`
- `authService.validateCredentials(email, password)` → user (hoặc null)
- Nếu null → 401
- JWT sign access token + create refresh token
- Trả `{accessToken, refreshToken, user (no password)}`

**Migration**: ⚪ **Skip** — đã có ở `_auth` mới (theo memory `project_auth_login_flow`). Front route alias hoặc dùng chung `/auth/login`.

---

## 20. `GET /front/auth/me` — Profile current user (yêu cầu JWT)

**Controller**: `FrontContoller.me` + `preHandler: jwtGuard`

**Pipeline**: lấy `request.headers.user`, `authService.getProfile(user.email)`, trả về.

**Migration**: ⚪ **Skip** — `_auth/me` đã có.

---

## (–) `uploadCVDocument` (internal — không trong routes)

**Pipeline**:
- Multipart 1 file → MinIO bucket `cv` → media._id
- Insert `cv-documents` collection với `{name, email, phone, applied_position, featured_image: media._id}`
- Trả về `cv_data` + `path = "${public}/${bucketName}/${objectName}"`

**Migration**: 🔴 **TS controller** (nếu cần expose). Multipart + MinIO upload + insert collection — không pure được.

---

## Helper

### `helper/getSelect.ts`
Đọc `entity_setting.fe_list` (cho list) hoặc `entity_setting.fe_detail` (cho detail) từ schema cache → trả về chuỗi select đã chuẩn hóa (xóa `\n` và space thừa). Nếu không có → `*`.

### `helper/helper.ts:createMetadata`
Build object `meta_data` cho detail/list:
- `slug` = `entity_slug/slug` (nếu có entity) hoặc `slug` (không)
- `entity`, `entity_field`, `entity_field_title`, `entity_title`, `entity_field_id`
- `type` = `'redirect'` nếu seopath.redirect_url, else `'direct'`
- `redirect_to` = build từ redirect_url
- `path` = map locale → full path từ `dataWithLocale`

### `helper/validate-json-schema.ts` (419 dòng — chưa đọc kỹ, nhưng nội bộ form-builder dùng AJV; ajvValidator đã có ở `core_v2/schema/validator.ts`).

---

## Tổng kết khả năng migrate (sau đánh giá lại)

| Status | Endpoints | Đề xuất |
|---|---|---|
| 🟢 **Pure** (seed JSON, không code) | 1, 2, 3, 5, 6, 7, 8, 12 | Seed action + policy + form-setting + entity setting |
| 🟢🌳 **Pure + plugin có sẵn** | 4 (children/tree qua `use_parent`) | Bật `use_parent: true` trên entity |
| 🟡 **Hybrid** (cần `code` ngắn ≤20 dòng) | 11, 15, 16 | Seed + `code` record post-process |
| 🔴 **TS controller** (multipart/aggregation/populate phức tạp) | 13, 14, 17, 18, (uploadCV) | Code TS riêng trong `_front/` |
| ⚪ **Skip** (auth required / đã có module) | 9, 10, 19, 20 | Admin route hoặc reuse `_auth` |

**Estimate**: ~9 endpoint thuần JSON config (50%), 3 hybrid (17%), 4 phải TS (22%), 4 skip (22%). Tăng từ ước lượng cũ vì:
- Đổi URL `/front/children/*` → `/front/<entity>/:id/children` để khớp pattern
- Đổi URL `/front/detail/*` → `/front/seopath/:slug` (resource = seopath)
- Tách `post-type-content` polymorphic thành nhiều entity riêng (mỗi post-type là 1 resource)
- Clean seopath schema (bỏ markers trong slug) → unlock thêm 2 endpoint pure

## Thứ tự công việc đề xuất

**Phase 1 — Pure JSON seed (8 endpoint)**:
1. Action system mới: `list-public`, `read-public` (đã có), `read-by-slug-public` `path:/:slug`, `create-public` POST, `update-public` PUT, `list-children-public` `path:/:parent_id/children`, `read-2-layer-public` `path:/:entity_slug/:slug`
2. Mỗi entity public seed policy guest tương ứng

**Phase 2 — Clean seopath schema**:
- Bỏ `**entity_id---tenant_id**` markers, lưu plain slug
- Update pipeline lưu seopath
- Sau đó 2 endpoint sitemap chuyển từ 🟡 → 🟢

**Phase 3 — Hybrid (tùy chọn `code`)**:
- `code` record cho `children_count` (children endpoint, comment list)
- `code` record cho strip markers (nếu chưa làm Phase 2)

**Phase 4 — TS controllers**:
- `front-layout.controller.ts` (layout)
- `front-form-builder.controller.ts` (multipart)
- `front-sitemap.controller.ts` (sitemap V2 + blocks)
- `front-cv.controller.ts` (CV upload, nếu cần)

**Phase 5 — Migrate auth & detail-v2**:
- Alias `_auth` routes dưới `/front/auth/*`
- detail-v2 → admin route trong `common_v2`

---

## Đề xuất cấu trúc `_front` mới sau migrate

```
backend/src/module/_front/
├── front.controller.ts              ← wildcard /front/* (ĐÃ CÓ, generic data-driven)
├── front-layout.controller.ts       ← 🔴 GET /front/layout (populate cấp 3)
├── front-form-builder.controller.ts ← 🔴 POST /front/form-builder-content/:slug
├── front-form-builder.service.ts    ← copy y nguyên từ current_code
├── front-sitemap.controller.ts      ← 🔴 sitemap V2 + blocks
├── front-cv.controller.ts           ← 🔴 CV upload (nếu cần expose)
├── helper/
│   └── createMetadata.ts            ← reuse từ current_code/helper.ts
└── MIGRATION_SPEC.md                ← file này
```

## Action JSON system cần seed

(Chỉ seed 1 lần ở `backend/json/system/action/`, dùng chung mọi tenant)

| Slug | Method | Path | auth | Mục đích |
|---|---|---|---|---|
| `list-public` | GET | `/` | false | List record public |
| `read-public` | GET | `/:id` | false | Detail theo `_id` (đã seed) |
| `read-by-slug-public` | GET | `/:slug` | false | Detail theo `slug` |
| `read-2-layer-public` | GET | `/:entity_slug/:slug` | false | Seopath 2-layer |
| `create-public` | POST | `/` | false | Submit form/comment |
| `update-public` | PUT | `/:id` | false | Update từ front (siết policy) |
| `list-children-public` | GET | `/:parent_id/children` | false | Children theo parent_id |

## Policy JSON per tenant cần seed

Mỗi resource public seed 1 policy `role: ['guest']`:
- `resource: ['<resource>']`
- `action: ['list-public', 'read-public', ...]` — list các action public
- `condition: 'status=eq."1"&select=<whitelist fields>'` — filter + whitelist
- `form: 'form-setting-slug'` (nếu có POST/PUT) — whitelist body fields

Mẫu đã seed: `backend/json/pptx/policy/pricing-public.json`
