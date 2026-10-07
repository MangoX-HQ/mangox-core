import { FastifyReply, FastifyRequest } from 'fastify';
import { appSettings } from './configs/app-settings';
import { logEmitter } from './core_v2/schema/events';
import { UAParser } from "ua-parser-js";
import { METHODS } from 'http';

export function getDeviceInfo(request: FastifyRequest) {
    const parser = new UAParser(request.headers['user-agent']);
    return parser.getResult();
}

export function getClientIps(request: FastifyRequest) {
    // Public IP (if a proxy/nginx/CDN attaches an extra header)
    const ipPublic = request.headers["x-forwarded-for"]
        ?.toString()
        .split(",")[0]
        .trim();

    // LAN IP / direct socket (may be IPv6 ::ffff:192.168.1.25)
    const ipLan = request.raw.socket.remoteAddress?.replace(/^::ffff:/, "");

    return {
        ipPublic: ipPublic || "unknown",
        ipLan: ipLan || "unknown",
    };
}

export function responseInterceptor(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: any,
    done: (err: Error | null, payload?: any) => void
) {
    reply.header('accept-encoding', 'gzip, deflate, br, zstd');
    try {
        console.log('Original Payload:', payload);
        // Check if response has already been sent
        if (reply.sent) {
            return done(null, payload);
        }

        // ✅ Skip cho buffer responses (file downloads)
        if (Buffer.isBuffer(payload)) {
            return done(null, payload);
        }

        // Skip for certain methods
        if (request.method === 'OPTIONS' || request.method === 'HEAD') {
            return done(null, payload);
        }

        // Skip for static files, uploads, Swagger spec, MCP, and OAuth/well-known endpoints
        const url = request.url;
        if (
            url.includes('/uploads/') ||
            url.includes('/static/') ||
            url.includes('/docs/json') ||
            /(^|\/)mcp(\?|$)/.test(url) ||
            url.startsWith('/oauth/') ||
            url.startsWith('/.well-known/') ||
            url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)
        ) {
            return done(null, payload);
        }

        // Check if reply and reply.statusCode exist
        if (!reply || typeof reply.statusCode === 'undefined') {
            return done(null, payload);
        }
        // const featured_image = (item: any) => {
        //     if (!item) return [];

        //     const buildPath = (file: any) => {
        //       if (!file || typeof file !== "object") return null;

        //       return {
        //         ...file,
        //         path: `${appSettings.minio.public}/${appSettings.minio.bucketName}/${file.filename ?? "unknown"}`
        //       };
        //     };

        //     const items = Array.isArray(item) ? item : [item];
        //     return items?.map(buildPath).filter(Boolean);
        //   };



        // Check if payload is JSON before parsing
        let parsedPayload;
        if (typeof payload === 'string') {
            try {
                // Only attempt to parse if it looks like JSON (starts with { or [)
                if (payload.trim().startsWith('{') || payload.trim().startsWith('[')) {
                    parsedPayload = JSON.parse(payload);
                } else {
                    // For non-JSON content (like HTML), return original payload
                    return done(null, payload);
                }
            } catch (parseError) {
                // If JSON parsing fails, return original payload
                return done(null, payload);
            }
        } else {
            parsedPayload = payload;
        }
        // if (Array.isArray(parsedPayload.data) && request.method === "GET") {

        //     parsedPayload.data = (parsedPayload.data)?.map((item: any) => {
        //         if (item['featured_image']) {
        //             item['featured_image'] = featured_image(item['featured_image'])
        //         }
        //         return item
        //     })
        // }
        // else {
        //     if (parsedPayload.data?.['featured_image']) {
        //         parsedPayload.data['featured_image'] = featured_image(parsedPayload.data['featured_image'])
        //     }

        // }
        // Skip if already processed or is an error response
        if (parsedPayload?.is_err) {
            // Remove is_err flag and return error format
            delete parsedPayload.is_err;
            return done(null, JSON.stringify(parsedPayload));
        }

        // Wrap successful response


        // Wrap successful response
        const wrapped = {
            message: parsedPayload?.data?.error || parsedPayload?.error || parsedPayload?.message || (reply.statusCode === 200 || reply.statusCode === 201 ? 'Success' : reply.statusCode === 400 ? 'Bad Request' : reply.statusCode === 401 ? 'Unauthorized' : reply.statusCode === 403 ? 'Forbidden' : reply.statusCode === 404 ? 'Not Found' : reply.statusCode === 500 ? 'Internal Server Error' : 'Not Specified') || 'Success',
            statusCode: parsedPayload?.statusCode || reply.statusCode,
            data: parsedPayload?.data ?? parsedPayload,
            meta: parsedPayload?.pagination ?? ""
        };

        const { entityName, id } = request.params as {
            entityName: string
            id: string
        }
        const device = getDeviceInfo(request)
        const ips = getClientIps(request)
        if (request.method != "GET" && (wrapped.statusCode == 200 || wrapped.statusCode == 201 || wrapped.statusCode == 204)) {


            logEmitter.emit("writeLog", {
                requestId: (request as any).requestId,
                method: request.method,
                user: (request.headers.user ?? (request as any).user) ? (request.headers.user ?? (request as any).user).id : undefined,
                url: request.url,
                domain: request.headers.host,
                ip_public: ips.ipPublic,
                ip_lan: ips.ipLan,
                user_agent: request.headers['user-agent'],
                tenant_id: ((request as any).tenantId as string) || (request.headers['x-tenant-id'] as string) || "",
                device: {
                    browser: device.browser,
                    cpu: device.cpu,
                    device: device.device,
                    engine: device.engine,
                    os: device.os,
                    ua: device.ua
                },
                entityName: entityName ?? (request.url.match(/api\/v1\/([^/]+)/)?.[1] ?? undefined),
                timestamp: new Date(appSettings.timeZoneMongoDB.getCurrentTime()),
                // Universal discriminator from saved record (auto-tagged by core-service);
                // falls back to legacy post_type for old records.
                collection_name: wrapped?.data?.[0]?.collection_name
                  ?? wrapped?.data?.collection_name
                  ?? wrapped?.data?.[0]?.post_type
                  ?? wrapped?.data?.post_type
                  ?? undefined,
            })
        }

                console.log('Original wrapped:', wrapped);

        try {
            done(null, JSON.stringify(wrapped));
        } catch (error: any) {
            done(null, payload);
        }

    } catch (error: any) {
        console.error('Error in response interceptor:', error);
        // Return original payload on error to prevent further issues
        done(null, payload);
    }
}