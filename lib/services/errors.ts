// Typed service errors. Route handlers map them to clean JSON responses (see lib/api/http.ts).

export type ServiceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "golden_read_only"
  | "workspace_expired"
  | "user_cap_reached"
  | "global_cap_reached"
  | "invalid_input"
  | "not_sandbox"
  | "conflict"
  | "in_progress"
  | "not_approved"
  | "not_executable"
  | "rate_limited"
  | "paypal_failed"
  | "internal";

const STATUS: Record<ServiceErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  golden_read_only: 403,
  workspace_expired: 410,
  user_cap_reached: 429,
  global_cap_reached: 503,
  invalid_input: 400,
  not_sandbox: 503,
  conflict: 409,
  in_progress: 409,
  not_approved: 409,
  not_executable: 409,
  rate_limited: 429,
  paypal_failed: 502,
  internal: 500,
};

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: ServiceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export class GoldenReadOnlyError extends ServiceError {
  constructor() {
    super("golden_read_only", "The golden workspace is read-only");
    this.name = "GoldenReadOnlyError";
  }
}
