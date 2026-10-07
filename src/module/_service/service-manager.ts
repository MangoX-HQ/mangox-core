// Service Manager - Manages and routes messages from Redis topics to the corresponding services

import { appSettings } from '../../configs/app-settings';
import { redisConnection, redisQueuePrefix } from '../../configs/redis';
import { RedisService } from './redis';
import MailService from './_mail/mail.service';
import { NotifyService } from './_notify/notify.service';
import { WebhookService } from './_webhook/webhook.service';
import { Queue, Worker } from 'bullmq';
import { initialize } from 'passport';

interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  ssl: boolean;
  tls: boolean;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

interface ServiceManagerConfig {
  mailConfig?: MailConfig;
  topics?: string[];
}

export class ServiceManager {
  
  private redisService: RedisService;
  private mailService: MailService | null = null;
  private notifyService: NotifyService;
  private webhookService: WebhookService;
  private isInitialized: boolean = false;
  private queue: Record<string, Queue> = {};
  private workers: Record<string, Worker> = {};

  constructor(config?: ServiceManagerConfig) {
    this.redisService = new RedisService();
    this.notifyService = new NotifyService();
    this.webhookService = new WebhookService();

    
    // Initialize MailService if config provided
    if (config?.mailConfig) {
      this.mailService = new MailService(config.mailConfig);
    } else if (appSettings.mail) {
      // Try to get mail config from appSettings
      const mailFrom = appSettings.mail.from || '';
      const mailUser = mailFrom.split('@')[0] || mailFrom; // Extract user from email
      
      const mailConfig: MailConfig = {
        host: appSettings.mail.host || '',
        port: appSettings.mail.port || 587,
        user: mailUser,
        password: appSettings.mail.password || '',
        ssl: false,
        tls: true,
        secure: appSettings.mail.port === 465, // Use secure for port 465
        auth: {
          user: mailUser,
          pass: appSettings.mail.password || '',
        },
      };
      if (mailConfig.host && mailConfig.user && mailConfig.password) {
        this.mailService = new MailService(mailConfig);
        console.log('[ServiceManager] ✅ MailService initialized from appSettings');
      } else {
        console.warn('[ServiceManager] ⚠️ MailService not initialized - missing mail config');
      }
    }
  }

  /**
   * Initialize and start listening to topics
   * @param topics - Optional array of topics to listen to. Default: ['mail:*', 'notify:*', 'webhook:*']
   */
  async initialize(topics?: string[]): Promise<void> {
    if (this.isInitialized) {
      console.log('[ServiceManager] Already initialized');
      return;
    }

    const defaultTopics = topics || ['mail:*', 'notify:*', 'webhook:*'];

    try {
      // Create listeners with message handler
      await this.redisService.createListener(defaultTopics, this.handleMessage.bind(this));
      await this.initQueue();
      this.isInitialized = true;
      console.log('[ServiceManager] ✅ Initialized and listening to topics:', defaultTopics.join(', '));
    } catch (error) {
      console.error('[ServiceManager] ❌ Error initializing:', error);
      throw error;
    }
  }

  async initQueue(): Promise<void> {
    // queue for mailservice
    if (!this.queue['mailQueue']) {
      this.queue['mailQueue'] = new Queue('mailQueue', {
        connection: redisConnection,
        prefix: redisQueuePrefix,
      });
      // create worker for mailservice
      console.log('[ServiceManager] ✅ Mail Queue initialized');

      this.workers['mailQueue'] = new Worker('mailQueue', async job => {
        if (!this.mailService) {
          console.error('[ServiceManager] ❌ MailService not initialized. Cannot process mail jobs.');
          throw new Error('MailService not initialized');
        }
        console.log(`[ServiceManager] 📧 Processing mail job id: ${job.id}`);
        await this.mailService.sendMail(job.data);
        console.log(`[ServiceManager] ✅ Mail job id: ${job.id} completed`);
      }, {
        connection: redisConnection,
        prefix: redisQueuePrefix,
      });

      // Add error handlers
      this.workers['mailQueue'].on('completed', job => {
        console.log(`[ServiceManager] ✅ Mail worker completed job ${job.id}`);
      });

      this.workers['mailQueue'].on('failed', (job, err) => {
        console.error(`[ServiceManager] ❌ Mail worker failed job ${job?.id}:`, err);
      });

      this.workers['mailQueue'].on('error', err => {
        console.error('[ServiceManager] ❌ Mail worker error:', err);
      });

      console.log('[ServiceManager] ✅ Mail Worker started');
    }


    if (!this.queue['notifyQueue']) {

      this.queue['notifyQueue'] = new Queue('notifyQueue', {
        connection: redisConnection,
        prefix: redisQueuePrefix,
      });
      console.log('[ServiceManager] ✅ Notify Queue initialized');

      // create worker for notifyservice
      this.workers['notifyQueue'] = new Worker('notifyQueue', async job => {
        console.log(`[ServiceManager] 🔔 Processing notify job id: ${job.id}`);
        console.log(`[ServiceManager] 🔔 Notify job data:`, JSON.stringify(job.data, null, 2));
        await this.notifyService.sendNotification(job.data);
        console.log(`[ServiceManager] ✅ Notify job id: ${job.id} completed`);
      }, {
        connection: redisConnection,
        prefix: redisQueuePrefix,
      });

      // Add error handlers
      this.workers['notifyQueue'].on('completed', job => {
        console.log(`[ServiceManager] ✅ Notify worker completed job ${job.id}`);
      });

      this.workers['notifyQueue'].on('failed', (job, err) => {
        console.error(`[ServiceManager] ❌ Notify worker failed job ${job?.id}:`, err);
      });

      this.workers['notifyQueue'].on('error', err => {
        console.error('[ServiceManager] ❌ Notify worker error:', err);
      });

      console.log('[ServiceManager] ✅ Notify Worker started');
    }


    if (!this.queue['webhookQueue']) {
      this.queue['webhookQueue'] = new Queue('webhookQueue', {
        connection: redisConnection,
        prefix: redisQueuePrefix,
      });
      console.log('[ServiceManager] ✅ Webhook Queue initialized');

      // create worker for webhookservice
      this.workers['webhookQueue'] = new Worker('webhookQueue', async job => {
        console.log(`[ServiceManager] 🔗 Processing webhook job id: ${job.id}`);
        console.log(`[ServiceManager] 🔗 Webhook job data:`, JSON.stringify(job.data, null, 2));
        await this.webhookService.sendWebhook(job.data);
        console.log(`[ServiceManager] ✅ Webhook job id: ${job.id} completed`);
      }, {
        connection: redisConnection,
        prefix: redisQueuePrefix,
      });

      // Add error handlers
      this.workers['webhookQueue'].on('completed', job => {
        console.log(`[ServiceManager] ✅ Webhook worker completed job ${job.id}`);
      });

      this.workers['webhookQueue'].on('failed', (job, err) => {
        console.error(`[ServiceManager] ❌ Webhook worker failed job ${job?.id}:`, err);
      });

      this.workers['webhookQueue'].on('error', err => {
        console.error('[ServiceManager] ❌ Webhook worker error:', err);
      });

      console.log('[ServiceManager] ✅ Webhook Worker started');
    }
  }

  // import job into queue

  async addJobToQueue(queueName: string, data: any): Promise<void> {
    if (!this.queue[queueName]) {
      console.error(`[ServiceManager] ❌ Queue ${queueName} not initialized. Cannot add job.`);
      return;
    }
    await this.queue[queueName].add(`${queueName}-job`, data, {
      delay: 10000
      
    });
    console.log(`[ServiceManager] ✅ Job added to queue ${queueName}`);
  }

  /**
   * Handle incoming messages from Redis topics
   */
  private async handleMessage(topic: string, message: string): Promise<void> {
    try {
      console.log(`[ServiceManager] 📨 Received message on topic: ${topic}`);

      // Parse message
      let data: any;
      try {
        data = JSON.parse(message);
      } catch (parseError) {
        console.error(`[ServiceManager] ❌ Error parsing message from topic ${topic}:`, parseError);
        return;
      }

      // Route to appropriate service based on topic
      if (topic.startsWith('mail:') || topic === 'mail') {
        await this.handleMailMessage(topic, data);
      } else if (topic.startsWith('notify:') || topic === 'notify') {
        await this.handleNotifyMessage(topic, data);
      } else if (topic.startsWith('webhook:') || topic === 'webhook') {
        await this.handleWebhookMessage(topic, data);
      } else {
        console.warn(`[ServiceManager] ⚠️ Unknown topic: ${topic}`);
      }
    } catch (error) {
      console.error(`[ServiceManager] ❌ Error handling message from topic ${topic}:`, error);
    }
  }

  /**
   * Handle mail messages
   */
  private async handleMailMessage(topic: string, data: any): Promise<void> {
    if (!this.mailService) {
      console.error('[ServiceManager] ❌ MailService not initialized. Please provide mailConfig.');
      return;
    }

    try {
      console.log(`[ServiceManager] 📧 Processing mail message from topic: ${topic}`);
      await this.mailService.sendMail(data);
      console.log(`[ServiceManager] ✅ Mail sent successfully from topic: ${topic}`);
    } catch (error) {
      console.error(`[ServiceManager] ❌ Error sending mail from topic ${topic}:`, error);
      throw error;
    }
  }

  /**
   * Handle notification messages
   */
  private async handleNotifyMessage(topic: string, data: any): Promise<void> {
    try {
      console.log(`[ServiceManager] 🔔 Processing notification message from topic: ${topic}`);
      await this.notifyService.sendNotification(data);
      console.log(`[ServiceManager] ✅ Notification sent successfully from topic: ${topic}`);
    } catch (error) {
      console.error(`[ServiceManager] ❌ Error sending notification from topic ${topic}:`, error);
      throw error;
    }
  }

  /**
   * Handle webhook messages
   */
  private async handleWebhookMessage(topic: string, data: any): Promise<void> {
    try {
      console.log(`[ServiceManager] 🔗 Processing webhook message from topic: ${topic}`);
      await this.webhookService.sendWebhook(data);
      console.log(`[ServiceManager] ✅ Webhook sent successfully from topic: ${topic}`);
    } catch (error) {
      console.error(`[ServiceManager] ❌ Error sending webhook from topic ${topic}:`, error);
      throw error;
    }
  }

  /**
   * Reload listeners with new topics
   */
  async reloadListeners(topics: string[]): Promise<void> {
    try {
      await this.redisService.reloadListener(topics);
      console.log('[ServiceManager] ✅ Listeners reloaded with topics:', topics.join(', '));
    } catch (error) {
      console.error('[ServiceManager] ❌ Error reloading listeners:', error);
      throw error;
    }
  }

  /**
   * Get currently subscribed topics
   */
  getSubscribedTopics(): string[] {
    return this.redisService.getSubscribedTopics();
  }

  /**
   * Publish a message to a topic
   */
  async publish(topic: string, message: string | object): Promise<number> {
    console.log(`[ServiceManager] 📤 Publishing message to topic: ${topic}`);
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    console.log(`[ServiceManager] 📤 Message content: ${messageStr}`);
    return await this.redisService.publish(topic, messageStr);
  }

  /**
   * Close all connections and cleanup
   */
  async close(): Promise<void> {
    try {
      // Close all workers
      for (const [name, worker] of Object.entries(this.workers)) {
        console.log(`[ServiceManager] 🧹 Closing worker: ${name}`);
        await worker.close();
      }
      this.workers = {};

      // Close all queues
      for (const [name, queue] of Object.entries(this.queue)) {
        console.log(`[ServiceManager] 🧹 Closing queue: ${name}`);
        await queue.close();
      }
      this.queue = {};

      // Close Redis service
      await this.redisService.close();
      this.isInitialized = false;
      console.log('[ServiceManager] ✅ Closed all connections');
    } catch (error) {
      console.error('[ServiceManager] ❌ Error closing connections:', error);
      throw error;
    }
  }
}

// Singleton instance
let serviceManagerInstance: ServiceManager | null = null;

/**
 * Get or create ServiceManager instance
 */
export function getServiceManager(config?: ServiceManagerConfig): ServiceManager {
  if (!serviceManagerInstance) {
    serviceManagerInstance = new ServiceManager(config);
  }
  return serviceManagerInstance;
}

/**
 * Initialize ServiceManager with default topics
 */
export async function initializeServiceManager(config?: ServiceManagerConfig): Promise<ServiceManager> {
  const manager = getServiceManager(config);
  await manager.initialize();
  return manager;
}
