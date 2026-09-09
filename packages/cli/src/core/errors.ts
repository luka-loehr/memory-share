/**
 * Exit codes are part of the CLI's contract with scripts, so they are named
 * once here rather than sprinkled as magic numbers at the throw sites.
 */
export const EXIT = {
  ok: 0,
  usage: 2,
  config: 3,
  network: 4,
  api: 5,
  integrity: 6,
  external: 7,
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error we produced deliberately: printed as a clean message, never a stack. */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, options: { code?: ExitCode; hint?: string } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = options.code ?? EXIT.api;
    this.hint = options.hint;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { code: EXIT.usage, hint });
    this.name = 'UsageError';
  }
}

export class ConfigError extends CliError {
  constructor(message: string, hint = 'Run `ms login` to set up credentials.') {
    super(message, { code: EXIT.config, hint });
    this.name = 'ConfigError';
  }
}

/** A non-2xx response from the worker, carrying enough to act on. */
export class ApiError extends CliError {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, detail: string) {
    super(`${method} ${path} failed: ${status}${detail ? ` — ${detail}` : ''}`, {
      code: EXIT.api,
      hint: hintForStatus(status),
    });
    this.name = 'ApiError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'The admin token was rejected. Run `ms login` to store a current one.';
  }
  if (status === 404) return 'The worker route is missing — is the deployed version current?';
  if (status === 429) return 'Rate limited by the worker; retry in a moment.';
  if (status >= 500) return 'The worker errored. `wrangler tail` will show why.';
  return undefined;
}

export class IntegrityError extends CliError {
  constructor(message: string) {
    super(message, {
      code: EXIT.integrity,
      hint: 'The downloaded bytes do not match their content hash. Delete the file and retry.',
    });
    this.name = 'IntegrityError';
  }
}
