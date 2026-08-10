type CommandErrorContext = {
  command: string;
  target?: string;
  options?: string;
  suggestion?: string;
};

type ErrorContextFactory<T extends unknown[]> = (args: T, error: unknown) => CommandErrorContext;

type CommanderErrorLike = Error & {
  code?: string;
  exitCode?: number;
};

export type CliErrorCode =
  | 'AUTH_REQUIRED'
  | 'COMMAND_FAILED'
  | 'HTTP_ERROR'
  | 'INVALID_ARGUMENT'
  | 'NETWORK_ERROR'
  | 'NOT_FOUND'
  | 'UNKNOWN_COMMAND';

export type CliErrorPayload = {
  ok: false;
  error: {
    code: CliErrorCode;
    message: string;
    command: string;
    target?: string;
    suggestion?: string;
  };
};

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCommanderError(error: unknown): error is CommanderErrorLike {
  return error instanceof Error && 'code' in error && String((error as CommanderErrorLike).code).startsWith('commander.');
}

function classifyError(error: unknown, message: string): CliErrorCode {
  if (isCommanderError(error)) {
    if (error.code === 'commander.unknownCommand') {
      return 'UNKNOWN_COMMAND';
    }
    return 'INVALID_ARGUMENT';
  }

  const structuredCode = error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code || '')
    : '';
  const structuredStatus = error instanceof Error && 'status' in error
    ? Number((error as Error & { status?: unknown }).status)
    : Number.NaN;
  if (structuredCode === 'NETWORK') return 'NETWORK_ERROR';
  if (structuredCode === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (structuredCode === 'HTTP_STATUS') {
    if (structuredStatus === 401) return 'AUTH_REQUIRED';
    if (structuredStatus === 404) return 'NOT_FOUND';
    return 'HTTP_ERROR';
  }
  if (['CHALLENGE', 'CONTENT_TYPE', 'INVALID_JSON', 'REDIRECT', 'SCHEMA_MISMATCH'].includes(structuredCode)) {
    return 'HTTP_ERROR';
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes('enotfound') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('aborterror')
  ) {
    return 'NETWORK_ERROR';
  }
  if (
    normalized.includes('http 401') ||
    normalized.includes('cookie') ||
    normalized.includes('login') ||
    message.includes('登录') ||
    message.includes('登录态')
  ) {
    return 'AUTH_REQUIRED';
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('must be') ||
    message.includes('必须') ||
    message.includes('不能为空') ||
    message.includes('未知') ||
    message.includes('不能超过') ||
    message.includes('不能同时')
  ) {
    return 'INVALID_ARGUMENT';
  }
  if (
    normalized.includes('http 404') ||
    normalized.includes('not found') ||
    message.includes('不存在') ||
    message.includes('未找到')
  ) {
    return 'NOT_FOUND';
  }
  if (normalized.includes('http ')) {
    return 'HTTP_ERROR';
  }
  return 'COMMAND_FAILED';
}

export function isJsonOutputRequested(argv: readonly string[] = process.argv.slice(2)): boolean {
  return argv.includes('--json');
}

function createErrorPayload(error: unknown, ctx: CommandErrorContext): CliErrorPayload {
  const message = toMessage(error);
  return {
    ok: false,
    error: {
      code: classifyError(error, message),
      message,
      command: ctx.command,
      ...(ctx.target ? { target: ctx.target } : {}),
      ...(ctx.suggestion ? { suggestion: ctx.suggestion } : {})
    }
  };
}

function printCliError(error: unknown, ctx: CommandErrorContext): void {
  const payload = createErrorPayload(error, ctx);
  if (isJsonOutputRequested()) {
    console.error(JSON.stringify(payload));
    return;
  }

  const target = ctx.target ? ` (${ctx.target})` : '';
  console.error(`❌ [${payload.error.code}] ${payload.error.message}${target}`);
  if (ctx.options) {
    console.error(`   可选项：${ctx.options}`);
  }
  console.error(`   提示：${ctx.suggestion || '运行 douban --help 查看完整用法'}`);
}

export function withErrorHandler<T extends unknown[]>(
  ctx: CommandErrorContext | ErrorContextFactory<T>,
  fn: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      const resolved = typeof ctx === 'function' ? ctx(args, error) : ctx;
      printCliError(error, resolved);
      process.exitCode = 1;
    }
  };
}

export function handleProgramError(error: unknown): void {
  if (isCommanderError(error) && error.exitCode === 0) {
    return;
  }

  printCliError(error, {
    command: 'douban',
    suggestion: '可运行 douban --help 查看可用命令'
  });
  process.exitCode = 1;
}
