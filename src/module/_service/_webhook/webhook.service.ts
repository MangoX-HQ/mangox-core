// webhook http/https with method POST

interface header {
  [key: string]: string;
}

interface body {
  [key: string]: any;
}

interface webhook {
  url: string;
  // only method POST
  headers: header;
  body: body;
  timeout: number;
  waiting: boolean;
  retries: number;
  retry_delay: number;
}

export class WebhookService {

  private async callAPI(url: string, headers: header, body: body, timeout: number) {
    try {
      // using fetcj api
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        
      });
      return response;
    } catch (error) {
      console.error('Error sending webhook:', error);
      throw error;
    }
  }

  async sendWebhook(webhook: webhook){
    const { url, headers, body, timeout, waiting, retries, retry_delay } = webhook;
    try {
      if (waiting) {
        await new Promise(resolve => setTimeout(resolve, retry_delay));
      }
      const response = await this.callAPI(url, headers, body, timeout);
      return response;
    } catch (error) {
      console.error('Error sending webhook:', error);
      throw error;
    }
  }
}