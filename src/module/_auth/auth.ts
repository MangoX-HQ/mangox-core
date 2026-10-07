import { FastifyInstance } from 'fastify';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { JWTGuard } from './guards/jwt.guard';
import { JWTNullableGuard } from './guards/jwt-nullable.guard';
import { AdminGuard } from './guards/admin.guard';
import { PermissionGuard } from './guards/permission.guard';



export async function AuthRoutes(app: FastifyInstance) {
  // Create service instances
  const authService = new AuthService();
  const otpService = new OtpService();

  // Create guard instances
  const jwtGuard = new JWTGuard(app);
  const jwtNullableGuard = new JWTNullableGuard(app);
  const adminGuard = new AdminGuard(app);
  const permissionGuard = new PermissionGuard(app, authService);

  // Create controller instance
  const authController = new AuthController({
    authService: authService,
    otpService: otpService,
    jwtGuard: jwtGuard,
    fastifyInstance: app
  });

  // Register routes
  await authController.register(app);

  // Return instances for use in other modules
  return {
    authService,
    jwtGuard,
    jwtNullableGuard,
    adminGuard,
    permissionGuard,
    authController
  };
}

// Export types and interfaces
export type { JwtPayload, UserProfile, LoginResponse, TokenResponse, RegisterResponse } from './types';

// Export individual classes for direct import
export { AuthService } from './auth.service';
export { AuthController } from './auth.controller';

// Export guards
export { JWTGuard } from './guards/jwt.guard';
export { JWTNullableGuard } from './guards/jwt-nullable.guard';
export { AdminGuard } from './guards/admin.guard';
export { PermissionGuard } from './guards/permission.guard';

// Export DTOs
export { AuthRequestDto, AuthRequestValidation } from './dto/request.dto';
export { AuthResponseDto, AuthResponseHelper } from './dto/response.dto';

// Export constants
export {
  TEAM_ROLE,
  MODULE_VERSION,
  isSystemAdmin,
  isSystemManager,
  isSuperAdmin,
  isTeamAdmin,
  isTeamManager,
} from './types';
export type { UserTeamMembership } from './types';
