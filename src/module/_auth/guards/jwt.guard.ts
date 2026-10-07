import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { JwtPayload, ROLE_SYSTEM, isSystemAdmin } from '../types';
import { schema, schemaManager } from '../../../core_v2/compat';
import { getCoreUnified, ICoreUnified } from '../../../configs/core';
import { verifyToken, tenantMatches } from '../../../configs/jwt-verify';
import { isUserRevoked, isTokenBlacklisted } from '../token-blacklist.service';

/**
 * Helper to get core global instance
 */

export class JWTGuard {
  private app: FastifyInstance;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  async canActivate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try {
      const authorization = request.headers['authorization'] as string;
      if (!authorization) {
        return false;
      }

      const token = authorization.split(' ')[1];
      if (!token) {
        return false;
      }

      // Verify token: RS256 (SSO public key) or HS256 (JWT_SECRET) — auto-detected.
      const user: JwtPayload = verifyToken(token) as any;

      // Tier 1 — is this token directly blacklisted (current device logout)?
      if (await isTokenBlacklisted(token)) {
        return false; // → 401
      }
      // Tier 2 — revoke-all: tokens issued BEFORE the user's revoke timestamp (password change/reset, admin ban)
      // are revoked immediately even if still unexpired. Compares iat < revokedAt. Fail-open if Redis errors.
      if (await isUserRevoked((user as any).id, (user as any).iat)) {
        return false; // → 401
      }

      // Single-tenant isolation: tokens from a different tenant → rejected (admin bypasses this).
      if (!isSystemAdmin(user.role_system) && !tenantMatches(user as any)) {
        console.warn(`[JWTGuard] token tenant_id='${(user as any).tenant_id}' ≠ env TENANT → deny`);
        return false;
      }

      // Single-tenant + SSO: team/tenant role resolution has been removed.
      //   role_system='admin' (legacy 'super_admin') → role_name='admin'
      //   otherwise → role_name stays as-is from the JWT (SSO carries the role)
      if (isSystemAdmin(user.role_system)) {
        user.role_name = ROLE_SYSTEM.ADMIN;
      }

      // Add user to request headers for access in controllers
      (request.headers as any).user = user;

      // get entity for user
      const { entityName } = request.params as {
        entityName: string
      };
      const entityRole: any[] = [];
      // here using casbin to get role for user
      if (entityName) {
        const entity = await schemaManager.getEntity(entityName);
        if (entity) {
          const mongorest = entity['mongorest'];
          if (mongorest) {
            const partss = mongorest.split(';');
            for (const parts of partss) {
              const part = parts.split(':');
              if (part.length != 3 && part.length != 4) {
                continue;
              }
              const entity = part[0];
              const mongorest = part[1];
              const role = part[2];
              const property = part[3] || 0;
              const query = new URLSearchParams(mongorest) as any;
              const data = await getCoreUnified().getCore().findAll(query, entity, ["admin"], {
                databaseType: "mongodb",
              });
              if (data.data && data.data.length > 0){
                entityRole.push({
                  role,
                  property,
                });
              }
            }
          }
        }
      }

      
      entityRole.sort((a, b) => a.property - b.property);
      if (entityRole.length > 0 && entityRole[0].role) {
        (request.headers as any).user.role_name = entityRole[0].role;
      }
      return true;  
    } catch (error) {
      console.log('JWT Guard Error:', error);
      return false;
    }
  }

  // Decorator function for Fastify routes
  async preHandler(request: FastifyRequest, reply: FastifyReply) {
    const canAccess = await this.canActivate(request, reply);
    if (!canAccess) {
      reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token is required'
      });
    }
  }
}


