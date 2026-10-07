import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { JwtPayload } from '../types';

export class JWTNullableGuard {
  private app: FastifyInstance;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  async canActivate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try {
      const authorization = request.headers['authorization'] as string;
      
      // Unlike JWTGuard, this allows requests without authorization header
      if (!authorization) {
        return true;
      }

      const token = authorization.split(' ')[1];
      if (!token) {
        return true;
      }

      try {
        // Use Fastify JWT plugin to verify token
        const user: JwtPayload = this.app.jwt.verify(token);
        // Add user to request headers for access in controllers if token is valid
        (request.headers as any).user = user;
      } catch (error) {
        // Token is invalid but we allow the request to continue
        console.log('JWT Nullable Guard - Invalid token but allowing request:', error);
      }
      
      return true;
    } catch (error) {
      console.log('JWT Nullable Guard Error:', error);
      return true; // Always allow access even if there's an error
    }
  }

  // Decorator function for Fastify routes
  async preHandler(request: FastifyRequest, reply: FastifyReply) {
    const canAccess = await this.canActivate(request, reply);
    if (!canAccess) {
      // This should rarely happen as we almost always return true
      reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access denied'
      });
    }
  }
}
