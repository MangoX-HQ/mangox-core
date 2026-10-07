import WebSocket from 'ws';
import { appSettings } from '../../../configs/app-settings';
import axios from 'axios';

class MinIOWebSocket {
    private ws: WebSocket | null = null;
    private url: string;
    private token: string | null = null;
    private loginInterval: NodeJS.Timeout | null = null;

    constructor(url: string) {
        this.url = url;
    }

    private async login() {
        try {
            const response = await axios.post(`http://${appSettings.minio.endpoint}:${appSettings.minio.loginPort}/api/v1/login`, {
                'accessKey': appSettings.minio.user,
                'secretKey': appSettings.minio.password
            });

            if (!response.headers['set-cookie'] || response.headers['set-cookie'].length === 0) {
                throw new Error('Login failed: No set-cookie header');
            }
            this.token = response.headers['set-cookie'][0].split(';')[0].split('=')[1];
            this.setupAutoLogin();
        } catch (error) {
            console.log(error);
            throw new Error('Login failed');
        }
    }

    private setupAutoLogin(): void {
        if (this.loginInterval) {
            clearInterval(this.loginInterval);
        }
        this.loginInterval = setInterval(async () => {
            await this.login();
            await this.reconnect();
        }, 10 * 60 * 1000);
    }

    private async reconnect(): Promise<void> {
        this.ws?.close();
        await this.connect();
    }

    connect(): Promise<void> {
        const headers: Record<string, string> = {};
        if (this.token) {
            headers['Cookie'] = `token=${this.token}`;
        }
        if (!this.token) {
            this.login().catch(console.error);
        }
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, { headers });
            this.ws.on('open', () => resolve());
            this.ws.on('error', (err) => reject(err));
        });
    }

    async send(message: {
        "bucket_name": string,
        "mode": "objects",
        "prefix": string,
        "request_id": number
    }): Promise<any[]> {
        if(appSettings.minio.useHash) {
            // hash base64 prefix
            const hash = Buffer.from(message.prefix).toString('base64');
            message.prefix = hash;
        }
        return new Promise((resolve, reject) => {
            message.request_id = Date.now() + Math.floor(Math.random() * 1000000);
            const collectedMessages: any[] = [];
            let messageHandler: ((data: any) => void) | null = null;
            // Timeout sau 30s
            const timeout = setTimeout(() => {
                if (messageHandler) {
                    this.ws?.off('message', messageHandler);
                }
                reject(new Error('Request timeout'));
            }, 30000);

            messageHandler = (data: Buffer | string) => {
                try {
                    const parsed = typeof data === 'string' ?
                        JSON.parse(data) :
                        JSON.parse(data.toString());

                    if (parsed.request_id === message.request_id) {
                        collectedMessages.push(parsed);

                        if (parsed.request_end) {
                            clearTimeout(timeout);
                            this.ws?.off('message', messageHandler!);
                            resolve(collectedMessages);
                        }
                    }
                } catch (err) {
                    // Ignore parse errors
                }
            };

            this.ws?.on('message', messageHandler);

            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify(message));
            } else {
                clearTimeout(timeout);
                reject(new Error('WebSocket not connected'));
            }
        });
    }

    onMessage(callback: (data: any) => void): void {
        this.ws?.on('message', (data) => {
            try {
                callback(JSON.parse(data.toString()));
            } catch {
                callback(data.toString());
            }
        });
    }

    close(): void {
        if (this.loginInterval) {
            clearInterval(this.loginInterval);
            this.loginInterval = null;
        }
        this.ws?.close();
    }
}


export const minioSocket = new MinIOWebSocket(`ws://${appSettings.minio.endpoint}:${appSettings.minio.loginPort}/ws/objectManager`);