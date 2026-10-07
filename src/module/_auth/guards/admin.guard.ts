import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { JwtPayload, isSystemAdmin } from '../types';

export class AdminGuard {
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

      // Use Fastify JWT plugin to verify token
      const user: JwtPayload = this.app.jwt.verify(token);
      
      // Check if user has admin role (super-admin: claim is_super_admin or legacy role_system=admin)
      if (!user.is_super_admin && !isSystemAdmin(user.role_system)) {
        return false;
      }
      
      // Add user to request headers for access in controllers
      (request.headers as any).user = user;
      
      return true;
    } catch (error) {
      console.log('Admin Guard Error:', error);
      return false;
    }
  }

  // Decorator function for Fastify routes
  async preHandler(request: FastifyRequest, reply: FastifyReply) {
    const canAccess = await this.canActivate(request, reply);
    if (!canAccess) {
      reply.code(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Admin access required'
      });
    }
  }
}
