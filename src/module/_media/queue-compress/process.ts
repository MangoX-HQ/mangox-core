import { Worker, Job, Queue, QueueEvents } from 'bullmq';
import pino from 'pino';
import { redisConnection, redisQueuePrefix } from '../../../configs/redis';
import sharp from 'sharp';
import { appSettings } from '../../../configs/app-settings';
import { mediaEventEmitter } from '../media-events';
import { QueueNames, JobPriority, JobType, baseQueueOptions, baseWorkerOptions, dlqQueueOptions, dlqWorkerOptions } from './queue-config';
import { getStorageService } from '../storage/storage.factory';

const storage = getStorageService();

export enum EventQueueCompress {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  FAIL = 'fail',
}

const { webpQuality, sizes, generateThumb, thumbSize, regenerateOnUpload } = appSettings.minio.sharp;

class ProcessService {
  // Main Queues and Workers
  private workerCreate: Worker;
  private queueCreate: Queue;
  private queueEventsCreate: QueueEvents;

  private workerUpdate: Worker;
  private queueUpdate: Queue;
  private queueEventsUpdate: QueueEvents;

  private workerDelete: Worker;
  private queueDelete: Queue;
  private queueEventsDelete: QueueEvents;

  // Dead Letter Queues and Workers
  private workerCreateDLQ: Worker;
  private queueCreateDLQ: Queue;
  private queueEventsCreateDLQ: QueueEvents;

  private workerUpdateDLQ: Worker;
  private queueUpdateDLQ: Queue;
  private queueEventsUpdateDLQ: QueueEvents;

  private workerDeleteDLQ: Worker;
  private queueDeleteDLQ: Queue;
  private queueEventsDeleteDLQ: QueueEvents;

  private readonly PROCESSABLE_FORMATS = ['jpeg', 'jpg', 'png', 'webp', 'avif', 'heif'];

  private isShuttingDown = false;

  constructor() {
    // Subscribe to media events
    // Compress ENABLED: the worker compresses images on upload + via recompress-all. Configured from env
    // (MINIO_COMPRESS_*), always compresses (no mode gate — single-tenant deployment).
    mediaEventEmitter.on(EventQueueCompress.CREATE, this.handleMediaCreated.bind(this));
    mediaEventEmitter.on(EventQueueCompress.UPDATE, this.handleMediaUpdated.bind(this));
    mediaEventEmitter.on(EventQueueCompress.DELETE, this.handleMediaDeleted.bind(this));

    // Initialize Main Queues
    this.queueCreate = new Queue(QueueNames.CREATE, baseQueueOptions);
    this.queueUpdate = new Queue(QueueNames.UPDATE, baseQueueOptions);
    this.queueDelete = new Queue(QueueNames.DELETE, baseQueueOptions);

    // Initialize Dead Letter Queues
    this.queueCreateDLQ = new Queue(QueueNames.CREATE_DLQ, dlqQueueOptions);
    this.queueUpdateDLQ = new Queue(QueueNames.UPDATE_DLQ, dlqQueueOptions);
    this.queueDeleteDLQ = new Queue(QueueNames.DELETE_DLQ, dlqQueueOptions);

    // Initialize Main Workers
    this.workerCreate = new Worker(QueueNames.CREATE, this.processJobCreate.bind(this), baseWorkerOptions);
    this.workerUpdate = new Worker(QueueNames.UPDATE, this.processJobUpdate.bind(this), baseWorkerOptions);
    this.workerDelete = new Worker(QueueNames.DELETE, this.processJobDelete.bind(this), baseWorkerOptions);

    // Initialize DLQ Workers
    this.workerCreateDLQ = new Worker(QueueNames.CREATE_DLQ, this.processJobCreate.bind(this), dlqWorkerOptions);
    this.workerUpdateDLQ = new Worker(QueueNames.UPDATE_DLQ, this.processJobUpdate.bind(this), dlqWorkerOptions);
    this.workerDeleteDLQ = new Worker(QueueNames.DELETE_DLQ, this.processJobDelete.bind(this), dlqWorkerOptions);

    // Initialize Queue Events for monitoring
    this.queueEventsCreate = new QueueEvents(QueueNames.CREATE, { connection: redisConnection, prefix: redisQueuePrefix });
    this.queueEventsUpdate = new QueueEvents(QueueNames.UPDATE, { connection: redisConnection, prefix: redisQueuePrefix });
    this.queueEventsDelete = new QueueEvents(QueueNames.DELETE, { connection: redisConnection, prefix: redisQueuePrefix });
    this.queueEventsCreateDLQ = new QueueEvents(QueueNames.CREATE_DLQ, { connection: redisConnection, prefix: redisQueuePrefix });
    this.queueEventsUpdateDLQ = new QueueEvents(QueueNames.UPDATE_DLQ, { connection: redisConnection, prefix: redisQueuePrefix });
    this.queueEventsDeleteDLQ = new QueueEvents(QueueNames.DELETE_DLQ, { connection: redisConnection, prefix: redisQueuePrefix });

    // Setup event listeners
    this.setupEventListeners();

  }

  /**
   * Set up event listeners for all queues to monitor them
   */
  private setupEventListeners(): void {
    // Main Queue Events
    this.setupQueueEventListeners(this.queueEventsCreate, 'CREATE', this.queueCreateDLQ);
    this.setupQueueEventListeners(this.queueEventsUpdate, 'UPDATE', this.queueUpdateDLQ);
    this.setupQueueEventListeners(this.queueEventsDelete, 'DELETE', this.queueDeleteDLQ);

    // DLQ Queue Events - no longer moves to DLQ, just logs
    this.setupDLQEventListeners(this.queueEventsCreateDLQ, 'CREATE_DLQ');
    this.setupDLQEventListeners(this.queueEventsUpdateDLQ, 'UPDATE_DLQ');
    this.setupDLQEventListeners(this.queueEventsDeleteDLQ, 'DELETE_DLQ');

    // Worker error handlers
    this.setupWorkerErrorHandlers();
  }

  /**
   * Setup event listeners cho main queue
   */
  private setupQueueEventListeners(queueEvents: QueueEvents, queueName: string, dlq: Queue): void {
    // Job completed successfully
    queueEvents.on('completed', ({ jobId }) => {
      pino().info(`✅ [${queueName}] Job ${jobId} completed successfully`);
    });

    // Job failed after exhausting retry attempts
    queueEvents.on('failed', async ({ jobId, failedReason }) => {
      pino().error(`❌ [${queueName}] Job ${jobId} failed after all retries: ${failedReason}`);

      // Move the job into the Dead Letter Queue
      try {
        const job = await this.getJobFromQueue(queueName, jobId);
        if (job) {
          await dlq.add(
            `${queueName}_DLQ_RETRY`,
            {
              ...job.data,
              originalJobId: jobId,
              originalFailedReason: failedReason,
              failedAt: new Date().toISOString(),
              retryCount: job.attemptsMade,
            },
            {
              priority: JobPriority.HIGH, // DLQ jobs have high priority
            },
          );
          pino().info(`📮 [${queueName}] Job ${jobId} moved to DLQ`);
        }
      } catch (error: any) {
        pino().error(`❌ [${queueName}] Failed to move job ${jobId} to DLQ:`, error);
      }
    });

    // Job is stalled (worker crashed or timed out)
    queueEvents.on('stalled', ({ jobId }) => {
      pino().warn(`⚠️ [${queueName}] Job ${jobId} stalled - will be retried`);
    });

    // Job is being processed
    queueEvents.on('active', ({ jobId }) => {
      pino().debug(`🔄 [${queueName}] Job ${jobId} is now active`);
    });

    // Job progress update
    queueEvents.on('progress', ({ jobId, data }) => {
      pino().debug(`📊 [${queueName}] Job ${jobId} progress: ${JSON.stringify(data)}`);
    });
  }

  /**
   * Setup event listeners cho DLQ
   */
  private setupDLQEventListeners(queueEvents: QueueEvents, queueName: string): void {
    queueEvents.on('completed', ({ jobId }) => {
      pino().info(`✅ [${queueName}] DLQ Job ${jobId} completed - job recovered`);
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      pino().error(`❌❌ [${queueName}] DLQ Job ${jobId} PERMANENTLY FAILED: ${failedReason}`);
      // TODO: Send alert to admin/monitoring system
    });

    queueEvents.on('stalled', ({ jobId }) => {
      pino().warn(`⚠️ [${queueName}] DLQ Job ${jobId} stalled`);
    });
  }

  /**
   * Setup error handlers cho workers
   */
  private setupWorkerErrorHandlers(): void {
    const workers = [
      { worker: this.workerCreate, name: 'CREATE' },
      { worker: this.workerUpdate, name: 'UPDATE' },
      { worker: this.workerDelete, name: 'DELETE' },
      { worker: this.workerCreateDLQ, name: 'CREATE_DLQ' },
      { worker: this.workerUpdateDLQ, name: 'UPDATE_DLQ' },
      { worker: this.workerDeleteDLQ, name: 'DELETE_DLQ' },
    ];

    workers.forEach(({ worker, name }) => {
      worker.on('error', (error: any) => {
        pino().error(`❌ [${name}] Worker error:`, error);
      });

      worker.on('failed', (job: any, error: any) => {
        if (job) {
          pino().error(`❌ [${name}] Job ${job.id} failed (attempt ${job.attemptsMade}):`, error);
        }
      });

      worker.on('stalled', (jobId) => {
        pino().warn(`⚠️ [${name}] Worker detected stalled job: ${jobId}`);
      });
    });
  }

  /**
   * Get a job from the queue to move it to the DLQ
   */
  private async getJobFromQueue(queueName: string, jobId: string): Promise<Job | null> {
    let queue: Queue;
    switch (queueName) {
      case 'CREATE':
        queue = this.queueCreate;
        break;
      case 'UPDATE':
        queue = this.queueUpdate;
        break;
      case 'DELETE':
        queue = this.queueDelete;
        break;
      default:
        return null;
    }

    try {
      const job = await queue.getJob(jobId);
      return job || null;
    } catch (error: any) {
      pino().error(`Error getting job ${jobId} from queue ${queueName}:`, error);
      return null;
    }
  }

  /**
   * Clean up all queues, workers, and queue events
   * Called from the graceful shutdown handler at the entry point
   */
  public async cleanup(): Promise<void> {
    if (this.isShuttingDown) {
      pino().warn('Already shutting down...');
      return;
    }

    this.isShuttingDown = true;
    pino().info('🛑 Starting queue cleanup...');

    try {
      // Close workers (wait for running jobs to finish)
      await Promise.all([
        this.workerCreate.close(),
        this.workerUpdate.close(),
        this.workerDelete.close(),
        this.workerCreateDLQ.close(),
        this.workerUpdateDLQ.close(),
        this.workerDeleteDLQ.close(),
      ]);

      // Close queue events
      await Promise.all([
        this.queueEventsCreate.close(),
        this.queueEventsUpdate.close(),
        this.queueEventsDelete.close(),
        this.queueEventsCreateDLQ.close(),
        this.queueEventsUpdateDLQ.close(),
        this.queueEventsDeleteDLQ.close(),
      ]);


      // Close queues
      await Promise.all([
        this.queueCreate.close(),
        this.queueUpdate.close(),
        this.queueDelete.close(),
        this.queueCreateDLQ.close(),
        this.queueUpdateDLQ.close(),
        this.queueDeleteDLQ.close(),
      ]);



    } catch (error: any) {
;
      throw error;
    }
  }

  private shouldProcessImage(metadata: sharp.Metadata, mimetype?: string): boolean {
    const format = metadata.format?.toLowerCase();
    const mimeFormat = mimetype?.split('/')[1]?.toLowerCase();
    const isProcessable = format && this.PROCESSABLE_FORMATS.includes(format);
    const isMimeProcessable = mimeFormat && this.PROCESSABLE_FORMATS.includes(mimeFormat);
    if (isProcessable && isMimeProcessable) {

      return false;
    }
    return true;
  }

  private async processJobCreate(job: Job): Promise<any> {
    let result = {} as any;
    result.data = job.data;
    result.job_name = job.name;
    result.job_id = job.id;

    const { fileName, tenant_id } = job.data;
    if (!fileName) throw new Error('Filename is required');

    const list_file_compressed = await this.compressImage(fileName);
    const uploadResults = [];

    const ext = '.webp';

    for (const { size, buffer } of list_file_compressed) {
      const newPath = `${fileName}/${size}${ext}`;

      await storage.putObject(appSettings.minio.sharp.bucketName || '', newPath, buffer, buffer.length, {
        'Content-Type': 'image/webp',
        'Content-Disposition': 'inline',
      });

      uploadResults.push({
        size,
        path: newPath,
        length: buffer.length,
      });
    }

    // Stamp the media record as compressed → recompress-all?only_missing=true will skip this image.
    // Non-fatal: a flag-write error doesn't break the compress job (the WebP is already uploaded to storage).
    try {
      if (uploadResults.length > 0) {
        const { getCoreUnified } = await import('../../../configs/core');
        const db = await getCoreUnified().getInstanceDB('mongodb', tenant_id);
        await db.collection('media').updateOne(
          { fileName },
          { $set: { image_compressed_at: new Date(), image_variants: uploadResults.map((u) => u.size) } },
        );
      }
    } catch (e: any) {
      console.warn('[compress] stamp media record failed:', e?.message || e);
    }

    result.uploadResults = uploadResults;
    return result;
  }

  private async processJobUpdate(job: Job): Promise<any> {
    const result: any = {
      data: job.data,
      job_name: job.name,
      job_id: job.id,
      actions: [],
    };

    const { currentObjectName, newObjectName } = job.data;
    if (currentObjectName || newObjectName) throw new Error('Both currentObjectName and newObjectName are required');

    await this.queueDelete.add('delete', { fileName: currentObjectName });
    result.actions.push({ type: 'delete', fileName: currentObjectName });

    await this.queueCreate.add('create', { fileName: newObjectName });
    result.actions.push({ type: 'create', fileName: newObjectName });

    return result;
  }

  private async processJobDelete(job: Job): Promise<any> {
    const result: any = {
      data: job.data,
      job_name: job.name,
      job_id: job.id,
      deleted: [],
    };

    const { fileName } = job.data;
    if (fileName) throw new Error('Filename is required');

    for (const size of sizes) {
      const compressedPath = `${fileName}/${size}.webp`;
      try {
        await storage.removeObject(appSettings.minio.sharp.bucketName || '', compressedPath);
        result.deleted.push(compressedPath);
      } catch (err: any) {
  ;
      }
    }

    return result;
  }

  private async handleMediaCreated(data: any) {
    const job = await this.queueCreate.add(QueueNames.CREATE, data);
  }

  private async handleMediaUpdated(data: any) {
    const jobId = await this.queueUpdate.add(QueueNames.UPDATE, data);
  }

  private async handleMediaDeleted(data: any) {
    const jobId = await this.queueDelete.add(QueueNames.DELETE, data);
  }

  private async compressImage(filename: string): Promise<{ size: number; buffer: Buffer }[]> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const stream = await storage.getObject(appSettings.minio.bucketName || '', filename);

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const originalBuffer = Buffer.concat(chunks);

      const metadata = await sharp(originalBuffer).metadata();

      // Formats that CANNOT be compressed (pdf/svg/video…) → return empty, no WebP generated.
      // (Old bug: the condition was inverted, causing compressible images to be skipped.)
      if (!this.shouldProcessImage(metadata)) {
        return [];
      }

      const results: { size: number; buffer: Buffer }[] = [];

      for (const size of sizes) {
        const resized = await sharp(originalBuffer)
          .resize(size, null, {
            withoutEnlargement: true,
            fit: 'inside',
          })
          .webp({ quality: webpQuality || 80 })
          .toBuffer();

        results.push({
          size,
          buffer: resized,
        });
      }
      return results;
    } catch (error: any) {
;
      throw error;
    }
  }

  /**
   * Get the status of all queues including the DLQ
   * Used for health checks and monitoring
   */
  public async getQueueStatus() {
    const [createCounts, updateCounts, deleteCounts, createDLQCounts, updateDLQCounts, deleteDLQCounts] = await Promise.all([
      this.queueCreate.getJobCounts(),
      this.queueUpdate.getJobCounts(),
      this.queueDelete.getJobCounts(),
      this.queueCreateDLQ.getJobCounts(),
      this.queueUpdateDLQ.getJobCounts(),
      this.queueDeleteDLQ.getJobCounts(),
    ]);

    return {
      mainQueues: {
        create: createCounts,
        update: updateCounts,
        delete: deleteCounts,
      },
      deadLetterQueues: {
        create: createDLQCounts,
        update: updateDLQCounts,
        delete: deleteDLQCounts,
      },
      health: {
        isHealthy: this.checkHealth(createCounts, updateCounts, deleteCounts, createDLQCounts, updateDLQCounts, deleteDLQCounts),
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Check the health of the queue system
   */
  private checkHealth(...jobCounts: any[]): boolean {
    // A queue is considered unhealthy if:
    // 1. There are too many failed jobs in the main queue (> 100)
    // 2. There are too many jobs in the DLQ (> 50)
    // 3. There are too many active jobs stuck (> 20)

    const totalMainFailed = jobCounts.slice(0, 3).reduce((acc, counts) => acc + (counts.failed || 0), 0);
    const totalDLQWaiting = jobCounts.slice(3, 6).reduce((acc, counts) => acc + (counts.waiting || 0), 0);
    const totalDLQFailed = jobCounts.slice(3, 6).reduce((acc, counts) => acc + (counts.failed || 0), 0);

    if (totalMainFailed > 100) {

      return false;
    }

    if (totalDLQWaiting > 50) {

      return false;
    }

    if (totalDLQFailed > 10) {

      return false;
    }

    return true;
  }

  /**
   * Get detailed info about failed jobs in the DLQ
   */
  public async getFailedJobs(limit: number = 10) {
    const [createFailed, updateFailed, deleteFailed] = await Promise.all([
      this.queueCreateDLQ.getFailed(0, limit - 1),
      this.queueUpdateDLQ.getFailed(0, limit - 1),
      this.queueDeleteDLQ.getFailed(0, limit - 1),
    ]);

    return {
      create: createFailed?.map((job) => ({
        id: job.id,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
      })),
      update: updateFailed?.map((job) => ({
        id: job.id,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
      })),
      delete: deleteFailed?.map((job) => ({
        id: job.id,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
      })),
    };
  }

  /**
   * Retry a specific job from the DLQ
   */
  public async retryFailedJob(queueType: 'create' | 'update' | 'delete', jobId: string): Promise<boolean> {
    let dlq: Queue;
    let mainQueue: Queue;

    switch (queueType) {
      case 'create':
        dlq = this.queueCreateDLQ;
        mainQueue = this.queueCreate;
        break;
      case 'update':
        dlq = this.queueUpdateDLQ;
        mainQueue = this.queueUpdate;
        break;
      case 'delete':
        dlq = this.queueDeleteDLQ;
        mainQueue = this.queueDelete;
        break;
      default:
        return false;
    }

    try {
      const job = await dlq.getJob(jobId);
      if (!job) {

        return false;
      }

      // Add it back into the main queue
      await mainQueue.add(`${queueType}_MANUAL_RETRY`, job.data, {
        priority: JobPriority.HIGH,
      });

      // Remove from the DLQ
      await job.remove();

      return true;
    } catch (error: any) {
;
      return false;
    }
  }

  /**
   * Clean up old completed and failed jobs
   */
  public async cleanupOldJobs(): Promise<void> {
    const queues = [
      { queue: this.queueCreate, name: 'CREATE' },
      { queue: this.queueUpdate, name: 'UPDATE' },
      { queue: this.queueDelete, name: 'DELETE' },
      { queue: this.queueCreateDLQ, name: 'CREATE_DLQ' },
      { queue: this.queueUpdateDLQ, name: 'UPDATE_DLQ' },
      { queue: this.queueDeleteDLQ, name: 'DELETE_DLQ' },
    ];

    for (const { queue, name } of queues) {
      try {
        // Clean completed jobs older than 7 days
        await queue.clean(7 * 24 * 3600 * 1000, 0, 'completed');
        // Clean failed jobs older than 30 days
        await queue.clean(30 * 24 * 3600 * 1000, 0, 'failed');
  
      } catch (error: any) {
  ;
      }
    }
  }
}

export const processCompressService = new ProcessService();
