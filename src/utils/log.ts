import fs from 'fs';
import path from 'path';

interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  meta?: any;
}

class LogService {
  private logFilePath: string;
  private maxSize: number; // 日志文件最大大小（字节）

  constructor(logFileName: string = 'app.log', maxSize: number = 10 * 1024 * 1024) { // 默认10MB
    // 确保logs目录存在
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    this.logFilePath = path.join(logsDir, logFileName);
    this.maxSize = maxSize;
  }

  private formatLogEntry(entry: LogEntry): string {
    let logLine = `[${entry.timestamp}] ${entry.level}: ${entry.message}`;
    if (entry.meta) {
      logLine += ` | Meta: ${JSON.stringify(entry.meta)}`;
    }
    return logLine + '\n';
  }

  private checkAndRotate(): void {
    try {
      const stats = fs.statSync(this.logFilePath);
      if (stats.size > this.maxSize) {
        const rotatedFilePath = `${this.logFilePath}.${new Date().getTime()}`;
        fs.renameSync(this.logFilePath, rotatedFilePath);
      }
    } catch (err) {
      // 文件不存在或其他错误，忽略
    }
  }

  private writeLog(level: LogEntry['level'], message: string, meta?: any): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta
    };

    this.checkAndRotate();
    
    const logLine = this.formatLogEntry(entry);
    fs.appendFileSync(this.logFilePath, logLine, { encoding: 'utf8' });
  }

  debug(message: string, meta?: any): void {
    this.writeLog('DEBUG', message, meta);
  }

  info(message: string, meta?: any): void {
    this.writeLog('INFO', message, meta);
  }

  warn(message: string, meta?: any): void {
    this.writeLog('WARN', message, meta);
  }

  error(message: string, meta?: any): void {
    this.writeLog('ERROR', message, meta);
  }
}

export default new LogService();