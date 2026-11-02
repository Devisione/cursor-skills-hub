import { redactSecrets } from "./security";

export interface LogSink {
  append(line: string): void;
}

export interface RecentError {
  at: string;
  area: string;
  message: string;
}

export class Logger {
  private readonly recent: RecentError[] = [];

  constructor(private readonly sink: LogSink) {}

  info(area: string, message: string): void {
    this.write("INFO", area, message);
  }

  warn(area: string, message: string): void {
    this.write("WARN", area, message);
  }

  error(area: string, message: string): void {
    const safe = redactSecrets(message);
    this.recent.unshift({ at: new Date().toISOString(), area, message: safe });
    this.recent.splice(20);
    this.write("ERROR", area, safe);
  }

  recentErrors(): RecentError[] {
    return [...this.recent];
  }

  private write(level: string, area: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${area} ${redactSecrets(message)}`;
    this.sink.append(line);
  }
}
