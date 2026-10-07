import { Db } from 'mongodb';

/**
 * Per-entity slug uniqueness setup.
 *
 * For every entity with `use_slug: true`:
 *   1. Backfill missing `collection_name` field on records.
 *   2. Auto-rename duplicate slugs (within tenant + collection_name scope) by
 *      appending `-2`, `-3`, ... so a unique compound index can be created.
 *   3. Create unique compound index on the entity collection:
 *      `{ tenant_id, collection_name, slug }`.
 *
 * Then once per tenant DB, create unique compound index on seopath:
 *   `{ tenant_id, entity_slug, slug }`.
 *
 * Idempotent — safe to call on every bootstrap.
 */

interface EntityConfig {
  collection_name?: string;
  mongodb_save_data?: string;
  use_slug?: boolean;
}

interface DbWithName {
  db: Db;
  label: string;
}

const ENTITY_INDEX_FIELDS = { tenant_id: 1, collection_name: 1, slug: 1 } as const;
const SEOPATH_INDEX_FIELDS = { tenant_id: 1, entity_slug: 1, slug: 1 } as const;
const PARTIAL_FILTER = { slug: { $type: 'string' as const } };

/**
 * Ensure each record in `collection` has `collection_name` field set to
 * `logicalName`. For polymorphic stores (multiple logical entities sharing one
 * physical collection) we only backfill records that already have the discriminator
 * value (avoid mislabeling other entities' records).
 */
async function backfillCollectionName(
  db: Db,
  physicalCollection: string,
  logicalName: string,
  isPolymorphic: boolean,
): Promise<number> {
  if (isPolymorphic) {
    // For polymorphic, never blanket-backfill — risk of mislabeling sibling
    // entities' records. Skip and let new records (saved through commonService)
    // get tagged correctly.
    return 0;
  }
  const result = await db.collection(physicalCollection).updateMany(
    { collection_name: { $exists: false } },
    { $set: { collection_name: logicalName } },
  );
  return result.modifiedCount;
}

/**
 * Find groups of records sharing `{tenant_id, collection_name, slug}` and rename
 * the second+ occurrences with `-2`, `-3`, ... suffixes.
 * Returns count of records renamed.
 */
async function renameDuplicateSlugs(db: Db, collection: string): Promise<number> {
  const dups = await db
    .collection(collection)
    .aggregate([
      { $match: { slug: { $type: 'string' } } },
      {
        $group: {
          _id: {
            tenant_id: '$tenant_id',
            collection_name: '$collection_name',
            slug: '$slug',
          },
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  let renamed = 0;
  for (const group of dups) {
    // Keep first record's slug as-is; rename the rest
    const ids = group.ids as any[];
    for (let i = 1; i < ids.length; i++) {
      const newSlug = `${group._id.slug}-${i + 1}`;
      await db.collection(collection).updateOne(
        { _id: ids[i] },
        { $set: { slug: newSlug } },
      );
      renamed++;
    }
  }
  return renamed;
}

async function ensureIndex(
  db: Db,
  collection: string,
  fields: Record<string, 1 | -1>,
  partialFilter: Record<string, unknown>,
  label: string,
): Promise<void> {
  try {
    await db.collection(collection).createIndex(fields, {
      unique: true,
      partialFilterExpression: partialFilter,
      name: label,
    });
  } catch (err: any) {
    // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict — already exists with different options
    if (err?.code === 85 || err?.code === 86) {
      console.warn(
        `[SlugIndex] Index ${label} on ${collection} exists with different options — skipping. Drop manually if needed.`,
      );
      return;
    }
    // 11000 = duplicate during build → backfill/rename should have prevented this
    console.error(
      `[SlugIndex] Failed to create index ${label} on ${collection}:`,
      err?.message ?? err,
    );
    throw err;
  }
}

async function setupForDb(
  { db, label }: DbWithName,
  entities: EntityConfig[],
): Promise<void> {
  const slugEntities = entities.filter((e) => e.use_slug && e.collection_name);
  if (slugEntities.length === 0) {
    return;
  }

  // Track which physical collections have already been processed (multiple
  // logical entities can share one physical via mongodb_save_data).
  const processedPhysical = new Set<string>();

  for (const entity of slugEntities) {
    const physical = entity.mongodb_save_data || entity.collection_name!;
    const isPolymorphic = !!entity.mongodb_save_data && entity.mongodb_save_data !== entity.collection_name;

    if (!processedPhysical.has(physical)) {
      processedPhysical.add(physical);

      const backfilled = await backfillCollectionName(db, physical, entity.collection_name!, isPolymorphic);
      if (backfilled > 0) {
        console.log(`[SlugIndex] [${label}] backfilled collection_name on ${backfilled} records of '${physical}'`);
      }

      const renamed = await renameDuplicateSlugs(db, physical);
      if (renamed > 0) {
        console.log(`[SlugIndex] [${label}] auto-renamed ${renamed} duplicate slugs in '${physical}'`);
      }

      await ensureIndex(db, physical, ENTITY_INDEX_FIELDS, PARTIAL_FILTER, `unique_slug_${physical}`);
    }
  }

  // Seopath unique index — once per tenant DB
  await ensureIndex(db, 'seopath', SEOPATH_INDEX_FIELDS, PARTIAL_FILTER, 'unique_slug_seopath');
}

/**
 * Ensure ONLY the seopath unique compound index `{tenant_id, entity_slug, slug}`
 * exists on a single DB. For lazy per-tenant/per-DB setup (new tenant created at
 * runtime, or a slug-fallback DB) where full entity-index setup isn't needed.
 * Idempotent and non-fatal.
 */
export async function ensureSeopathIndex(db: Db, label = '?'): Promise<void> {
  try {
    await ensureIndex(db, 'seopath', SEOPATH_INDEX_FIELDS, PARTIAL_FILTER, 'unique_slug_seopath');
  } catch (err: any) {
    console.warn(`[SlugIndex] [${label}] ensureSeopathIndex failed:`, err?.message ?? err);
  }
}

/**
 * Run setup across the main DB and all per-tenant DBs.
 *
 * @param mainDb - Default MongoDB instance (where main `entity` records live)
 * @param tenantDbs - Optional list of additional tenant DBs (with their entities)
 */
export async function setupSlugIndexes(
  mainDb: Db,
  tenantDbs: Array<{ db: Db; slug: string; entities: EntityConfig[] }> = [],
  mainEntities: EntityConfig[] = [],
): Promise<void> {
  try {
    await setupForDb({ db: mainDb, label: 'main' }, mainEntities);
    for (const t of tenantDbs) {
      await setupForDb({ db: t.db, label: t.slug }, t.entities);
    }
    console.log('[SlugIndex] Setup complete');
  } catch (err: any) {
    console.error('[SlugIndex] Setup failed:', err?.message ?? err);
    // Non-fatal — log and continue. Server still starts.
  }
}
