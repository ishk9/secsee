export class DbConnectionError extends Error {
  public readonly dbType: string;

  constructor(dbType: string, detail: string) {
    super(`Failed to connect to ${dbType} database: ${detail}`);
    this.name = "DbConnectionError";
    this.dbType = dbType;
  }
}

export class CrawlLoopDetectedError extends Error {
  public readonly url: string;
  public readonly depth: number;

  constructor(url: string, depth: number) {
    super(`Crawl loop detected at '${url}' (depth: ${depth})`);
    this.name = "CrawlLoopDetectedError";
    this.url = url;
    this.depth = depth;
  }
}

export class AuthenticationFailedError extends Error {
  public readonly url: string;
  public readonly reason: string;

  constructor(url: string, reason: string) {
    super(`Authentication failed at '${url}': ${reason}`);
    this.name = "AuthenticationFailedError";
    this.url = url;
    this.reason = reason;
  }
}

export class ConfigValidationError extends Error {
  public readonly fieldErrors: Record<string, string[]>;

  constructor(message: string, fieldErrors: Record<string, string[]> = {}) {
    super(message);
    this.name = "ConfigValidationError";
    this.fieldErrors = fieldErrors;
  }
}
