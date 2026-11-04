export class ProtectedComputeError extends Error {
  constructor(
    code,
    message,
    { cause, status = 500, retriable = false, details } = {},
  ) {
    super(message, { cause });
    this.name = "ProtectedComputeError";
    this.code = code;
    this.status = status;
    this.retriable = retriable;
    if (details !== undefined) this.details = details;
  }
}

export function isProtectedComputeError(value) {
  return value instanceof ProtectedComputeError;
}

export function protectedComputeContractError(code, message, details) {
  return new ProtectedComputeError(code, message, {
    status: 400,
    retriable: false,
    details,
  });
}
