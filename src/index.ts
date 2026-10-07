import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import compress from 'compression';
import 'dotenv/config';
import Fastify from 'fastify';
import os from 'os';
import process from 'process';
import { v4 as uuidv4 } from 'uuid';
import { appSettings } from './configs/app-settings';
import { filterPassword, redisGlobal } from './configs/core';
import { InitialCoreUnified, getCoreUnified } from './configs/core';
import { responseInterceptor } from './response';
import { isAppError } from './utils/app-error';
import { isCoreError, isValidationError } from './core_v2/errors';
import { IndexRoute } from './routes/_index';

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { customizeSwaggerSpec } from './configs/swagger';
// import { DynamicCronService } from './jobs/cron';
import { JWTGuard } from './module/_auth';
import { registerMcpRoutes } from './module/_mcp/mcp.controller';
import formbody from '@fastify/formbody';
// Check Redis eviction policy BEFORE importing queue services
// Queue services initialize on import, so we need to check first
import { checkAndFixRedisEvictionPolicy } from './utils/redis-eviction-check';

// Run check immediately (async, won't block)
checkAndFixRedisEvictionPolicy().catch(() => {
  // Silent fail - will try again in start() function
});

import { processCompressService } from './module/_media/queue-compress/process';
import { RequestContext } from './utils/request-context';
import { initializeServiceManager, getServiceManager } from './module/_service';
import { IndexRouteV2 } from './routes/_index_v2';

declare global {
  var filterPassword: any;
}
global.filterPassword = filterPassword;

const handleUncaughtException = (err: Error) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
};

const handleUnhandledRejection = (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
};

process.on('uncaughtException', handleUncaughtException);
process.on('unhandledRejection', handleUnhandledRejection);

const app = Fastify({
  trustProxy: true,
  routerOptions: {
    maxParamLength: 200,
  },
});

export const jwtGuard = new JWTGuard(app);

/**
 * Single normalization point for every thrown error. Recognizes (in order):
 * AppError -> CoreError -> HttpError -> Fastify validation -> Mongo -> unknown.
 * Always emits `{ is_err, statusCode, message, code, fields?, data }`; the
 * `is_err` flag tells responseInterceptor (response.ts) to skip wrapping.
 * 5xx / non-exposed errors are logged in full before the message is hidden.
 */
const setupErrorHandler = () => {
  app.setErrorHandler(async (error: any, request, reply) => {
    let statusCode = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal Server Error';
    let fields: Array<{ field: string; message: string }> | undefined;
    let details: unknown;
    let expose = false;

    if (isAppError(error)) {
      statusCode = error.statusCode;
      code = error.code;
      expose = error.expose;
      message = expose ? error.message : 'Internal Server Error';
      fields = error.fields;
      details = error.details;
    } else if (isCoreError(error)) {
      statusCode = error.statusCode;
      code = error.code;
      message = error.message;
      expose = true;
      if (isValidationError(error)) {
        fields = error.validationErrors.map((v) => ({
          field: v.field || '',
          message: v.message,
        }));
      }
    } else if (Array.isArray(error?.validation)) {
      // Fastify schema (AJV) validation error.
      // If a route's schemaErrorFormatter ran, error.message is already a
      // friendly joined string — prefer it over the generic fallback.
      statusCode = 400;
      code = 'VALIDATION_FAILED';
      message = error.message || 'Validation failed';
      expose = true;
      fields = error.validation.map((v: any) => ({
        field:
          (v.instancePath || '').replace(/^\//, '') ||
          v.params?.missingProperty ||
          '',
        message: v.message || 'Invalid value',
      }));
    } else if (error?.code === 11000) {
      // Mongo duplicate key — expose field name(s) only, never the value
      statusCode = 409;
      code = 'DUPLICATE_KEY';
      expose = true;
      const dupFields = Object.keys(error.keyPattern || error.keyValue || {});
      message = dupFields.length
        ? `Duplicate value for: ${dupFields.join(', ')}`
        : 'Duplicate value';
    } else if (
      error?.name === 'CastError' ||
      error?.name === 'BSONError' ||
      error?.name === 'BSONTypeError'
    ) {
      statusCode = 400;
      code = 'INVALID_ID';
      message = 'Invalid identifier format';
      expose = true;
    } else {
      // Unknown / legacy: honor a status if present, but keep message hidden.
      // Some callers throw `{ error: <real error> }` — unwrap for status only.
      const inner = error?.error && typeof error.error === 'object' ? error.error : error;
      statusCode = inner?.status || inner?.statusCode || 500;
      code = statusCode >= 500 ? 'INTERNAL_ERROR' : `HTTP_${statusCode}`;
      // Sub-500 legacy errors carried user-facing messages historically; keep them.
      if (statusCode < 500 && inner?.message) {
        message = inner.message;
        expose = true;
      }
      details = inner?.details;
    }

    if (!expose || statusCode >= 500) {
      request.log.error(
        { err: error, statusCode, code },
        '[ErrorHandler] unhandled/internal error',
      );
    }

    reply.status(statusCode).send({
      is_err: true, // Flag so responseInterceptor skips it
      statusCode,
      code,
      message,
      ...(fields && fields.length ? { fields } : {}),
      data: details ? filterPassword(details) : undefined,
    });
  });
};

const registerPlugins = async () => {
  // Debug logger (DEBUG=true) — must register early so the hook catches every request
  const { registerDebugPlugin } = await import('./core_v2/debug/debug-plugin');
  await registerDebugPlugin(app);

  // DIFFERENT from backend-tenant: this is a self-contained DEPLOY build with its own login, so it MUST sign its own tokens.
  // (backend-tenant removes @fastify/jwt since it only verifies RS256 tokens signed by Studio.)
  // Sign HS256 using JWT_SECRET — verifyToken (jwt-verify.ts) already supports the HS256 branch,
  // so this self-signed token can be verified right away without needing the SSO public key.
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || '',
  });

  // Upload file size limit — configurable via env UPLOAD_MAX_FILE_SIZE_MB (default 50MB).
  const uploadMaxMB = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB) || 50;
  await app.register(require('@fastify/multipart'), {
    limits: {
      fileSize: 1024 * 1024 * uploadMaxMB,
    },
  });

  // Parse application/x-www-form-urlencoded — required for OAuth token endpoint
  await app.register(formbody);

  // Single-tenant + SSO: local Passport/hybrid auth has been removed. JWT is verified via SSO.

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['*'],
    preflight: true,
    strictPreflight: false,
  });
};

const registerRoutes = async () => {
  app.get('/', async (request, reply) => {
    // test redis sub pub on redisGlobal
    return { message: 'Welcome to the API' };
  });

  // MCP endpoint at ROOT (no prefix) → https://<host>/mcp.
  // No longer mounts OAuth discovery (/.well-known/*) or the OAuth flow (/oauth/*): the tenant
  // doesn't issue its own tokens. Auth into /mcp uses an api-key (mgs_) or an SSO token (RS256)
  // signed by Studio — verified in mcp.guard. Create an api-key via POST /api/v1/api-keys.
  await registerMcpRoutes(app);

  // Test routes: GET /api/test/:entityName (admin only, no builders)
  // await app.register(
  //   async function (fastify) {
  //     await TestRoutes(fastify);
  //   },
  //   { prefix: '/api/test' },
  // );

  // Always register v2 routes first (SettingRoutes/JSON takes priority)
  await app.register(
    async function (fastify) {
      IndexRouteV2(fastify);
    },
    { prefix: `/api/v1` },
  );

  if (appSettings.prefixApi) {
    // await app.register(registerAllGeneratedRoutes, {
    //     prefix: `${appSettings.prefixApi}/protean`
    // });

    await app.register(
      async function (fastify) {
        IndexRoute(fastify);
      },
      { prefix: appSettings.prefixApi },
    );
  } else {
    IndexRoute(app);
  }
};

const addPerformanceTracking = () => {
  const excludedRoutes = ['/health', '/healthcheck', '/ping'];
  app.addHook('onRequest', async (request: any, _reply: any) => {
    if (excludedRoutes.some((route) => request.url.startsWith(route))) {
      return;
    }

    const requestId = (request.headers['x-request-id'] as string) || uuidv4();
    const startTime = performance.now();

    request.requestId = requestId;
    request.perfStartTime = startTime;

    RequestContext.setCurrentRequestId(requestId);
  });

  app.addHook('onResponse', async (request: any, _reply) => {
    if (request.perfStartTime) {
      RequestContext.clearCurrentRequestId();
    }
  });
};

const builderSwagger = async () => {
  await app.register(swagger, {
    mode: 'dynamic',
    openapi: {
      info: {
        title: 'Capstone - API - Documentation',
        description: 'API for user interface development',
        version: '1.1',
      },
      servers: [{ url: 'https://mangox-api.mangoads.com.vn/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'none',
      deepLinking: false,
      defaultModelsExpandDepth: -1,
    },
  });
};

const exportSwaggerSpec = async () => {
  // Create the public directory if it doesn't exist
  if (!existsSync('./public')) {
    mkdirSync('./public', { recursive: true });
  }

  // Wait for the server to be ready so we can fetch the swagger spec
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    // Fetch the swagger spec from the /docs/json endpoint
    let swaggerSpec = app.swagger();

    // Run custom transformation
    swaggerSpec = await customizeSwaggerSpec(swaggerSpec);

    // Write to file
    writeFileSync('./public/swagger-spec.json', JSON.stringify(swaggerSpec, null, 2));
    console.log('[SWAGGER] spec exported to ./public/swagger-spec.json');
  } catch (error) {
    console.error('[SWAGGER] error:', error);
  }
};

// Save references to the services that need cleanup
// let cronService: DynamicCronService | null = null;
let serviceManager: ReturnType<typeof getServiceManager> | null = null;
let isShuttingDown = false;

/**
 * Graceful shutdown handler
 * Cleans up all resources in the correct order to ensure the port gets released
 */
const setupGracefulShutdown = () => {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.log('Already shutting down...');
      return;
    }

    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

    try {
      // 1. Close Fastify app (most important - releases the port)
      console.log('📦 Closing Fastify server...');
      await app.close();
      console.log('✅ Fastify server closed');

      // 2. Cleanup queue workers
      console.log('📦 Cleaning up queue workers...');
      try {
        await processCompressService.cleanup();
      } catch (error: any) {
        console.error('⚠️ Error cleaning up queue workers:', error.message);
      }

      // 3. Stop cron jobs
      console.log('📦 Stopping cron jobs...');
      try {
        // if (cronService) {
        //   cronService.removeAllDynamicCronJobs();
        // }
      } catch (error: any) {
        console.error('⚠️ Error stopping cron jobs:', error.message);
      }

      // 4. Close ServiceManager
      console.log('📦 Closing ServiceManager...');
      try {
        if (serviceManager) {
          await serviceManager.close();
        }
      } catch (error: any) {
        console.error('⚠️ Error closing ServiceManager:', error.message);
      }

      // 6. Dispose core services (MongoDB, Redis, etc.)
      console.log('📦 Disposing core services...');
      try {
        const coreUnified = getCoreUnified() as any;
        if (coreUnified?.dispose) {
          await coreUnified.dispose();
        }
      } catch (error: any) {
        console.error('⚠️ Error disposing core services:', error.message);
      }

      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error: any) {
      console.error('❌ Error during graceful shutdown:', error);
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C
};

const start = async () => {
  try {
    // Check and fix Redis eviction policy for BullMQ compatibility
    // This must be done BEFORE initializing queue services
    await checkAndFixRedisEvictionPolicy();

    await InitialCoreUnified();

    // Config mc alias
    const { exec } = require('child_process');
    exec(`mc alias set myminio http://${appSettings.minio.endpoint}:${appSettings.minio.port} ${appSettings.minio.accessKey} ${appSettings.minio.secretKey}`, (error: any, stdout: any) => {
      if (error) console.error('MC config failed:', error);
      else console.log('[MINIO] connected');
    });

    addPerformanceTracking();
    setupErrorHandler();
    await app.register(compress);

    app.addHook('onSend', responseInterceptor);
    await builderSwagger();
    await registerPlugins();
    await registerRoutes();

    // Dynamic cron — reads the `cron-job` collection, NOT a change stream (no replica
    // set required). To change config, call POST /cron/reload (doesn't watch the DB).
    try {
      const { dynamicCronService } = await import('./jobs/cron');
      await dynamicCronService.init();
    } catch (error: any) {
      console.error('[Cron] init lỗi:', error?.message || error);
    }

    // Initialize ServiceManager for Redis pub/sub services
    try {
      console.log('[ServiceManager] Initializing...');
      serviceManager = await initializeServiceManager();
      console.log('[ServiceManager] ✅ Initialized and listening to topics: mail:*, notify:*, webhook:*');
    } catch (error: any) {
      console.error('[ServiceManager] ❌ Error initializing:', error.message);
      // Don't exit - continue without ServiceManager
    }

    // Setup graceful shutdown handler BEFORE starting the server
    setupGracefulShutdown();

    const port = parseInt(appSettings.port || '3000');

    // Retry logic for port conflicts during nodemon restart
    let retries = 3;
    let lastError: any;
    while (retries > 0) {
      try {
        await app.listen({ port, host: '0.0.0.0' });
        console.log(`[SERVER] is running at http://localhost:${port}`);
        break;
      } catch (err: any) {
        lastError = err;
        if (err.code === 'EADDRINUSE' && retries > 1) {
          console.log(`[SERVER] Port ${port} is busy, waiting 2s before retry... (${retries - 1} retries left)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          retries--;
        } else {
          throw err;
        }
      }
    }

    // Export swagger spec to static JSON file
    await exportSwaggerSpec();

    console.log('==============================');
    console.log(`[SERVER] CPU Cores: ${os.cpus().length}`);
    console.log(
      `[SERVER] Memory Usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB / ${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB (${(
        (process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) *
        100
      ).toFixed(2)}%)`,
    );
    console.log('==============================');
  } catch (err: any) {
    console.error('[SERVER] error:', err.message);
    console.error('[SERVER] error details:', err);
    if (err.stack) {
      console.error('[SERVER] error stack:', err.stack);
    }
    app.log.error('[SERVER] error:', err.message);
    app.log.error('[SERVER] error details:', err);
    process.exit(1);
  }
};

start();

