export type ErrorCode =
  | "unauthorized"
  | "forbidden_scope"
  | "not_found"
  | "validation_failed"
  | "invalid_transition"
  | "duplicate_application"
  | "quota_exceeded"
  | "job_not_open"
  | "not_configured"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden_scope: 403,
  not_found: 404,
  validation_failed: 422,
  invalid_transition: 409,
  duplicate_application: 409,
  quota_exceeded: 429,
  job_not_open: 409,
  not_configured: 503,
  internal: 500,
};

export class HireError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  get status(): number {
    return STATUS[this.code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export interface FieldIssue {
  field: string;
  message: string;
}

export function invalid(fields: FieldIssue[], message?: string): HireError {
  return new HireError(
    "validation_failed",
    message ?? `有 ${fields.length} 个字段不符合要求，按 details.fields 改正后重试。`,
    { fields },
  );
}

export function notFound(what: string): HireError {
  return new HireError("not_found", `找不到这个${what}，或者你无权访问它。`);
}
