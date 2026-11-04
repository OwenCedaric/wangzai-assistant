export class LocalApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LocalApiError';
    this.status = options.status || 0;
    this.payload = options.payload || null;
    this.code = options.code || options.payload?.error?.code || 'LOCAL_API_ERROR';
  }
}
