import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { JWTGuard } from './guards/jwt.guard';
import { AuthRequestDto, AuthRequestValidation } from './dto/request.dto';
import { AuthResponseDto, AuthResponseHelper } from './dto/response.dto';
import { MODULE_VERSION } from './types';
import { AppError } from '../../utils/app-error';
import { blacklistToken } from './token-blacklist.service';

export interface AuthControllerDependencies {
  authService: AuthService;
  otpService: OtpService;
  jwtGuard: JWTGuard;
  fastifyInstance: FastifyInstance;
}

export class AuthController {
  private authService: AuthService;
  private otpService: OtpService;
  private jwtGuard: JWTGuard;
  private app: FastifyInstance;

  constructor(dependencies: AuthControllerDependencies) {
    this.authService = dependencies.authService;
    this.otpService = dependencies.otpService;
    this.jwtGuard = dependencies.jwtGuard;
    this.app = dependencies.fastifyInstance;
  }

  /**
   * Mint a new access token from a user — used for auto-login after a password change/reset
   * (revoke-all just killed the current token). Payload mirrors /auth/login so the new token has the same shape.
   */
  private signAccessToken(user: any): string {
    const isSuper = !!user.is_super_admin
      || user.role_system === 'admin'
      || user.role_system === 'super_admin';
    const userId = user._id?.toString() || user.id;
    return this.app.jwt.sign({
      sub: userId,
      id: userId,
      email: user.email,
      username: user.username,
      phone: user.phone,
      role_system: isSuper ? 'admin' : (user.role_system || 'user'),
      role_name: isSuper ? 'super_admin' : (user.role_name || 'user'),
      is_super_admin: isSuper,
    });
  }

  async register(app: FastifyInstance) {

    // Login route - Hybrid approach (Passport or Manual)
    app.post('/auth/login', {
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          if ((this.app as any).authenticateUser) {
            // Use Hybrid Auth Plugin
            await (this.app as any).authenticateUser(request, reply);
          } else {
            // Basic manual fallback
            const body = request.body as { email?: string; password?: string };
            
            if (!body.email || !body.password) {
              throw new Error('Email and password are required');
            }

            const user = await this.authService.validateCredentials(body.email, body.password);
            
            if (!user) {
              throw new Error('Invalid email or password');
            }

            request.user = user;
          }
        } catch (error: any) {
          return reply.code(401).send(
            AuthResponseHelper.error(error.message || 'Authentication failed', 401, 'Unauthorized')
          );
        }
      },
      schema: {
        body: AuthRequestDto.LoginSchema.body,
        querystring: {
          type: 'object',
          properties: {
            profile: { type: 'boolean', default: true }
          }
        },
        response: {
          200: AuthResponseDto.LoginResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'User login'
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user as any;

        if (!user) {
          return reply.code(401).send(
            AuthResponseHelper.error('Authentication failed', 401, 'Unauthorized')
          );
        }

        const isSuper = !!user.is_super_admin
          || user.role_system === 'admin'
          || user.role_system === 'super_admin';

        // Standard payload for tenant runtime: uses both `sub` and `id`. role_system
        // derived from is_super_admin so tenant runtime bypasses the cross-tenant guard.
        const userId = user._id?.toString() || user.id;
        const accessToken = this.app.jwt.sign({
          sub: userId,
          id: userId,
          email: user.email,
          username: user.username,
          phone: user.phone,
          // role_system='admin' only when is_super_admin → avoids team admin
          // (role_name='admin' tenant scope) being mistaken for system admin.
          role_system: isSuper ? 'admin' : (user.role_system || 'user'),
          role_name: isSuper ? 'super_admin' : (user.role_name || 'user'),
          is_super_admin: isSuper,
        });

        // Generate refresh token
        const jwtSign = this.app.jwt.sign.bind(this.app.jwt);
        const refreshToken = await this.authService.createRefreshToken(user, jwtSign);

        // Tenants & permissions are split into separate endpoints (GET /tenant, /auth/permissions)
        const result = {
          accessToken: accessToken,
          refreshToken: refreshToken,
          user: {
            ...user,
            id: user._id?.toString() || user.id || 'unknown',
            is_super_admin: isSuper,
            password: undefined,
            tenant: undefined,
            permissions: undefined,
          },
        };
        
        return reply.code(200).send(
          AuthResponseHelper.success(result)
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    
    // Google login route
    app.post('/auth/google', {
      schema: {
        body: {
          type: 'object',
          required: ['credential'],
          properties: {
            credential: { type: 'string' },
            tenant_id: { type: 'string', description: 'Optional — auto-join nếu tenant.type=public' },
            default_role: { type: 'string', description: 'Optional — role assign (default: customer)' },
          },
        },
        response: {
          200: AuthResponseDto.LoginResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema,
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Login with Google (optional auto-join public tenant)',
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as { credential: string; tenant_id?: string; default_role?: string };
        if (!body.credential) {
          return reply.code(400).send(
            AuthResponseHelper.error('Google credential is required', 400, 'Bad Request')
          );
        }
        const jwtSign = this.app.jwt.sign.bind(this.app.jwt);
        // Single-tenant: does NOT pass { tenantId, defaultRole } like Studio —
        // tenant is fixed by env, no auto-joining another tenant.
        const result = await this.authService.googleLogin(
          body.credential,
          true,
          jwtSign,
        );
        return reply.code(200).send(AuthResponseHelper.success(result));
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // GitHub login route
    app.post('/auth/github', {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string' } },
        },
        response: {
          200: AuthResponseDto.LoginResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema,
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Login with GitHub',
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { code } = request.body as { code: string };
        if (!code) {
          return reply.code(400).send(
            AuthResponseHelper.error('GitHub code is required', 400, 'Bad Request')
          );
        }
        const jwtSign = this.app.jwt.sign.bind(this.app.jwt);
        const result = await this.authService.githubLogin(code, true, jwtSign);
        return reply.code(200).send(AuthResponseHelper.success(result));
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Refresh token route
    app.post('/auth/refresh-token', {
      schema: {
        body: AuthRequestDto.RefreshTokenSchema.body,
        querystring: {
          type: 'object',
          properties: {
            profile: { type: 'boolean', default: true }
          }
        },
        response: {
          200: AuthResponseDto.LoginResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Refresh access token'
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = request.body as { refresh_token: string };
        const query = request.query as { profile?: boolean };
        const profile = query.profile !== undefined ? query.profile : true;

        if (!data.refresh_token || typeof data.refresh_token !== 'string') {
          return reply.code(400).send(
            AuthResponseHelper.error('Refresh token is required', 400, 'Bad Request')
          );
        }

        // Pass Fastify JWT functions to service
        const jwtSign = this.app.jwt.sign.bind(this.app.jwt);
        const jwtVerify = this.app.jwt.verify.bind(this.app.jwt);
        const result = await this.authService.getNewAccessToken(data.refresh_token, profile, jwtSign, jwtVerify);
        
        return reply.code(200).send(
          AuthResponseHelper.success(result)
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Get account profile route (protected)
    app.get('/auth/me', {
      preHandler: this.jwtGuard.preHandler.bind(this.jwtGuard),
      schema: {
        headers: {
          type: 'object',
          properties: {
            authorization: { type: 'string' }
          },
          required: ['authorization']
        },
        response: {
          200: AuthResponseDto.GetAccountResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Get current user profile (tenants & permissions tách riêng)',
        security: [{ bearerAuth: [] }]
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request.headers as any).user;

        if (!user || !user.email) {
          return reply.code(401).send(
            AuthResponseHelper.error('Invalid user token', 401, 'Unauthorized')
          );
        }

        // Pass x-tenant-id so resolveRoleContext returns role_name per tenant
        // (via user_tenant.role_name) instead of the legacy userResult.role_name.
        const tenantId = (request.headers['x-tenant-id'] as string) || undefined;
        const result: any = await this.authService.getProfile(user.email, true, false, tenantId);
        // Permissions split into /auth/permissions
        result.permissions = undefined;
        result.permission = undefined;

        return reply.code(200).send(
          AuthResponseHelper.success(result)
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Permissions of current user within a tenant (protected) — split from /auth/me
    app.get('/auth/permissions', {
      preHandler: this.jwtGuard.preHandler.bind(this.jwtGuard),
      schema: {
        headers: {
          type: 'object',
          properties: {
            authorization: { type: 'string' },
            'x-tenant-id': { type: 'string', description: 'Tenant slug hoặc ID — trả permissions trong tenant đó. Không truyền: dùng role_name mặc định.' }
          },
          required: ['authorization']
        },
        response: {
          200: AuthResponseDto.PermissionsResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Get permissions of current user in a tenant',
        security: [{ bearerAuth: [] }]
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request.headers as any).user;
        const tenantId = request.headers['x-tenant-id'] as string | undefined;

        if (!user || !user.email) {
          return reply.code(401).send(
            AuthResponseHelper.error('Invalid user token', 401, 'Unauthorized')
          );
        }

        const permissions = await this.authService.getPermissions(user.email, tenantId);

        return reply.code(200).send(
          AuthResponseHelper.success(permissions)
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Logout route (protected)
    app.post('/auth/logout', {
      preHandler: this.jwtGuard.preHandler.bind(this.jwtGuard),
      schema: {
        headers: {
          type: 'object',
          properties: {
            authorization: { type: 'string' }
          },
          required: ['authorization']
        },
        response: {
          200: AuthResponseDto.LogoutResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'User logout',
        security: [{ bearerAuth: [] }]
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request.headers as any).user;

        if (!user || !user.id) {
          return reply.code(401).send(
            AuthResponseHelper.error('Invalid user token', 401, 'Unauthorized')
          );
        }

        // Tier 1 — blacklist the current token (logs out this device). Access token is stateless
        // so without blacklisting it stays alive until it expires even after the refresh token is deleted.
        const raw = ((request.headers['authorization'] as string) || '').split(' ')[1];
        if (raw) await blacklistToken(raw);

        const result = await this.authService.logout(user.id);

        return reply.code(200).send(
          AuthResponseHelper.success(result, 'Logged out successfully')
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Change password (knows old password) — protected. After changing: revoke-all (logs out all devices)
    // + auto-login mints a NEW token to return so the current session can keep using it.
    app.post('/auth/change-password', {
      preHandler: this.jwtGuard.preHandler.bind(this.jwtGuard),
      schema: {
        headers: {
          type: 'object',
          properties: { authorization: { type: 'string' } },
          required: ['authorization']
        },
        body: AuthRequestDto.ChangePasswordSchema.body,
        response: {
          200: AuthResponseDto.LoginResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Đổi mật khẩu (biết MK cũ) + revoke-all + auto-login',
        security: [{ bearerAuth: [] }]
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request.headers as any).user;
        if (!user || !user.id) {
          return reply.code(401).send(
            AuthResponseHelper.error('Invalid user token', 401, 'Unauthorized')
          );
        }

        const { oldPassword, newPassword } = request.body as { oldPassword: string; newPassword: string };
        await this.authService.changePassword(user.id, oldPassword, newPassword);

        // Auto-login: the old token was just revoke-all'd → issue new access + refresh for the current session.
        const accessToken = this.signAccessToken(user);
        const jwtSign = this.app.jwt.sign.bind(this.app.jwt);
        const refreshToken = await this.authService.createRefreshToken(user, jwtSign);

        return reply.code(200).send(
          AuthResponseHelper.success({ accessToken, refreshToken }, 'Password changed successfully')
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Forgot password — request OTP (public). ALWAYS returns a generic 200 (anti-enumeration).
    app.post('/auth/forgot-password', {
      schema: {
        body: AuthRequestDto.ForgotPasswordSchema.body,
        response: {
          200: AuthResponseDto.MessageResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Quên mật khẩu — gửi OTP qua email (response generic)'
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { email } = request.body as { email: string };
        const result = await this.otpService.forgotPassword(email);
        return reply.code(200).send(AuthResponseHelper.success(result, result.message));
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

    // Reset password using OTP (public) — verify OTP → set new password → revoke-all → auto-login.
    app.post('/auth/reset-password', {
      schema: {
        body: AuthRequestDto.ResetPasswordSchema.body,
        response: {
          200: AuthResponseDto.LoginResponseSchema[200],
          ...AuthResponseDto.ErrorResponseSchema
        },
        tags: [`auth v${MODULE_VERSION}`],
        summary: 'Đặt lại mật khẩu bằng OTP + auto-login'
      }
    }, async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { email, otp, newPassword } = request.body as { email: string; otp: string; newPassword: string };
        const { message, user } = await this.otpService.resetPassword(email, otp, newPassword);

        // Auto-login: issue new access + refresh (revoke-all just killed the user's old tokens).
        const accessToken = this.signAccessToken(user);
        const jwtSign = this.app.jwt.sign.bind(this.app.jwt);
        const refreshToken = await this.authService.createRefreshToken(user, jwtSign);

        return reply.code(200).send(
          AuthResponseHelper.success({ accessToken, refreshToken }, message)
        );
      } catch (error) {
        return this.handleError(error, reply);
      }
    });

  }

  private handleError(error: any, reply: FastifyReply) {
    console.error('Auth Controller Error:', error);

    if (error.statusCode) {
      // Custom HTTP error
      const httpError = error as AppError;
      return reply.code(httpError.statusCode).send(
        AuthResponseHelper.error(httpError.message, httpError.statusCode, this.getErrorName(httpError.statusCode))
      );
    }

    // Default server error
    return reply.code(500).send(
      AuthResponseHelper.error('Internal Server Error', 500, 'Internal Server Error')
    );
  }

  private getErrorName(statusCode: number): string {
    const errorNames: { [key: number]: string } = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error'
    };

    return errorNames[statusCode] || 'Error';
  }
}
