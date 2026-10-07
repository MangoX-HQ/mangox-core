/**
 * Swagger Customizer
 * This file lets you customize the swagger spec before exporting it.
 * You can modify anything in the swagger spec here.
 */

import { schema, schemaManager } from "../core_v2/compat";

export const customizeSwaggerSpec = async (swaggerSpec: any) => {
    // ==================== BASIC INFO ====================
    // Custom title, description, version
    swaggerSpec.info = {
        ...swaggerSpec.info,
        title: 'Capstone - API - Documentation',
        description: 'API for user interface development',
        version: '1.1',
        contact: {
            name: 'mangox API Support',
            email: 'support@mangox.com'
        },
        license: {
            name: 'MIT',
            url: 'https://opensource.org/licenses/MIT'
        }
    };

    // ==================== SERVERS ====================
    swaggerSpec.servers = [
        { url: 'https://mangox-api.mangoads.com.vn', description: 'Development Server' },
                { url: 'http://localhost:5555', description: 'Development Server' },

    ];
    

    // ==================== TAGS ====================
    if (!swaggerSpec.tags) {
        swaggerSpec.tags = [];
    }

    // Add custom tags
    const customTags = [
        {
            name: 'Authentication',
            description: 'User authentication and authorization'
        },
        {
            name: 'Users',
            description: 'User management operations'
        },
        {
            name: 'Media',
            description: 'File upload and media management'
        },
        {
            name: 'Entities',
            description: 'Dynamic entity operations'
        },
        {
            name: 'Common',
            description: 'Common entity operations - Includes all auto-generated APIs from /{entityName} routes'
        },
        {
            name: 'Front',
            description: 'Front api public api'
        },
    ];

    swaggerSpec.tags.push(...customTags);

    // Add tags for each entity after schemas have been loaded
    // (will be updated after routes are generated)

    // ==================== EXTERNAL DOCS ====================
    swaggerSpec.externalDocs = {
        description: 'Find more info here',
        url: 'https://mangox.thaily.id.vn/docs'
    };

    // ==================== GLOBAL SECURITY (Optional) ====================
    // Add global security so Swagger UI sends the token if available
    // But not required (empty array means optional)
    if (!swaggerSpec.security) {
        swaggerSpec.security = [
            {}, // Empty object = no security required
            { bearerAuth: [] } // OR Bearer auth (optional)
        ];
    }

    // ==================== DYNAMIC ENTITY SCHEMAS ====================
    // Add schemas from entities defined in the system FIRST
    const entityNames: string[] = [];
    for (const entity of Object.entries(await schemaManager.getAllEntities())) {
        if (entity && entity[1] && (entity[1] as any)["json_schema"]) {
            // console.log(`Adding schema for entity: ${entity[0]}`);
            swaggerSpec.components.schemas[entity[0]] = (entity[1] as any)["json_schema"];
            entityNames.push(entity[0]);
        }
    }

    // ==================== GENERATE STATIC ROUTES ====================
    // Generate static routes for each entity from the dynamic route template
    const dynamicRoutesTemplate = [
        '/api/v1/{entityName}',
        '/api/v1/{entityName}/{id}',
        '/api/v1/{entityName}/many'
    ];
    const excludeList = ['user', 'media-minio', 'entity', 'front', 'test-error', 'test-validation', 'test-auth', 'test-user', 'rebuild-compress', 'media'];
    for (const entityName of entityNames) {
        if (!excludeList.includes(entityName)) {
            for (const template of dynamicRoutesTemplate) {
                const staticPath = template.replace('{entityName}', entityName);

                // Copy the structure from the dynamic route
                const dynamicPath = swaggerSpec.paths[template];
                if (dynamicPath) {
                    swaggerSpec.paths[staticPath] = JSON.parse(JSON.stringify(dynamicPath));

                    // Update each operation in the static path
                    Object.keys(swaggerSpec.paths[staticPath]).forEach(method => {
                        const operation = swaggerSpec.paths[staticPath][method];

                        // Update operationId
                        operation.operationId = `${method}_${staticPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
                        operation.tags = [`Common / ${entityName}`];


                        // Update tags - use naming convention to group

                        // Update description
                        operation.description = `${method.toUpperCase()} operation for ${entityName} entity`;

                        // Set optional security for entity routes (same as Common)
                        // User can send a token or not, either is fine
                        operation.security = [
                            {}, // No auth required
                            { bearerAuth: [] } // OR with Bearer auth
                        ];

                        // Update requestBody for POST/PUT/PATCH with a specific schema
                        if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
                            operation.requestBody = {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: `#/components/schemas/${entityName}`
                                        }
                                    }
                                }
                            };
                        }

                        // Remove the entityName parameter since this is now a static route
                        if (operation.parameters) {
                            operation.parameters = operation.parameters.filter(
                                (param: any) => param.name !== 'entityName'
                            );
                        }

                        // Add x-tenant-id header for generated routes
                        if (!operation.parameters) {
                            operation.parameters = [];
                        }

                        const hasTenantHeader = operation.parameters.some((param: any) =>
                            param.name === 'x-tenant-id' && param.in === 'header'
                        );

                        if (!hasTenantHeader) {
                            operation.parameters.push({
                                name: 'x-tenant-id',
                                in: 'header',
                                required: true,
                                schema: {
                                    type: 'string',
                                    default: '68a6a4a4e731734fad2cff97'
                                },
                                description: 'Tenant ID for multi-tenant support'
                            });
                        }

                        // console.log(`Generated route: ${method.toUpperCase()} ${staticPath}`);
                    });
                }
            }
        }

    }

    // ==================== ENTITY TAGS ====================
    // Add tags with a prefix to group entities
    // for (const entityName of entityNames) {
    //     swaggerSpec.tags.push({
    //         name: `Common / ${entityName}`,
    //         description: `${entityName} entity operations (auto-generated from /{entityName})`
    //     });
    // }

    // ==================== PATHS CUSTOMIZATION ====================
    Object.keys(swaggerSpec.paths).forEach(path => {
        Object.keys(swaggerSpec.paths[path]).forEach(method => {
            const operation = swaggerSpec.paths[path][method];

            // Add operationId if not already present
            if (!operation.operationId) {
                operation.operationId = `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
            }

            // Custom response descriptions if it's "Default Response"
            if (operation.responses) {
                Object.keys(operation.responses).forEach(statusCode => {
                    if (operation.responses[statusCode].description === 'Default Response') {
                        operation.responses[statusCode].description = getResponseDescription(statusCode);
                    }
                });
            }
            // Only set tags if not already set
            if (!operation.tags || operation.tags.length === 0) {
                operation.tags = [getTagFromPath(path)];
            }
            // // Add tags based on path
            // if (!operation.tags || operation.tags.length === 0) {

            // }

            // Custom security for endpoints that need authentication
            // Common APIs may or may not have a token (optional)
            if (operation.tags && operation.tags.includes('Common')) {
                // Set security as optional - with or without is fine
                operation.security = [
                    {}, // No auth required
                    { bearerAuth: [] } // OR with Bearer auth
                ];
            } else if (needsAuthentication(path, method)) {
                operation.security = [{ bearerAuth: [] }];
            }

            // Add x-tenant-id header for all requests
            if (!operation.parameters) {
                operation.parameters = [];
            }

            // Check whether the x-tenant-id header already exists
            const hasTenantHeader = operation.parameters.some((param: any) =>
                param.name === 'x-tenant-id' && param.in === 'header'
            );

            if (!hasTenantHeader) {
                operation.parameters.push({
                    name: 'x-tenant-id',
                    in: 'header',
                    required: true,
                    schema: {
                        type: 'string',
                        default: '68a6a4a4e731734fad2cff97'
                    },
                    description: 'Tenant ID for multi-tenant support'
                });
            }
        });
    });
    // ==================== CUSTOM COMPONENTS ====================
    if (!swaggerSpec.components.schemas) {
        swaggerSpec.components.schemas = {};
    }

    // Add common schemas
    swaggerSpec.components.schemas.ErrorResponse = {
        type: 'object',
        properties: {
            statusCode: { type: 'number' },
            error: { type: 'string' },
            message: { type: 'string' }
        }
    };

    swaggerSpec.components.schemas.SuccessResponse = {
        type: 'object',
        properties: {
            statusCode: { type: 'number' },
            message: { type: 'string' },
            data: { type: 'object' }
        }
    };

    return swaggerSpec;
};

// ==================== HELPER FUNCTIONS ====================

function getResponseDescription(statusCode: string): string {
    const descriptions: { [key: string]: string } = {
        '200': 'Success',
        '201': 'Created successfully',
        '400': 'Bad request',
        '401': 'Unauthorized',
        '403': 'Forbidden',
        '404': 'Not found',
        '500': 'Internal server error'
    };
    return descriptions[statusCode] || `Response ${statusCode}`;
}

function getTagFromPath(path: string): string {

    if (path.includes('/auth')) return 'Authentication';
    if (path.includes('/user')) return 'Users';
    if (path.includes('/media')) return 'Media';
    if (path.includes('/front')) return 'Front';
    if (path.includes('/entity')) return 'Entities';
    const entityName = extractEntityNameFromPath(path);
    // console.log(entityName)
    if (entityName) {
        // console.log(entityName)
        if (entityName == 'user') return 'Users'
        if (entityName == 'media') return 'Media'
        if (entityName == 'entity') return 'Entities'
        if (entityName == 'media-minio') return 'Media'
    }
    // Check whether this is an entity-specific route

    return 'Common';
}

function needsAuthentication(path: string, method: string): boolean {
    // Define the endpoints that need authentication
    const protectedPaths = [
        '/api/v1/auth/me',
        '/api/v1/auth/change-tenant',
        '/api/v1/user',
        '/api/v1/media-minio'
    ];

    // Methods that need auth (except public GET and front endpoints)
    const protectedMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];

    // Common APIs don't require auth (optional)
    // Already handled separately in the logic above

    return protectedPaths.some(p => path.includes(p)) ||
        (protectedMethods.includes(method.toUpperCase()) && !path.includes('/front/'));
}

function extractEntityNameFromPath(path: string): string | null {
    // Extract the entity name from the path
    // Example: /api/v1/{entityName} -> entityName parameter
    // Or /api/v1/page-ai -> page-ai

    // Pattern 1: /api/v1/{entityName} (dynamic route)
    // console.log(path)

    // Pattern 2: /api/v1/specific-entity (static route)
    const staticMatch = path.match(/\/api\/v1\/([^\/\{\}]+)(?:\/|$)/);
    if (staticMatch) {
        const entityName = staticMatch[1];
        // Remove endpoints that aren't entities
        const excludeList = ['user', 'media-minio', 'entity', 'front', 'test-error', 'test-validation', 'test-auth', 'test-user', 'rebuild-compress'];

        if (!excludeList.includes(entityName)) {
            return entityName;
        }
    }
    const dynamicMatch = path.match(/\/api\/v1\/\{entityName\}/);

    if (dynamicMatch) {
        // Return the common entity name, or from the query parameter if present
        // Temporarily return null since the specific entity is unknown
        return null;
    }

    return null;
}