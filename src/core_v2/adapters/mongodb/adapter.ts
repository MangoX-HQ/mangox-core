/**
 * Core V2 - MongoDB Adapter
 * Main adapter implementation for MongoDB
 */

import {
  MongoClient,
  Db,
  Collection,
  ClientSession,
  ObjectId,
  Document,
} from "mongodb";
import {
  IDatabaseAdapter,
  IRelationshipRegistry,
  AdapterAction,
} from "../../interfaces/adapter.interface";
import {
  IntermediateQuery,
  QueryResult,
  QueryResultMetadata,
  JoinClause,
} from "../../query/intermediate";
import { AdapterConfig } from "../../config";
import { ValidationResult, DatabaseType } from "../../types";
import { Errors, wrapError } from "../../errors";
import {
  MongoDBNativeQuery,
  MongoDBOperation,
  MongoDBPipeline,
  MongoDBConnectionConfig,
  DEFAULT_MONGODB_CONFIG,
  MONGODB_CAPABILITIES,
  isPipeline,
  isOperation,
} from "./types";
import { MongoDBQueryConverter } from "./converters/query-converter";
import { getTenantDb } from "./tenant-context";

// ============================================================================
// MONGODB ADAPTER
// ============================================================================

/**
 * MongoDB Database Adapter
 */
export class MongoDBAdapter implements IDatabaseAdapter<
  Db,
  MongoDBNativeQuery
> {
  readonly type: DatabaseType = "mongodb";
  readonly name = "MongoDB Adapter v2";

  private client: MongoClient | null = null;
  private db: Db | null = null;
  private queryConverter: MongoDBQueryConverter;
  private _initialized = false;

  constructor(private relationshipRegistry: IRelationshipRegistry) {
    this.queryConverter = new MongoDBQueryConverter(relationshipRegistry);
  }

  get initialized(): boolean {
    return this._initialized;
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the adapter with configuration
   */
  async initialize(config: AdapterConfig): Promise<void> {
    const mongoConfig = this.parseConfig(config);
    const connectionString = this.buildConnectionString(mongoConfig);

    // Build MongoDB client options
    const clientOptions = {
      maxPoolSize:
        mongoConfig.pool?.maxPoolSize ||
        DEFAULT_MONGODB_CONFIG.pool?.maxPoolSize,
      minPoolSize:
        mongoConfig.pool?.minPoolSize ||
        DEFAULT_MONGODB_CONFIG.pool?.minPoolSize,
      maxIdleTimeMS:
        mongoConfig.pool?.maxIdleTimeMS ||
        DEFAULT_MONGODB_CONFIG.pool?.maxIdleTimeMS,
      waitQueueTimeoutMS:
        mongoConfig.pool?.waitQueueTimeoutMS ||
        DEFAULT_MONGODB_CONFIG.pool?.waitQueueTimeoutMS,
      serverSelectionTimeoutMS:
        mongoConfig.timeouts?.serverSelectionTimeoutMS ||
        DEFAULT_MONGODB_CONFIG.timeouts?.serverSelectionTimeoutMS,
      socketTimeoutMS:
        mongoConfig.timeouts?.socketTimeoutMS ||
        DEFAULT_MONGODB_CONFIG.timeouts?.socketTimeoutMS,
      connectTimeoutMS:
        mongoConfig.timeouts?.connectTimeoutMS ||
        DEFAULT_MONGODB_CONFIG.timeouts?.connectTimeoutMS,
      retryWrites:
        mongoConfig.retryWrites ?? DEFAULT_MONGODB_CONFIG.retryWrites,
      retryReads: mongoConfig.retryReads ?? DEFAULT_MONGODB_CONFIG.retryReads,
    };

    try {
      this.client = new MongoClient(connectionString, clientOptions);
      await this.client.connect();

      // Extract database name from connection string or config
      const dbName =
        mongoConfig.database || this.extractDbName(connectionString);
      if (!dbName) {
        throw new Error("Database name is required");
      }

      this.db = this.client.db(dbName);
      this._initialized = true;

      // Setup event listeners
      this.setupEventListeners();
    } catch (error) {
      throw Errors.connectionFailed(
        "mongodb",
        error instanceof Error ? error.message : "Unknown error",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get database connection
   */
  async getConnection(): Promise<Db> {
    this.ensureInitialized();
    return this.db!;
  }

  /**
   * Low-level adapter action — bypasses intermediate query / plugins / RBAC.
   * Routes to direct MongoDB collection methods. Tenant DB context is honored
   * so triggers running inside `withTenant(...)` write to the right database.
   */
  async executeAction(action: AdapterAction): Promise<unknown> {
    this.ensureInitialized();
    const db: Db = (getTenantDb() as Db) ?? this.db!;
    const col: Collection = db.collection(action.collection);
    const opts = (action.options ?? {}) as Record<string, unknown>;
    const filter = this.normalizeFilter(action.filter);
    switch (action.operation) {
      case 'insert':
        return col.insertOne((action.data ?? {}) as Document, opts);
      case 'insertMany': {
        const docs = Array.isArray(action.data) ? (action.data as Document[]) : [action.data as Document];
        return col.insertMany(docs, opts);
      }
      case 'update':
        return col.updateOne(
          filter,
          (action.update ?? { $set: action.data ?? {} }) as Document,
          opts,
        );
      case 'updateMany':
        return col.updateMany(
          filter,
          (action.update ?? { $set: action.data ?? {} }) as Document,
          opts,
        );
      case 'delete':
        return col.deleteOne(filter, opts);
      case 'deleteMany':
        return col.deleteMany(filter, opts);
      case 'findOne':
        return col.findOne(filter, opts);
      case 'find':
        return col.find(filter, opts).toArray();
      case 'aggregate':
        return col.aggregate((action.pipeline ?? []) as Document[], opts).toArray();
      default:
        throw Errors.queryInvalid(`Unknown mongodb action operation: ${action.operation}`);
    }
  }

  /**
   * Convert `_id` (and nested `*._id`) string values to ObjectId so triggers
   * can pass plain ids resolved from `@context:` placeholders without knowing
   * MongoDB internals. Leaves non-id fields and already-ObjectId values alone.
   */
  private normalizeFilter(filter: Record<string, unknown> | undefined): Document {
    if (!filter || typeof filter !== 'object') return {} as Document;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
      out[key] = (key === '_id' || key.endsWith('._id')) ? this.coerceIdValue(value) : value;
    }
    return out as Document;
  }

  private coerceIdValue(value: unknown): unknown {
    // Already an ObjectId — pass through (Object.entries on ObjectId would
    // serialize its internal `_bsontype`/`buffer` and break the comparison).
    if (value instanceof ObjectId) return value;
    if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value);
    if (Array.isArray(value)) {
      return value.map(v => {
        if (v instanceof ObjectId) return v;
        return typeof v === 'string' && ObjectId.isValid(v) ? new ObjectId(v) : v;
      });
    }
    if (value && typeof value === 'object') {
      // operator clauses like { $in: [...] }, { $eq: '...' }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.coerceIdValue(v);
      }
      return out;
    }
    return value;
  }

  /**
   * Get MongoDB client (for sessions)
   */
  getClient(): MongoClient {
    this.ensureInitialized();
    return this.client!;
  }

  // ============================================================================
  // QUERY OPERATIONS
  // ============================================================================

  /**
   * Validate intermediate query
   */
  validateQuery(query: IntermediateQuery): ValidationResult {
    const errors: Array<{ field?: string; message: string }> = [];

    // Check collection name
    if (!query.collection || typeof query.collection !== "string") {
      errors.push({ message: "Collection name is required" });
    }

    // Check query type
    if (!query.type) {
      errors.push({ message: "Query type is required" });
    }

    // Validate filters
    if (query.userFilter && typeof query.userFilter !== "object") {
      errors.push({ field: "userFilter", message: "Invalid filter format" });
    }

    // Validate data for insert/update
    if (["insert", "update", "updateMany"].includes(query.type)) {
      if (!query.data || typeof query.data !== "object") {
        errors.push({
          field: "data",
          message: "Data is required for insert/update operations",
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Convert intermediate query to MongoDB native query
   */
  async convertQuery(query: IntermediateQuery): Promise<MongoDBNativeQuery> {
    return await this.queryConverter.convert(query);
  }

  /**
   * Execute query
   */
  async executeQuery<T = unknown>(
    collectionName: string,
    intermediateQuery: IntermediateQuery,
    nativeQuery: MongoDBNativeQuery,
  ): Promise<QueryResult<T>> {
    this.ensureInitialized();

    const startTime = Date.now();
    const activeDb = getTenantDb() ?? this.db!;
    const collection = activeDb.collection(collectionName);
    const session = intermediateQuery.options?.session as
      | ClientSession
      | undefined;

    try {
      let result: QueryResult<T>;

      if (isPipeline(nativeQuery)) {
        result = await this.executeAggregate<T>(
          collection,
          nativeQuery,
          intermediateQuery,
          startTime,
          session,
        );
      } else if (isOperation(nativeQuery)) {
        result = await this.executeCrud<T>(
          collection,
          nativeQuery,
          intermediateQuery,
          startTime,
          session,
        );
      } else {
        throw new Error("Invalid native query format");
      }

      return result;
    } catch (error) {
      throw Errors.queryExecutionFailed(
        error instanceof Error ? error.message : "Unknown error",
        intermediateQuery,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ============================================================================
  // AGGREGATION EXECUTION
  // ============================================================================

  /**
   * Execute aggregation pipeline
   */
  private async executeAggregate<T>(
    collection: Collection,
    pipeline: MongoDBPipeline,
    query: IntermediateQuery,
    startTime: number,
    session?: ClientSession,
  ): Promise<QueryResult<T>> {
    // Extract pagination info from pipeline
    const limit = this.extractFromPipeline(pipeline, "$limit") ?? 10;
    const skip = this.extractFromPipeline(pipeline, "$skip") ?? 0;

    // Build count pipeline - preserve stages needed for rootFilter (INNER JOIN behavior)
    const countPipeline = this.buildCountPipeline(pipeline, query);

    // Execute data and count in parallel with individual timing
    const sessionOpts = session ? { session } : undefined;

    let dataTime = 0;
    let countTime = 0;

    const [dataResult, countResult] = await Promise.all([
      (async () => {
        const start = Date.now();
        const result = await collection
          .aggregate(pipeline, sessionOpts)
          .toArray();
        dataTime = Date.now() - start;
        return result;
      })(),
      (async () => {
        const start = Date.now();
        const result = await collection
          .aggregate([...countPipeline, { $count: "total" }], sessionOpts)
          .toArray();
        countTime = Date.now() - start;
        return result;
      })(),
    ]);

    const data = dataResult as T[];
    const total = countResult[0]?.total ?? 0;

    const executionTime = Date.now() - startTime;

    // Log slow queries (> 1s)
    if (executionTime > 1000) {
      console.warn(
        `[MongoDB] Slow query detected on ${collection.collectionName}:`,
        {
          totalTime: `${executionTime}ms`,
          dataQueryTime: `${dataTime}ms`,
          countQueryTime: `${countTime}ms`,
          pipelineStages: pipeline.length,
          countPipelineStages: countPipeline.length,
        },
      );
    }

    return {
      statusCode: 200,
      data,
      count: total,
      pagination: {
        current_page: Math.floor(skip / limit) + 1,
        last_page: Math.ceil(total / limit),
        total,
        hasMore: skip + data.length < total,
      },
      metadata: {
        executionTime,
        adapter: this.name,
        query,
        nativeQuery: pipeline,
      },
    };
  }

  /**
   * Build count pipeline with smart stage filtering
   * Preserves $lookup, $unwind, $match stages that are needed for rootFilter (INNER JOIN)
   */
  private buildCountPipeline(
    pipeline: Document[],
    query: IntermediateQuery,
  ): Document[] {
    // Find all join aliases that have rootFilter (INNER JOIN behavior)
    const rootFilterAliases = this.collectRootFilterAliases(query.joins || []);

    // If no rootFilter, use simple filtering (remove all lookup-related stages)
    if (rootFilterAliases.size === 0) {
      return pipeline.filter((stage) => {
        const key = Object.keys(stage)[0];
        return ![
          "$skip",
          "$limit",
          "$lookup",
          "$addFields",
          "$sort",
          "$unwind",
          "$project",
        ].includes(key);
      });
    }

    // With rootFilter, we need to preserve lookup chain for those joins
    const countPipeline: Document[] = [];

    for (const stage of pipeline) {
      const key = Object.keys(stage)[0];

      // Always skip pagination and sorting stages
      if (["$skip", "$limit", "$sort", "$project"].includes(key)) {
        continue;
      }

      // Check if this is a $lookup for a rootFilter join
      if (key === "$lookup") {
        const lookupAs = stage.$lookup?.as;
        if (lookupAs && rootFilterAliases.has(lookupAs)) {
          countPipeline.push(stage);
        }
        continue;
      }

      // Check if this is a $unwind for a rootFilter join
      if (key === "$unwind") {
        const unwindPath =
          typeof stage.$unwind === "string"
            ? stage.$unwind
            : stage.$unwind?.path;
        const fieldName = unwindPath?.replace(/^\$/, "");
        if (fieldName && rootFilterAliases.has(fieldName)) {
          countPipeline.push(stage);
        }
        continue;
      }

      // Check if this is a $addFields for ID conversion (needed for $lookup)
      if (key === "$addFields") {
        const addFieldsKeys = Object.keys(stage.$addFields || {});
        const needsForLookup = addFieldsKeys.some((field) =>
          rootFilterAliases.has(field),
        );
        if (needsForLookup) {
          countPipeline.push(stage);
        }
        continue;
      }

      // Keep $match stages (both security filters and rootFilter)
      if (key === "$match") {
        countPipeline.push(stage);
        continue;
      }

      // Keep other stages
      countPipeline.push(stage);
    }

    return countPipeline;
  }

  /**
   * Recursively collect all join aliases that have rootFilter
   * Also includes parent aliases when nested joins have rootFilter
   */
  private collectRootFilterAliases(joins: JoinClause[]): Set<string> {
    const aliases = new Set<string>();

    for (const join of joins) {
      const alias = join.alias || join.target;

      if (join.rootFilter) {
        aliases.add(alias);
      }

      // Check nested joins recursively
      if (join.joins && join.joins.length > 0) {
        const nestedAliases = this.collectRootFilterAliases(join.joins);
        // If any nested join has rootFilter, include parent alias too
        // This ensures parent $lookup is preserved for nested filtering
        if (nestedAliases.size > 0) {
          aliases.add(alias);
        }
        nestedAliases.forEach((a) => aliases.add(a));
      }
    }

    return aliases;
  }

  // ============================================================================
  // CRUD EXECUTION
  // ============================================================================

  /**
   * Execute CRUD operation
   */
  private async executeCrud<T>(
    collection: Collection,
    operation: MongoDBOperation,
    query: IntermediateQuery,
    startTime: number,
    session?: ClientSession,
  ): Promise<QueryResult<T>> {
    const sessionOpts = session ? { session } : undefined;
    let data: T[] = [];
    let statusCode = 200;
    let insertedCount = 0;
    let modifiedCount = 0;
    let deletedCount = 0;
    let matchedCount = 0;

    switch (operation.operation) {
      case "insertOne": {
        const result = await this.executeInsertOne<T>(
          collection,
          operation.document || {},
          sessionOpts,
        );
        data = result.data;
        statusCode = 201;
        insertedCount = 1;
        break;
      }

      case "updateOne": {
        const result = await this.executeUpdateOne<T>(
          collection,
          operation.filter || {},
          operation.update || operation.document || {},
          query.collection,
          sessionOpts,
        );
        data = result.data;
        // 200 when the doc EXISTS (matched) — even if the update changes nothing (modifiedCount=0,
        // e.g. PUT with identical data). Only 404 when the doc isn't found (matchedCount=0).
        statusCode = result.matchedCount > 0 ? 200 : 404;
        modifiedCount = result.modifiedCount;
        matchedCount = result.matchedCount;
        break;
      }

      case "replaceOne": {
        const result = await this.executeReplaceOne<T>(
          collection,
          operation.filter || {},
          operation.document || {},
          sessionOpts,
        );
        data = result.data;
        statusCode = result.modifiedCount > 0 ? 200 : 404;
        modifiedCount = result.modifiedCount;
        break;
      }

      case "updateMany": {
        const result = await this.executeUpdateMany<T>(
          collection,
          operation.filter || {},
          operation.update || operation.document || {},
          query.collection,
          sessionOpts,
        );
        data = result.data;
        statusCode = result.modifiedCount > 0 ? 200 : 400;
        modifiedCount = result.modifiedCount;
        matchedCount = result.matchedCount;
        break;
      }

      case "deleteOne": {
        const result = await collection.findOneAndDelete(
          operation.filter || {},
          sessionOpts ?? {},
        );
        const isDeleted = result !== null;
        statusCode = isDeleted ? 200 : 404;
        deletedCount = isDeleted ? 1 : 0;
        data = isDeleted ? [result as unknown as T] : [];
        break;
      }

      case "deleteMany": {
        const filter = operation.filter || {};

        // Step 1: Find all documents matching the condition before deleting
        // We save them into a variable so we can return them to the Client or log them
        const docsToDelete = await collection
          .find(filter, sessionOpts)
          .toArray();

        // Step 2: Perform the bulk delete
        const result = await collection.deleteMany(filter, sessionOpts);

        // Step 3: Update the status variables
        deletedCount = result.deletedCount;
        statusCode = deletedCount > 0 ? 200 : 404;

        // Assign the found data to a return variable (e.g. deletedData)
        // If you need to return the old data to the user, assign it here
        data = docsToDelete as unknown as T[];

        break;
      }

      case "bulkWrite": {
        const result = await this.executeBulkWrite<T>(
          collection,
          operation.documents || [],
          sessionOpts,
        );
        data = result.data;
        modifiedCount = result.modifiedCount;
        break;
      }

      default:
        throw new Error(`Unsupported operation: ${operation.operation}`);
    }

    const executionTime = Date.now() - startTime;

    return {
      statusCode,
      data,
      metadata: {
        executionTime,
        adapter: this.name,
        query,
        nativeQuery: operation,
        insertedCount,
        modifiedCount,
        deletedCount,
        matchedCount,
      },
    };
  }

  /**
   * Execute insertOne with duplicate slug handling
   */
  private async executeInsertOne<T>(
    collection: Collection,
    document: Document,
    options?: { session?: ClientSession },
  ): Promise<{ data: T[] }> {
    let doc = { ...document };
    if (doc._id && typeof doc._id === 'string' && ObjectId.isValid(doc._id)) {
      doc._id = new ObjectId(doc._id as string);
    }
    let retries = 0;
    // High retry budget to survive concurrent slug collisions (50+ parallel inserts).
    // Each retry only increments suffix by 1, so we need enough room for the worst case.
    const maxRetries = 100;

    while (retries <= maxRetries) {
      try {
        const result = await collection.insertOne(doc, options);
        return {
          data: [{ ...doc, _id: result.insertedId }] as T[],
        };
      } catch (error: unknown) {
        const mongoError = error as { code?: number };
        if (mongoError.code === 11000 && retries < maxRetries) {
          // Duplicate key error - increment slug
          retries++;
          doc = this.incrementSlug(doc);
          continue;
        }
        throw error;
      }
    }

    throw new Error("Max retries exceeded for insert operation");
  }

  /**
   * Execute updateOne
   */
  private async executeUpdateOne<T>(
    collection: Collection,
    filter: Document,
    update: Document,
    logicalCollection?: string,
    options?: { session?: ClientSession },
  ): Promise<{ data: T[]; modifiedCount: number; matchedCount: number }> {
    // Flatten and prepare update
    const updateDoc = this.prepareUpdateDocument(
      update,
      collection.collectionName,
      logicalCollection,
    );

    let retries = 0;
    // High retry budget to survive concurrent slug collisions (50+ parallel inserts).
    // Each retry only increments suffix by 1, so we need enough room for the worst case.
    const maxRetries = 100;

    while (retries <= maxRetries) {
      try {
        const result = await collection.updateOne(filter, updateDoc, options);

        let data: T[] = [];
        if (result.modifiedCount > 0) {
          const updated = await collection.findOne(filter, options);
          if (updated) {
            data = [updated as unknown as T];
          }
        }

        return {
          data,
          modifiedCount: result.modifiedCount,
          matchedCount: result.matchedCount,
        };
      } catch (error: unknown) {
        const mongoError = error as { code?: number };
        if (mongoError.code === 11000 && retries < maxRetries) {
          retries++;
          // Increment slug in update document
          if (updateDoc.$set?.slug) {
            updateDoc.$set.slug = this.incrementSlugValue(updateDoc.$set.slug);
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error("Max retries exceeded for update operation");
  }

  /**
   * Execute replaceOne
   */
  private async executeReplaceOne<T>(
    collection: Collection,
    filter: Document,
    document: Document,
    options?: { session?: ClientSession },
  ): Promise<{ data: T[]; modifiedCount: number }> {
    let doc = { ...document };
    delete doc._id; // Remove _id from replacement document

    let retries = 0;
    // High retry budget to survive concurrent slug collisions (50+ parallel inserts).
    // Each retry only increments suffix by 1, so we need enough room for the worst case.
    const maxRetries = 100;

    while (retries <= maxRetries) {
      try {
        const result = await collection.replaceOne(filter, doc, options);

        let data: T[] = [];
        if (result.modifiedCount > 0) {
          const replaced = await collection.findOne(filter, options);
          if (replaced) {
            data = [replaced as unknown as T];
          }
        }

        return {
          data,
          modifiedCount: result.modifiedCount,
        };
      } catch (error: unknown) {
        const mongoError = error as { code?: number };
        if (mongoError.code === 11000 && retries < maxRetries) {
          retries++;
          doc = this.incrementSlug(doc);
          continue;
        }
        throw error;
      }
    }

    throw new Error("Max retries exceeded for replace operation");
  }

  /**
   * Execute updateMany
   */
  private async executeUpdateMany<T>(
    collection: Collection,
    filter: Document,
    update: Document,
    logicalCollection?: string,
    options?: { session?: ClientSession },
  ): Promise<{ data: T[]; modifiedCount: number; matchedCount: number }> {
    const updateDoc = this.prepareUpdateDocument(
      update,
      collection.collectionName,
      logicalCollection,
    );

    const result = await collection.updateMany(filter, updateDoc, options);

    let data: T[] = [];
    if (result.modifiedCount > 0) {
      const updated = await collection.find(filter, options).toArray();
      data = updated as unknown as T[];
    }

    return {
      data,
      modifiedCount: result.modifiedCount,
      matchedCount: result.matchedCount,
    };
  }

  /**
   * Execute bulkWrite
   */
  private async executeBulkWrite<T>(
    collection: Collection,
    documents: Document[],
    options?: { session?: ClientSession },
  ): Promise<{ data: T[]; modifiedCount: number }> {
    const operations = documents.map((doc) => {
      const id = doc._id;
      const updateDoc = { ...doc };
      delete updateDoc._id;

      return {
        updateOne: {
          filter: { _id: new ObjectId(id) },
          update: { $set: updateDoc },
        },
      };
    });

    const result = await collection.bulkWrite(operations, {
      ordered: false,
      ...options,
    });

    return {
      data: [],
      modifiedCount: result.modifiedCount,
    };
  }

  // ============================================================================
  // TRANSACTIONS
  // ============================================================================

  /**
   * Start a transaction
   */
  async beginTransaction(): Promise<ClientSession> {
    this.ensureInitialized();
    const session = this.client!.startSession();
    session.startTransaction();
    return session;
  }

  /**
   * Commit transaction
   */
  async commitTransaction(session: unknown): Promise<void> {
    const mongoSession = session as ClientSession;
    await mongoSession.commitTransaction();
    await mongoSession.endSession();
  }

  /**
   * Rollback transaction
   */
  async rollbackTransaction(session: unknown): Promise<void> {
    const mongoSession = session as ClientSession;
    await mongoSession.abortTransaction();
    await mongoSession.endSession();
  }

  // ============================================================================
  // HEALTH & LIFECYCLE
  // ============================================================================

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.db) return false;

    try {
      await this.db.admin().ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dispose resources
   */
  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this._initialized = false;
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private ensureInitialized(): void {
    if (!this._initialized || !this.db) {
      throw Errors.adapterNotInitialized("mongodb");
    }
  }

  private parseConfig(config: AdapterConfig): MongoDBConnectionConfig {
    return {
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      password: config.password,
      ...(config.options as Partial<MongoDBConnectionConfig>),
    };
  }

  private buildConnectionString(config: MongoDBConnectionConfig): string {
    if (config.connectionString) {
      return config.connectionString;
    }

    const auth =
      config.username && config.password
        ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
        : "";

    const host = config.host || "localhost";
    const port = config.port || 27017;
    const db = config.database || "";
    const authSource = config.authSource
      ? `?authSource=${config.authSource}`
      : "";

    return `mongodb://${auth}${host}:${port}/${db}${authSource}`;
  }

  private extractDbName(connectionString: string): string | undefined {
    const match = connectionString.match(/\/([^/?]+)(\?|$)/);
    return match?.[1];
  }

  private setupEventListeners(): void {
    if (!this.client) return;

    this.client.on("connectionPoolCleared", (event) => {
      console.warn(`MongoDB pool cleared: ${event.address}`);
    });

    this.client.on("error", (error) => {
      console.error("MongoDB client error:", error.message);
    });
  }

  private extractFromPipeline(
    pipeline: Document[],
    stageKey: string,
  ): number | undefined {
    const stage = pipeline.find((s) => stageKey in s);
    return stage?.[stageKey];
  }

  private prepareUpdateDocument(
    update: Document,
    collectionName: string,
    _logicalCollection?: string,
  ): Document {
    // Check if already has $set or other update operators
    const hasOperators = Object.keys(update).some((k) => k.startsWith("$"));

    if (hasOperators) {
      // Flatten the $set content if present
      if (update.$set) {
        update.$set = this.queryConverter.flattenObject(update.$set);
      }
      return update;
    }

    // Flatten and wrap in $set
    const flattened = this.queryConverter.flattenObject(update);
    return { $set: flattened };
  }

  private incrementSlug(doc: Document): Document {
    if (doc.slug) {
      doc.slug = this.incrementSlugValue(doc.slug);
    }
    return doc;
  }

  private incrementSlugValue(slug: string): string {
    // Standard convention: separator-counter suffix.
    // "my-post"   → "my-post-2"
    // "my-post-2" → "my-post-3"
    const match = slug.match(/^(.+)-(\d+)$/);
    if (match) {
      return `${match[1]}-${parseInt(match[2]) + 1}`;
    }
    return `${slug}-2`;
  }
}

/**
 * Create a new MongoDB adapter
 */
export function createMongoDBAdapter(
  relationshipRegistry: IRelationshipRegistry,
): MongoDBAdapter {
  return new MongoDBAdapter(relationshipRegistry);
}
