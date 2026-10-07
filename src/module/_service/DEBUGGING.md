# BullMQ Worker Debugging Guide

## Vấn đề: Worker không hoạt động

Khi bạn thấy log:
```
[ServiceManager] ✅ Job added to queue notifyQueue
[ServiceManager] 🔔 Processing notify job id: 1
```

Nhưng **không thấy log tiếp theo** hoặc job không được xử lý, có thể do các nguyên nhân sau:

## ✅ Đã sửa các vấn đề sau:

### 1. **Worker instances bị garbage collected**

**Vấn đề:**
```typescript
// ❌ SAI - Worker không được lưu lại
new Worker('notifyQueue', async job => {
  // process job
});
```

Worker được tạo nhưng không gán vào biến nào, có thể bị garbage collector thu hồi.

**Giải pháp:**
```typescript
// ✅ ĐÚNG - Lưu worker vào property
private workers: Record<string, Worker> = {};

this.workers['notifyQueue'] = new Worker('notifyQueue', async job => {
  // process job
});
```

### 2. **Thiếu error handlers cho Worker**

**Vấn đề:**
Worker gặp lỗi nhưng không log ra, khó debug.

**Giải pháp:**
```typescript
// Add error event listeners
this.workers['notifyQueue'].on('completed', job => {
  console.log(`Worker completed job ${job.id}`);
});

this.workers['notifyQueue'].on('failed', (job, err) => {
  console.error(`Worker failed job ${job?.id}:`, err);
});

this.workers['notifyQueue'].on('error', err => {
  console.error('Worker error:', err);
});
```

### 3. **Service không throw error khi fail**

**Vấn đề trong NotifyService:**
```typescript
// ❌ SAI - Không có error handling
async sendNotification(notification: any) {
  await coreGlobal.getCore().create('notification', notification, ['admin']);
}
```

Nếu `create()` fail, error bị nuốt và worker nghĩ job đã thành công.

**Giải pháp:**
```typescript
// ✅ ĐÚNG - Có error handling và logging
async sendNotification(notification: any) {
  try {
    console.log('[NotifyService] 🔔 Sending notification:', JSON.stringify(notification, null, 2));
    const result = await coreGlobal.getCore().create('notification', notification, ['admin']);
    console.log('[NotifyService] ✅ Notification created successfully:', result);
    return result;
  } catch (error) {
    console.error('[NotifyService] ❌ Error creating notification:', error);
    throw error; // ← QUAN TRỌNG: phải throw để worker biết job failed
  }
}
```

### 4. **Thiếu cleanup khi close**

**Vấn đề:**
Workers và queues không được đóng đúng cách khi app shutdown.

**Giải pháp:**
```typescript
async close(): Promise<void> {
  // Close all workers
  for (const [name, worker] of Object.entries(this.workers)) {
    await worker.close();
  }
  this.workers = {};

  // Close all queues
  for (const [name, queue] of Object.entries(this.queue)) {
    await queue.close();
  }
  this.queue = {};

  // Close Redis
  await this.redisService.close();
}
```

## 🔍 Cách debug Worker

### 1. Kiểm tra Worker đã start chưa

```bash
# Xem log khi khởi động
[ServiceManager] ✅ Notify Queue initialized
[ServiceManager] ✅ Notify Worker started  # ← Phải có dòng này
```

### 2. Kiểm tra job có được add vào queue không

```bash
[ServiceManager] ✅ Job added to queue notifyQueue
```

### 3. Kiểm tra Worker có nhận job không

```bash
[ServiceManager] 🔔 Processing notify job id: 1
[ServiceManager] 🔔 Notify job data: { ... }  # ← Kiểm tra data
```

### 4. Kiểm tra Service có xử lý không

```bash
[NotifyService] 🔔 Sending notification: { ... }
[NotifyService] ✅ Notification created successfully
```

### 5. Kiểm tra job completed

```bash
[ServiceManager] ✅ Notify job id: 1 completed
[ServiceManager] ✅ Notify worker completed job 1
```

## 🐛 Common Issues

### Issue: Worker nhận job nhưng không xử lý

**Nguyên nhân:**
- Service throw error nhưng không được catch
- Async/await không đúng
- Connection to database/external service failed

**Debug:**
1. Check log từ Service (`[NotifyService]`)
2. Check worker failed event
3. Kiểm tra kết nối database/Redis

### Issue: Worker không nhận job

**Nguyên nhân:**
- Worker chưa start
- Redis connection settings sai
- Queue name không khớp
- Worker bị garbage collected

**Debug:**
1. Kiểm tra log `Worker started`
2. Kiểm tra Redis connection config
3. Kiểm tra worker có được lưu vào `this.workers`

### Issue: Job bị stuck

**Nguyên nhân:**
- Worker crash mà không throw error
- Infinite loop trong job processor
- Deadlock

**Debug:**
1. Check BullMQ dashboard/UI
2. Kiểm tra failed jobs: `await queue.getFailed()`
3. Check job timeout settings

## 📊 Monitor Workers

### Using BullMQ Board (optional)

```typescript
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';

const serverAdapter = new FastifyAdapter();
createBullBoard({
  queues: [
    new BullMQAdapter(this.queue['mailQueue']),
    new BullMQAdapter(this.queue['notifyQueue']),
    new BullMQAdapter(this.queue['webhookQueue']),
  ],
  serverAdapter,
});

// Access at: http://localhost:3000/admin/queues
```

### Manual monitoring

```typescript
// Get queue stats
const counts = await queue.getJobCounts('wait', 'active', 'completed', 'failed');
console.log('Queue stats:', counts);

// Get failed jobs
const failed = await queue.getFailed();
failed.forEach(job => {
  console.log(`Failed job ${job.id}:`, job.failedReason);
});
```

## 🎯 Best Practices

1. **Luôn throw error trong service** để worker biết job failed
2. **Add error handlers** cho tất cả workers
3. **Log đầy đủ** để dễ debug (job data, errors, completion)
4. **Lưu worker instances** vào class properties
5. **Cleanup đúng cách** khi close application
6. **Monitor queues** trong production
7. **Set timeout** cho jobs để tránh stuck
8. **Retry strategy** cho failed jobs

## 📝 Testing Workers

```typescript
// Test add job
await serviceManager.addJobToQueue('notifyQueue', {
  title: 'Test Notification',
  message: 'Hello World',
  type: 'info',
  user_id: 'test-user-id'
});

// Wait and check logs
// Should see:
// 1. Job added
// 2. Worker processing
// 3. Service sending
// 4. Job completed
```
