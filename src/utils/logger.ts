type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  constructor(
    private module: string,
    private level: LogLevel = "info"
  ) {}

  debug(msg: string): void {
    this.log("debug", msg);
  }

  info(msg: string): void {
    this.log("info", msg);
  }

  warn(msg: string): void {
    this.log("warn", msg);
  }

  error(msg: string): void {
    this.log("error", msg);
  }

  private log(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const ts = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    console.error(`[${ts}] [${tag}] [${this.module}] ${msg}`);
  }
}
