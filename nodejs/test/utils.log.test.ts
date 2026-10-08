import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import LogService from "../src/utils/log";

const LOG_FILE = path.join(process.cwd(), "logs", "app.log");

function readLog(): string {
  return fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
}

describe("utils/log — 日志写入格式", () => {
  it("四个级别都会以 [时间] LEVEL: 消息 的格式追加到 logs/app.log", () => {
    const marker = `log-test-${Math.random().toString(36).slice(2)}`;
    const sizes = ["debug", "info", "warn", "error"] as const;

    sizes.forEach((level, index) => {
      (LogService[level] as (message: string) => void)(`${marker}-${index}`);
    });

    const content = readLog();
    sizes.forEach((level, index) => {
      const pattern = new RegExp(
        `\\[\\d{4}-\\d{2}-\\d{2}T[^\\]]+\\+08:00\\] ${level.toUpperCase()}: ${marker}-${index}`
      );
      expect(content, level).toMatch(pattern);
    });
  });

  it("时间戳使用东八区（+08:00）", () => {
    const marker = `tz-${Math.random().toString(36).slice(2)}`;
    LogService.info(marker);
    const line = readLog().split("\n").find((l) => l.includes(marker));
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00\] INFO: /);
  });

  it("meta 对象被 JSON 序列化追加在行尾", () => {
    const marker = `meta-${Math.random().toString(36).slice(2)}`;
    LogService.warn(marker, { ip: "1.2.3.4", nested: { a: 1 } });
    const line = readLog().split("\n").find((l) => l.includes(marker));
    expect(line).toContain('Meta: {"ip":"1.2.3.4","nested":{"a":1}}');
  });

  it("没有 meta 时不输出 Meta 段", () => {
    const marker = `nometa-${Math.random().toString(36).slice(2)}`;
    LogService.error(marker);
    const line = readLog().split("\n").find((l) => l.includes(marker));
    expect(line).not.toContain("Meta:");
  });

  it("每条日志独占一行并以换行结尾", () => {
    const marker = `newline-${Math.random().toString(36).slice(2)}`;
    LogService.info(marker);
    const content = readLog();
    const index = content.indexOf(marker);
    expect(index).toBeGreaterThan(-1);
    expect(content.indexOf("\n", index)).toBeGreaterThan(index);
  });
});
