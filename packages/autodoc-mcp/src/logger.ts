/**
 * Structured diagnostic logger directing all events strictly to stderr.
 * In stdio MCP environments, stdout is exclusively reserved for JSON-RPC messages.
 */

export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

export interface StructuredLog {
  timestamp: string;
  level: LogLevel;
  code?: string;
  message: string;
  context?: Record<string, unknown>;
}

export class Logger {
  private static formatLog(level: LogLevel, message: string, code?: string, context?: Record<string, unknown>): string {
    const payload: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      ...(code ? { code } : {}),
      message,
      ...(context ? { context } : {}),
    };
    return JSON.stringify(payload);
  }

  static debug(message: string, context?: Record<string, unknown>): void {
    process.stderr.write(this.formatLog(LogLevel.DEBUG, message, undefined, context) + "\n");
  }

  static info(message: string, context?: Record<string, unknown>): void {
    process.stderr.write(this.formatLog(LogLevel.INFO, message, undefined, context) + "\n");
  }

  static warn(code: string, message: string, context?: Record<string, unknown>): void {
    process.stderr.write(this.formatLog(LogLevel.WARN, message, code, context) + "\n");
  }

  static error(code: string, message: string, context?: Record<string, unknown>): void {
    process.stderr.write(this.formatLog(LogLevel.ERROR, message, code, context) + "\n");
  }
}
