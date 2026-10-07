import { BootstrapConfig } from "../core_v2/compat";
import type { RedisConfig, MongoConfig, MinioConfig, ElasticsearchConfig, MailConfig, CloudflareConfig } from "./types";
import * as fs from "fs";
import * as path from "path";

// Ensure dotenv is loaded (safe to call multiple times — dotenv is idempotent)
try { require('dotenv').config(); } catch {}

// Read MongoDB URI from json/{APP_SLUG}.json when MONGODB_URL is not set
function resolveMongoUrl(): string {
  if (process.env.MONGODB_URL) return process.env.MONGODB_URL;
  const slug = process.env.APP_SLUG || "mangoads";
  // Use process.cwd() (backend root) — reliable across tsx/compiled contexts
  const configPath = path.resolve(process.cwd(), `json/${slug}.json`);
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config?.database?.uri) {
        console.log(`[AppSettings] MongoDB URI loaded from json/${slug}.json`);
        return config.database.uri;
      }
    } else {
      console.warn(`[AppSettings] json/${slug}.json not found at ${configPath}`);
    }
  } catch (e) {
    console.warn(`[AppSettings] Failed to read json/${slug}.json:`, e);
  }
  return "mongodb://localhost:27017/mangoads";
}

export const appSettings = {
  appName: process.env.APP_NAME || "THAILY",
  node_env: process.env.NODE_ENV,
  cronjob: process.env.CRON_JOB,
  filter_mode: process.env.FILTER_MODE || "NEW",
  development: false,
  select_mode: process.env.SELECT_MODE || "OLD",
  mongodb_mode: process.env.MONGODB_MODE || "STANDALONE",
  timeZone: process.env.TIME_ZONE,
  log_mode: process.env.LOG_MODE || "NO_HAVE",
  timeZoneMongoDB: {
    createdAt: "created_at",
    updatedAt: "updated_at",
    getCurrentTime() {
      return new Date().toLocaleString("en-US", {
        timeZone: appSettings.timeZone,
      });
    },
    getCustomTime(time: string) {
      return new Date(time);
    },
  },
  port: process.env.PORT,
  prefixApi: process.env.PREFIX_API,
  corsOrigin: ["*"],
  mongo: {
    url: resolveMongoUrl(),
    dbName: "test",
    options: "?tls=true&authSource=admin&replicaSet=mangoads-mongodb-2025",
    isReplicaSet: process.env.IS_REPLICA_SET === "true" ? true : false,
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT,
    port: process.env.MINIO_PORT,
    user: process.env.MINIO_USER,
    password: process.env.MINIO_PASSWORD,
    loginPort: process.env.MINIO_LOGIN_PORT,
    useHash: process.env.MINIO_USE_HASH === "true",
    useSSL: process.env.MINIO_USE_SSL !== "false",
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucketName: process.env.MINIO_BUCKET_NAME,
    public: process.env.MINIO_PUBLIC,
    region: process.env.MINIO_REGION || "auto",
    sharp: {
      bucketName: process.env.MINIO_COMPRESS_BUCKET_NAME,
      webpQuality: Number((process.env.MINIO_COMPRESS_WEBP_QUALITY || "80")),
      sizes: (process.env.MINIO_COMPRESS_SIZES || "").split(",")?.map(Number),
      generateThumb: process.env.MINIO_GENERATE_THUMB === "true",
      thumbSize: Number(process.env.MINIO_THUMB_SIZE || "200"),
      regenerateOnUpload: process.env.MINIO_REGENERATE_ON_UPLOAD === "true"
    },
     cv: {
      bucketName: process.env.MINIO_CV_BUCKET_NAME,
      public: process.env.MINIO_CV_PUBLIC,
     }
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT) || 6379,
    username: process.env.REDIS_USERNAME || "default",
    password: process.env.REDIS_PASSWORD || "",
    db: Number(process.env.REDIS_DB) || 0,
    prefix: process.env.REDIS_PREFIX || "default",
    prefixJson: process.env.REDIS_PREFIX_JSON || process.env.REDIS_PREFIX || "default",
    url: process.env.REDIS_URL,
    cacheTTL: Number(process.env.REDIS_CACHE_TTL) || 3600, // Default 1 hour
  },
  restAdapters: {
    'rest': {
      baseUrl: process.env.CORE_B_URL || '',
      apiKey: process.env.CORE_B_API_KEY || '',
    },
  },
  cloudflare: {
    apiKey: process.env.CLOUDFLARE_API_KEY,
    zoneId: process.env.CLOUDFLARE_ZONE_ID
  },
  elasticsearch: {
    mode: process.env.ELASTICSEARCH_MODE || "ENABLED",
    host: process.env.ELASTICSEARCH_HOST || "localhost",
    port: Number(process.env.ELASTICSEARCH_PORT) || 9200,
    index: process.env.ELASTICSEARCH_INDEX || "post_type_content",
    batchSize: Number(process.env.ELASTICSEARCH_BATCH_SIZE) || 1500,
    syncCron: process.env.ELASTICSEARCH_SYNC_CRON || "*/5 * * * *"
  },
  mail: {
    host: process.env.MAIL_HOST || "localhost",
    port: Number(process.env.MAIL_PORT) || 587,
    from: process.env.MAIL_FROM || "noreply@example.com",
    password: process.env.MAIL_PASSWORD || "",
  },
  // Core V2 configuration
  core_v2: {
    enabled: process.env.CORE_V2_ENABLED === "true",
  },
};

// Build redis URL on-the-fly from host/port/password/db (single source — do NOT
// cache a separate `url` field, to avoid db mismatches). Used for url-based cache drivers.
export const buildRedisUrl = (): string => {
  const r = appSettings.redis;
  if (r.url) return r.url;
  const username = r.username || "default";
  const auth = r.password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(r.password)}@`
    : '';
  const scheme = process.env.REDIS_TLS === 'true' ? 'rediss' : 'redis';
  return `${scheme}://${auth}${r.host}:${r.port}/${r.db ?? 0}`;
};

export const buildRedisJsonKeyPrefix = (): string => {
  const prefix = (appSettings.redis as any).prefixJson || appSettings.redis.prefix || "default";
  return prefix.endsWith(":") ? prefix : `${prefix}:`;
};

export const buildRedisKeyPrefix = (): string => {
  const prefix = appSettings.redis.prefix || "default";
  return prefix.endsWith(":") ? prefix : `${prefix}:`;
};

export const settingCore: BootstrapConfig = {
  includeBuiltinAdapters: false,
  redis: {
    url: buildRedisUrl(),
    host: appSettings.redis.host,
    port: appSettings.redis.port,
    username: appSettings.redis.username,
    password: appSettings.redis.password,
    db: appSettings.redis.db,
    prefix: appSettings.redis.prefix,
    cacheTTL: appSettings.redis.cacheTTL,
  },
  relationships: {
    All: [
      {
        name: "created_by",
        targetTable: "user",
        localField: "created_by",
        foreignField: "_id",
        type: "one-to-one",
      },
      {
        name: "updated_by",
        targetTable: "user",
        localField: "updated_by",
        foreignField: "_id",
        type: "one-to-one",
      },
    ],
    "page-ai": [
      {
        name: "blocks",
        targetTable: "block",
        localField: "blocks",
        foreignField: "_id",
        type: "many-to-one",
      }
    ]
    // Your specific relationships for the complex query
    // user: [
    //   {
    //     name: "user_roles",
    //     targetTable: "role",
    //     localField: "role",
    //     foreignField: "_id",
    //     type: "one-to-many"
    //   }
    // ]
    // users: [
    //   {
    //     name: "product_reviews",
    //     targetTable: "product_reviews",
    //     localField: "_id",
    //     foreignField: "userId",
    //     type: "one-to-many",
    //   },
    // ],
    // product_reviews: [
    //   {
    //     name: "products",
    //     targetTable: "products",
    //     localField: "productId",
    //     foreignField: "_id",
    //     type: "one-to-one",
    //   },
    //   {
    //     name: "user",
    //     targetTable: "users",
    //     localField: "userId",
    //     foreignField: "_id",
    //     type: "one-to-one",
    //   },
    // ],
    // orders: [
    //   {
    //     name: "products",
    //     targetTable: "products",
    //     localField: "items.productId",
    //     foreignField: "_id",
    //     type: "many-to-many",
    //   }
    // ],
    // products: [
    //   {
    //     name: "categories",
    //     targetTable: "categories",
    //     localField: "_id",
    //     foreignField: "_id",
    //     type: "many-to-many",
    //     junction: {
    //       table: "product_categories",
    //       localKey: "productId",
    //       foreignKey: "categoryId",
    //     },
    //   },
    //   {
    //     name: "reviews",
    //     targetTable: "product_reviews",
    //     localField: "_id",
    //     foreignField: "productId",
    //     type: "one-to-many",
    //   },{
    //     name: "category",
    //     targetTable: "categories",
    //     localField: "primaryCategoryId",
    //     foreignField: "_id",
    //     type: "one-to-one",
    //   }
    // ],
    // categories: [
    //   {
    //     name: "children",
    //     targetTable: "categories",
    //     localField: "_id",
    //     foreignField: "parentId",
    //     type: "one-to-many",
    //   },
    //   {
    //     name: "parent",
    //     targetTable: "categories",
    //     localField: "parentId",
    //     foreignField: "_id",
    //     type: "many-to-one",
    //   },
    //   {
    //     name: "products",
    //     targetTable: "products",
    //     localField: "_id",
    //     foreignField: "_id",
    //     type: "many-to-many",
    //     junction: {
    //       table: "product_categories",
    //       localKey: "categoryId",
    //       foreignKey: "productId",
    //     },
    //   },
    // ],
  },
  core: {
    adapters: {
      mongodb: {
        connection: {
          connectionString:
            process.env.MONGODB_URL ||
            "mongodb+srv://thinhlevan201:l8hhIko3GH8ns6pxI3Xw2nrOpo08XIMkAmufNIFQAEy6CvMW1M@cluster0.8ihdhzg.mongodb.net/mangox?authSource=admin",
        },
      },
      // postgresql: {
      //   connection: {
      //     host: process.env.POSTGRES_HOST || "localhost",
      //     port: parseInt(process.env.POSTGRES_PORT || "5432"),
      //     database: process.env.POSTGRES_DB || "mydb",
      //     username: process.env.POSTGRES_USER || "admin",
      //     password: process.env.POSTGRES_PASSWORD || "secret",
      //   },
      // },
      elasticsearch: {
        connection: {
          node: `http://${process.env.ELASTICSEARCH_HOST || "localhost"}:${process.env.ELASTICSEARCH_PORT || "9200"}`,
        },
      },
      // mysql: {
      //   connection: {
      //     host: process.env.MYSQL_HOST || "localhost",
      //     port: parseInt(process.env.MYSQL_PORT || "3306"),
      //     database: process.env.MYSQL_DB || "myappdb",
      //     username: process.env.MYSQL_USER || "thaily",
      //     password: process.env.MYSQL_PASSWORD || "Th@i2004",
      //   },
      // },
    },
  },
};
