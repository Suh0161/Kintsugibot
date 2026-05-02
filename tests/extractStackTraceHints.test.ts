import { describe, it, expect } from "vitest";

// Mirror of the private function — copy kept in sync with issueAgent.ts
interface StackTraceHint { file: string; line: number; function?: string }

function extractStackTraceHints(body: string | undefined): StackTraceHint[] {
  if (!body) return [];
  const hints: StackTraceHint[] = [];
  const seen = new Set<string>();
  const patterns = [
    /at\s+(?:async\s+)?([\w.<>]+)\s+\(([^)]+):(\d+):\d+\)/g,
    /([\w./-]+\.[\w]+):(\d+):\d+/g,
    /([\w./-]+\.[\w]+):(\d+)(?!\d)/g,
  ];
  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      const m1 = match[1], m2 = match[2], m3 = match[3];
      let file: string | undefined, lineStr: string | undefined, func: string | undefined;
      if (m1 && m2 && m3) { func = m1; file = m2; lineStr = m3; }
      else if (m1 && m2) { file = m1; lineStr = m2; }
      if (!file || !lineStr) continue;
      file = file.replace(/^.*\//, "");
      const line = parseInt(lineStr, 10);
      if (isNaN(line) || line <= 0) continue;
      const key = `${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push({ file, line, function: func });
    }
  }
  return hints.slice(0, 20);
}

describe("extractStackTraceHints", () => {
  it("returns empty array for undefined body", () => {
    expect(extractStackTraceHints(undefined)).toEqual([]);
  });

  it("returns empty array for body with no file references", () => {
    expect(extractStackTraceHints("The app crashed for some reason.")).toEqual([]);
  });

  it("extracts Node.js style stack trace", () => {
    const body = `
TypeError: Cannot read property 'foo' of null
    at parseConfig (src/config.ts:42:10)
    at bootstrap (src/index.ts:8:3)
    `;
    const hints = extractStackTraceHints(body);
    expect(hints.some(h => h.file === "config.ts" && h.line === 42)).toBe(true);
    expect(hints.some(h => h.file === "index.ts" && h.line === 8)).toBe(true);
  });

  it("extracts function name from stack frame", () => {
    const body = "at parseConfig (src/config.ts:42:10)";
    const hints = extractStackTraceHints(body);
    const h = hints.find(h => h.file === "config.ts");
    expect(h?.function).toBe("parseConfig");
  });

  it("extracts bare file:line:col references", () => {
    const body = "Error at src/utils/helper.py:101:5";
    const hints = extractStackTraceHints(body);
    expect(hints.some(h => h.file === "helper.py" && h.line === 101)).toBe(true);
  });

  it("deduplicates repeated file:line entries", () => {
    const body = "config.ts:42 config.ts:42 config.ts:42";
    const hints = extractStackTraceHints(body);
    const matches = hints.filter(h => h.file === "config.ts" && h.line === 42);
    expect(matches.length).toBe(1);
  });

  it("caps results at 20 hints", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `file${i}.ts:${i + 1}:1`).join("\n");
    const hints = extractStackTraceHints(lines);
    expect(hints.length).toBeLessThanOrEqual(20);
  });

  it("strips full path and keeps only basename", () => {
    const body = "at fn (/home/user/project/src/deeply/nested/module.ts:99:5)";
    const hints = extractStackTraceHints(body);
    const h = hints.find(h => h.line === 99);
    expect(h?.file).toBe("module.ts");
    expect(h?.file).not.toContain("/");
  });

  it("handles async stack frames", () => {
    const body = "at async processQueue (src/queue/worker.ts:55:3)";
    const hints = extractStackTraceHints(body);
    expect(hints.some(h => h.file === "worker.ts" && h.line === 55)).toBe(true);
  });
});
