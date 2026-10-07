import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { JwtPayload } from '../types';
import { AuthService } from '../auth.service';

export class PermissionGuard {
  private app: FastifyInstance;
  private authService: AuthService;

  constructor(app: FastifyInstance, authService: AuthService) {
    this.app = app;
    this.authService = authService;
  }

  async canActivate(request: FastifyRequest, reply: FastifyReply, requiredPermissions?: string[]): Promise<boolean> {
    try {
      const authorization = request.headers['authorization'] as string;
      if (!authorization) {
        return false;
      }

      const token = authorization.split(' ')[1];
      if (!token) {
        return false;
      }

      // Use Fastify JWT plugin to verify token
      const user: JwtPayload = this.app.jwt.verify(token);
      
      // Get user profile with permissions
      const userProfile = await this.authService.getProfile(user.email);
      
      // If no specific permissions required, just check if user is authenticated
      if (!requiredPermissions || requiredPermissions.length === 0) {
        (request.headers as any).user = user;
        return true;
      }

      // Check if user has required permissions
      const hasPermission = this.checkUserPermissions(userProfile, requiredPermissions);
      
      if (!hasPermission) {
        return false;
      }
      
      // Add user to request headers for access in controllers
      (request.headers as any).user = user;
      
      return true;
    } catch (error) {
      console.log('Permission Guard Error:', error);
      return false;
    }
  }

  private checkUserPermissions(userProfile: any, requiredPermissions: string[]): boolean {
    // Implement your permission checking logic here
    // This is a basic implementation - you may need to customize based on your permission structure
    
    if (!userProfile.role || !Array.isArray(userProfile.role)) {
      return false;
    }

    for (const roleData of userProfile.role) {
      if (!roleData.permission || !Array.isArray(roleData.permission)) {
        continue;
      }

      for (const permission of roleData.permission) {
        if (!permission.filter || !Array.isArray(permission.filter)) {
          continue;
        }

        // Check if any required permission is present in user's permissions
        const hasRequiredPermission = requiredPermissions.some(reqPerm => 
          permission.filter.includes(reqPerm)
        );

        if (hasRequiredPermission) {
          return true;
        }
      }
    }

    return false;
  }

  // Decorator function for Fastify routes with specific permissions
  createPreHandler(requiredPermissions?: string[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const canAccess = await this.canActivate(request, reply, requiredPermissions);
      if (!canAccess) {
        reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Insufficient permissions'
        });
      }
    };
  }

  // Default preHandler without specific permissions
  async preHandler(request: FastifyRequest, reply: FastifyReply) {
    const canAccess = await this.canActivate(request, reply);
    if (!canAccess) {
      reply.code(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Permission denied'
      });
    }
  }
}
