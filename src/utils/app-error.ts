/**
 * AppError — user-facing error class for REST controllers/services.
 *
 * Throw this anywhere; the global error handler (src/index.ts) normalizes it
 * into the response body: `{ statusCode, message, code, fields?, data }`.
 *
 * - `code`   : machine code the frontend maps to UX (e.g. 'ENTITY_NOT_FOUND').
 * - `message`: human-readable; ONLY sent to the client when `expose` is true.
 * - `fields` : per-field validation errors for forms.
 * - `details`: extra payload, surfaced as response `data` (password-filtered).
 * - `expose` : false => message is hidden (generic 500 text) but full error is
 *              still logged. Use for anything that leaks internals.
 *
 * Does NOT extend CoreError on purpose — standalone, light API for app code.
 * HttpError / raw Error still work via the handler's fallback branch.
 */
export interface AppErrorField {
  field: string;
  message: string;
}

export interface AppErrorOptions {
  statusCode?: number;
  code: string;
  message: string;
  fields?: AppErrorField[];
  details?: unknown;
  expose?: boolean;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields?: AppErrorField[];
  readonly details?: unknown;
  readonly expose: boolean;
  readonly isOperational = true;

  constructor(o: AppErrorOptions) {
    super(o.message);
    this.name = 'AppError';
    this.statusCode = o.statusCode ?? 400;
    this.code = o.code;
    this.fields = o.fields;
    this.details = o.details;
    this.expose = o.expose ?? true;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }

  static notFound(resource: string, id?: string): AppError {
    return new AppError({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: id ? `${resource} not found: ${id}` : `${resource} not found`,
    });
  }

  static validation(fields: AppErrorField[], message = 'Validation failed'): AppError {
    return new AppError({ statusCode: 400, code: 'VALIDATION_FAILED', message, fields });
  }

  static badRequest(message: string, code = 'BAD_REQUEST'): AppError {
    return new AppError({ statusCode: 400, code, message });
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message });
  }

  static forbidden(message = 'Access denied'): AppError {
    return new AppError({ statusCode: 403, code: 'FORBIDDEN', message });
  }

  static conflict(resource: string, message?: string): AppError {
    return new AppError({
      statusCode: 409,
      code: 'CONFLICT',
      message: message ?? `${resource} already exists`,
    });
  }

  /** Internal failure — message hidden from client, full error logged. */
  static internal(message = 'Internal Server Error'): AppError {
    return new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message, expose: false });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
