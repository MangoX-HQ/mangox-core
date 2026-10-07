// Request DTOs for Auth module
// Note: Validation will be handled by Fastify schema

export namespace AuthRequestDto {
    export interface LoginLocalDataDto {
        email: string;
        password: string;
    }

    export interface PasswordDto {
        value: string;
    }

    export interface PayloadTokenDto {
        id: string;
        email: string;
        username: string;
        phone: string;
        role: string;
        exp?: any;
    }

    export interface RegisterDataDto {
        email: string;
        username: string;
        phone: string;
        password: string;
    }

    // Validation schemas for Fastify
    export const LoginSchema = {
        body: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
                email: { 
                    type: 'string', 
                    format: 'email'
                },
                password: { 
                    type: 'string',
                    minLength: 1
                }
            }
        }
    };

    export const RegisterSchema = {
        body: {
            type: 'object',
            required: ['email', 'username', 'phone', 'password'],
            properties: {
                email: { 
                    type: 'string',
                    format: 'email'
                },
                username: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 50
                },
                phone: {
                    type: 'string',
                    pattern: '^[+]?[0-9]{10,15}$'
                },
                password: {
                    type: 'string',
                    minLength: 8,
                    maxLength: 72
                },
                tenant_id: { type: 'string', description: 'Optional — auto-join nếu tenant.type=public' },
                default_role: { type: 'string', description: 'Optional — default customer' }
            }
        }
    };

    export const RefreshTokenSchema = {
        body: {
            type: 'object',
            required: ['refresh_token'],
            properties: {
                refresh_token: { type: 'string' }
            }
        }
    };

    export const ChangePasswordSchema = {
        body: {
            type: 'object',
            required: ['oldPassword', 'newPassword'],
            properties: {
                oldPassword: { type: 'string', minLength: 1 },
                newPassword: { type: 'string', minLength: 8, maxLength: 72 }
            }
        }
    };

    export const ForgotPasswordSchema = {
        body: {
            type: 'object',
            required: ['email'],
            properties: {
                email: { type: 'string', format: 'email' }
            }
        }
    };

    export const ResetPasswordSchema = {
        body: {
            type: 'object',
            required: ['email', 'otp', 'newPassword'],
            properties: {
                email: { type: 'string', format: 'email' },
                otp: { type: 'string', minLength: 4, maxLength: 10 },
                newPassword: { type: 'string', minLength: 8, maxLength: 72 }
            }
        }
    };
}

// Validation functions for manual validation and transformation
export class AuthRequestValidation {
    static validateEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    static validatePassword(password: string): { valid: boolean; message?: string } {
        // Relaxed: only requires a minimum length of 8, does NOT require lowercase/digit/character
        // special, allows whitespace. Max 72 (bcrypt limit).
        if (password.length < 8 || password.length > 72) {
            return {
                valid: false,
                message: 'Password must be between 8 and 72 characters'
            };
        }
        return { valid: true };
    }

    static validatePhone(phone: string): boolean {
        const phoneRegex = /^[+]?[0-9]{10,15}$/;
        return phoneRegex.test(phone);
    }

    static validateUsername(username: string): { valid: boolean; message?: string } {
        // Relaxed: can be set freely, just needs to be non-empty and ≤ 50 characters (no format enforced).
        if (username.length < 1 || username.length > 50) {
            return {
                valid: false,
                message: 'Username must be between 1 and 50 characters'
            };
        }
        return { valid: true };
    }

    // Transform functions to handle data transformation manually
    static transformEmail(email: string): string {
        return email.toLowerCase().trim();
    }

    static sanitizeInput(input: string): string {
        return input.trim();
    }

    // Validate and transform request data
    static validateAndTransformLoginData(data: any): { valid: boolean; data?: AuthRequestDto.LoginLocalDataDto; errors?: string[] } {
        const errors: string[] = [];
        
        if (!data.email) {
            errors.push('Email is required');
        } else if (!this.validateEmail(data.email)) {
            errors.push('Invalid email format');
        }

        if (!data.password) {
            errors.push('Password is required');
        }

        if (errors.length > 0) {
            return { valid: false, errors };
        }

        return {
            valid: true,
            data: {
                email: this.transformEmail(data.email),
                password: data.password
            }
        };
    }

    static validateAndTransformRegisterData(data: any): { valid: boolean; data?: AuthRequestDto.RegisterDataDto; errors?: string[] } {
        const errors: string[] = [];
        
        if (!data.email) {
            errors.push('Email is required');
        } else if (!this.validateEmail(data.email)) {
            errors.push('Invalid email format');
        }

        if (!data.username) {
            errors.push('Username is required');
        } else {
            const usernameValidation = this.validateUsername(data.username);
            if (!usernameValidation.valid) {
                errors.push(usernameValidation.message!);
            }
        }

        if (!data.phone) {
            errors.push('Phone is required');
        } else if (!this.validatePhone(data.phone)) {
            errors.push('Invalid phone format');
        }

        if (!data.password) {
            errors.push('Password is required');
        } else {
            const passwordValidation = this.validatePassword(data.password);
            if (!passwordValidation.valid) {
                errors.push(passwordValidation.message!);
            }
        }

        if (errors.length > 0) {
            return { valid: false, errors };
        }

        return {
            valid: true,
            data: {
                email: this.transformEmail(data.email),
                username: this.sanitizeInput(data.username),
                phone: this.sanitizeInput(data.phone),
                password: data.password
            }
        };
    }
}
