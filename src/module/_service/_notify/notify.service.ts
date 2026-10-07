import { getCoreUnified, ICoreUnified } from "../../../configs/core";


export class NotifyService {
  async sendNotification(notification: any) {
    try {
      console.log('[NotifyService] 🔔 Sending notification:', JSON.stringify(notification, null, 2));

      const result = await getCoreUnified().getCore().create('notification', notification, ['admin']);

      console.log('[NotifyService] ✅ Notification created successfully:', result);
      return result;
    } catch (error) {
      console.error('[NotifyService] ❌ Error creating notification:', error);
      throw error;
    }
  }
}