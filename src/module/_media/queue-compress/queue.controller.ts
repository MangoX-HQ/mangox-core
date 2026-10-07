import { processCompressService } from './process';
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Queue Management Controller
 * Provides endpoints to monitor and manage the queue
 */
export class QueueController {

    /**
     * GET /queue/health
     * Health check endpoint cho queue system
     */
    async healthCheck(request: FastifyRequest, reply: FastifyReply) {
        try {
            const status = await processCompressService.getQueueStatus();
            
            const httpStatus = status.health.isHealthy ? 200 : 503;
            
            return reply.status(httpStatus).send({
                success: status.health.isHealthy,
                message: status.health.isHealthy 
                    ? 'Queue system is healthy' 
                    : 'Queue system is unhealthy',
                data: status,
            });
        } catch (error: any) {
            return reply.status(500).send({
                success: false,
                message: 'Failed to get queue status',
                error: error.message,
            });
        }
    }

    /**
     * GET /queue/status
     * Detailed status of all queues
     */
    async getStatus(request: FastifyRequest, reply: FastifyReply) {
        try {
            const status = await processCompressService.getQueueStatus();
            
            return reply.status(200).send({
                success: true,
                data: status,
            });
        } catch (error: any) {
            return reply.status(500).send({
                success: false,
                message: 'Failed to get queue status',
                error: error.message,
            });
        }
    }

    /**
     * GET /queue/failed
     * Get the list of failed jobs in the DLQ
     */
    async getFailedJobs(
        request: FastifyRequest<{
            Querystring: { limit?: string }
        }>,
        reply: FastifyReply
    ) {
        try {
            const limit = parseInt(request.query.limit || '10');
            const failedJobs = await processCompressService.getFailedJobs(limit);
            
            return reply.status(200).send({
                success: true,
                data: failedJobs,
            });
        } catch (error: any) {
            return reply.status(500).send({
                success: false,
                message: 'Failed to get failed jobs',
                error: error.message,
            });
        }
    }

    /**
     * POST /queue/retry/:queueType/:jobId
     * Retry a specific job from the DLQ
     */
    async retryJob(
        request: FastifyRequest<{
            Params: { queueType: 'create' | 'update' | 'delete'; jobId: string }
        }>,
        reply: FastifyReply
    ) {
        try {
            const { queueType, jobId } = request.params;
            
            if (!['create', 'update', 'delete'].includes(queueType)) {
                return reply.status(400).send({
                    success: false,
                    message: 'Invalid queue type. Must be create, update, or delete',
                });
            }

            const success = await processCompressService.retryFailedJob(queueType, jobId);
            
            if (success) {
                return reply.status(200).send({
                    success: true,
                    message: `Job ${jobId} has been retried from ${queueType} DLQ`,
                });
            } else {
                return reply.status(404).send({
                    success: false,
                    message: `Job ${jobId} not found in ${queueType} DLQ`,
                });
            }
        } catch (error: any) {
            return reply.status(500).send({
                success: false,
                message: 'Failed to retry job',
                error: error.message,
            });
        }
    }

    /**
     * POST /queue/cleanup
     * Cleanup old completed and failed jobs
     */
    async cleanupJobs(request: FastifyRequest, reply: FastifyReply) {
        try {
            await processCompressService.cleanupOldJobs();
            
            return reply.status(200).send({
                success: true,
                message: 'Old jobs cleaned up successfully',
            });
        } catch (error: any) {
            return reply.status(500).send({
                success: false,
                message: 'Failed to cleanup old jobs',
                error: error.message,
            });
        }
    }

    /**
     * GET /queue/metrics
     * Prometheus-style metrics cho queue
     */
    async getMetrics(request: FastifyRequest, reply: FastifyReply) {
        try {
            const status = await processCompressService.getQueueStatus();
            
            // Format metrics theo Prometheus format
            const metrics: string[] = [];
            
            // Main queues metrics
            Object.entries(status.mainQueues).forEach(([queueName, counts]: [string, any]) => {
                metrics.push(`queue_waiting_jobs{queue="${queueName}"} ${counts.waiting || 0}`);
                metrics.push(`queue_active_jobs{queue="${queueName}"} ${counts.active || 0}`);
                metrics.push(`queue_completed_jobs{queue="${queueName}"} ${counts.completed || 0}`);
                metrics.push(`queue_failed_jobs{queue="${queueName}"} ${counts.failed || 0}`);
                metrics.push(`queue_delayed_jobs{queue="${queueName}"} ${counts.delayed || 0}`);
            });
            
            // DLQ metrics
            Object.entries(status.deadLetterQueues).forEach(([queueName, counts]: [string, any]) => {
                metrics.push(`dlq_waiting_jobs{queue="${queueName}"} ${counts.waiting || 0}`);
                metrics.push(`dlq_active_jobs{queue="${queueName}"} ${counts.active || 0}`);
                metrics.push(`dlq_completed_jobs{queue="${queueName}"} ${counts.completed || 0}`);
                metrics.push(`dlq_failed_jobs{queue="${queueName}"} ${counts.failed || 0}`);
            });
            
            // Health metric
            metrics.push(`queue_health{} ${status.health.isHealthy ? 1 : 0}`);
            
            return reply
                .status(200)
                .header('Content-Type', 'text/plain; version=0.0.4')
                .send(metrics.join('\n'));
        } catch (error: any) {
            return reply.status(500).send({
                success: false,
                message: 'Failed to get metrics',
                error: error.message,
            });
        }
    }
}

export const queueController = new QueueController();

