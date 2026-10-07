import { FastifyInstance } from 'fastify';
import { AppError } from '../utils/app-error';

export const TestErrorRoute = async (fastify: FastifyInstance) => {
  // Test different HTTP error codes
  fastify.get('/test-error/:code', async (request: any, reply) => {
    const code = parseInt(request.params.code);
    
    switch (code) {
      case 400:
        throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Bad Request - Missing required fields' });
      
      case 401:
        throw new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Unauthorized - Invalid credentials' });
      
      case 403:
        throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Forbidden - Access denied' });
      
      case 404:
        throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: 'Not Found - Resource does not exist' });
      
      case 409:
        throw new AppError({ statusCode: 409, code: 'CONFLICT', message: 'Conflict - Resource already exists' });
      
      case 422:
        throw new AppError({ statusCode: 422, code: 'UNPROCESSABLE', message: 'Unprocessable Entity - Invalid data format' });
      
      case 500:
        // This will use default 500
        throw new Error('Internal server error (not HttpError)');
      
      default:
        // Custom error code
        throw new AppError({ statusCode: code, code: 'HTTP_ERROR', message: `Custom error with code ${code}` });
    }
  });

  // Test validation error
  fastify.post('/test-validation', async (request: any, reply) => {
    const { email, password } = request.body || {};
    
    if (!email) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Email is required' });
    }
    
    if (!password) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Password is required' });
    }
    
    if (password.length < 6) {
      throw new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'Password must be at least 6 characters' });
    }
    
    return {
      message: 'Validation passed',
      data: { email }
    };
  });

  // Test authentication error
  fastify.get('/test-auth', async (request: any, reply) => {
    const token = request.headers.authorization;
    
    if (!token) {
      throw new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Authorization header is missing' });
    }
    
    if (!token.startsWith('Bearer ')) {
      throw new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Invalid authorization format' });
    }
    
    // Simulate invalid token
    if (token === 'Bearer invalid-token') {
      throw new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message: 'Token is invalid or expired' });
    }
    
    return {
      message: 'Authenticated successfully'
    };
  });

  // Test not found error
  fastify.get('/test-user/:id', async (request: any, reply) => {
    const { id } = request.params;
    
    // Simulate user not found
    if (id === '999') {
      throw new AppError({ statusCode: 404, code: 'NOT_FOUND', message: `User with ID ${id} not found` });
    }
    
    return {
      message: 'User found',
      data: { id, name: 'Test User' }
    };
  });
};
