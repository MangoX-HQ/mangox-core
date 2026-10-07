
// this is service listen pub/sub to run service orther

import { Redis } from "ioredis";
import { redisClient, redisConnection } from "../../configs/redis";


export class RedisService {
    private readonly redisClient: Redis;
    private subscriber: Redis | null = null;
    private subscribedTopics: Set<string> = new Set();
    private messageCallback: ((topic: string, message: string) => void) | null = null;
   
    constructor() {
        this.redisClient = new Redis(redisConnection);
    }

    /**
     * Create a new subscriber client for pub/sub
     * Redis client cannot be used for both pub/sub and regular operations
     */
    private getSubscriber(): Redis {
        if (!this.subscriber) {
            this.subscriber = new Redis(redisConnection);
            this.setupSubscriberHandlers();
        }
        return this.subscriber;
    }

    /**
     * Setup event handlers for subscriber
     */
    private setupSubscriberHandlers(): void {
        if (!this.subscriber) return;

        this.subscriber.on('message', (channel: string, message: string) => {
            if (this.messageCallback) {
                this.messageCallback(channel, message);
            }
        });

        this.subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
            if (this.messageCallback) {
                this.messageCallback(channel, message);
            }
        });

        this.subscriber.on('error', (error: Error) => {
            console.error('[RedisService] Subscriber error:', error);
        });

        this.subscriber.on('connect', () => {
            console.log('[RedisService] Subscriber connected');
        });

        this.subscriber.on('close', () => {
            console.log('[RedisService] Subscriber closed');
        });
    }

    /**
     * Create listeners for specified topics
     * @param topics - Array of topic names to subscribe to
     * @param callback - Callback function to handle messages (topic, message)
     */
    async createListener(topics: string[], callback: (topic: string, message: string) => void): Promise<void> {
        try {
            // Store callback
            this.messageCallback = callback;

            // Get or create subscriber
            const subscriber = this.getSubscriber();

            // Subscribe to each topic
            const newTopics: string[] = [];
            for (const topic of topics) {
                if (!this.subscribedTopics.has(topic)) {
                    newTopics.push(topic);
                    this.subscribedTopics.add(topic);
                }
            }

            if (newTopics.length > 0) {
                // Use psubscribe for pattern matching or subscribe for exact match
                // Check if any topic contains wildcards (* or ?)
                const hasWildcards = newTopics.some(topic => topic.includes('*') || topic.includes('?'));
                
                if (hasWildcards) {
                    // Use pattern subscribe for wildcard topics
                    await subscriber.psubscribe(...newTopics);
                    console.log(`[RedisService] Pattern subscribed to topics: ${newTopics.join(', ')}`);
                } else {
                    // Use regular subscribe for exact match topics
                    await subscriber.subscribe(...newTopics);
                    console.log(`[RedisService] Subscribed to topics: ${newTopics.join(', ')}`);
                }
            } else {
                console.log('[RedisService] All topics already subscribed');
            }
        } catch (error) {
            console.error('[RedisService] Error creating listeners:', error);
            throw error;
        }
    }

    /**
     * Reload listeners - unsubscribe from old topics and subscribe to new ones
     * @param topics - Array of new topic names to subscribe to
     */
    async reloadListener(topics: string[]): Promise<void> {
        try {
            if (!this.subscriber) {
                console.log('[RedisService] No active subscriber, creating new listeners');
                if (this.messageCallback) {
                    await this.createListener(topics, this.messageCallback);
                }
                return;
            }

            // Find topics to unsubscribe (old topics not in new list)
            const topicsToUnsubscribe: string[] = [];
            for (const topic of this.subscribedTopics) {
                if (!topics.includes(topic)) {
                    topicsToUnsubscribe.push(topic);
                }
            }

            // Find topics to subscribe (new topics not in old list)
            const topicsToSubscribe: string[] = [];
            for (const topic of topics) {
                if (!this.subscribedTopics.has(topic)) {
                    topicsToSubscribe.push(topic);
                }
            }

            // Unsubscribe from old topics
            if (topicsToUnsubscribe.length > 0) {
                const hasWildcards = topicsToUnsubscribe.some(topic => topic.includes('*') || topic.includes('?'));
                
                if (hasWildcards) {
                    await this.subscriber.punsubscribe(...topicsToUnsubscribe);
                } else {
                    await this.subscriber.unsubscribe(...topicsToUnsubscribe);
                }
                
                // Remove from subscribed set
                topicsToUnsubscribe.forEach(topic => this.subscribedTopics.delete(topic));
                console.log(`[RedisService] Unsubscribed from topics: ${topicsToUnsubscribe.join(', ')}`);
            }

            // Subscribe to new topics
            if (topicsToSubscribe.length > 0) {
                const hasWildcards = topicsToSubscribe.some(topic => topic.includes('*') || topic.includes('?'));
                
                if (hasWildcards) {
                    await this.subscriber.psubscribe(...topicsToSubscribe);
                } else {
                    await this.subscriber.subscribe(...topicsToSubscribe);
                }
                
                // Add to subscribed set
                topicsToSubscribe.forEach(topic => this.subscribedTopics.add(topic));
                console.log(`[RedisService] Subscribed to new topics: ${topicsToSubscribe.join(', ')}`);
            }

            if (topicsToUnsubscribe.length === 0 && topicsToSubscribe.length === 0) {
                console.log('[RedisService] No changes needed, all topics already subscribed');
            }
        } catch (error) {
            console.error('[RedisService] Error reloading listeners:', error);
            throw error;
        }
    }

    /**
     * Unsubscribe from all topics and close subscriber
     */
    async close(): Promise<void> {
        try {
            if (this.subscriber) {
                if (this.subscribedTopics.size > 0) {
                    const topics = Array.from(this.subscribedTopics);
                    const hasWildcards = topics.some(topic => topic.includes('*') || topic.includes('?'));
                    
                    if (hasWildcards) {
                        await this.subscriber.punsubscribe(...topics);
                    } else {
                        await this.subscriber.unsubscribe(...topics);
                    }
                }
                
                await this.subscriber.quit();
                this.subscriber = null;
                this.subscribedTopics.clear();
                this.messageCallback = null;
                console.log('[RedisService] Subscriber closed');
            }
        } catch (error) {
            console.error('[RedisService] Error closing subscriber:', error);
            throw error;
        }
    }

    /**
     * Get list of currently subscribed topics
     */
    getSubscribedTopics(): string[] {
        return Array.from(this.subscribedTopics);
    }

    /**
     * Publish a message to a topic
     * @param topic - Topic name to publish to
     * @param message - Message to publish
     */
    async publish(topic: string, message: string): Promise<number> {
        try {
            return await this.redisClient.publish(topic, message);
        } catch (error) {
            console.error('[RedisService] Error publishing message:', error);
            throw error;
        }
    }
}