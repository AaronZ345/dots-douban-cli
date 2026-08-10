export type HttpErrorCode =
  | 'HTTP_STATUS'
  | 'NETWORK'
  | 'CONTENT_TYPE'
  | 'REDIRECT'
  | 'CHALLENGE'
  | 'AUTH_REQUIRED'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH';

export interface HttpRequestErrorOptions {
  code: HttpErrorCode;
  url: string;
  status?: number;
  attempts?: number;
  retryable?: boolean;
  responseSnippet?: string;
  cause?: unknown;
}

export class HttpRequestError extends Error {
  readonly code: HttpErrorCode;
  readonly url: string;
  readonly status?: number;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly responseSnippet?: string;

  constructor(message: string, options: HttpRequestErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpRequestError';
    this.code = options.code;
    this.url = options.url;
    this.status = options.status;
    this.attempts = options.attempts ?? 1;
    this.retryable = options.retryable ?? false;
    this.responseSnippet = options.responseSnippet;
  }
}

export class ResponseSchemaError extends HttpRequestError {
  constructor(message: string, url: string, responseSnippet?: string) {
    super(message, {
      code: 'SCHEMA_MISMATCH',
      url,
      responseSnippet
    });
    this.name = 'ResponseSchemaError';
  }
}
