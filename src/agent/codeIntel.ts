// Code intelligence for large codebases.
// Builds symbol indexes, import graphs, and relevance rankings
// so the LLM can navigate 50-400+ files without reading everything.

import { logger } from "../utils/logger.js";

export interface SymbolInfo {
  name: string;
  file: string;
  line: number;
  type: "function" | "class" | "interface" | "type" | "variable" | "unknown";
}

export interface ImportEdge {
  from: string;
  to: string;
}

export interface FileRelevance {
  file: string;
  score: number;
  reasons: string[];
}

export class CodeIntel {
  private execForTools: (cmd: string, timeout?: number) => Promise<string>;
  private symbolCache: SymbolInfo[] | null = null;
  private importCache: ImportEdge[] | null = null;

  constructor(execForTools: (cmd: string, timeout?: number) => Promise<string>) {
    this.execForTools = execForTools;
  }

  /** Build or return cached symbol index. */
  async getSymbols(): Promise<SymbolInfo[]> {
    if (this.symbolCache) return this.symbolCache;
    this.symbolCache = await this.buildSymbolIndex();
    return this.symbolCache;
  }

  /** Build or return cached import graph. */
  async getImports(): Promise<ImportEdge[]> {
    if (this.importCache) return this.importCache;
    this.importCache = await this.buildImportGraph();
    return this.importCache;
  }

  /** Find all definitions of a symbol name (case-insensitive). */
  async findSymbol(name: string): Promise<SymbolInfo[]> {
    const symbols = await this.getSymbols();
    const lower = name.toLowerCase();
    return symbols.filter(s => s.name.toLowerCase() === lower || s.name.toLowerCase().includes(lower));
  }

  /** Show files that import a given file path. */
  async traceImports(filePath: string): Promise<string[]> {
    const imports = await this.getImports();
    const normalized = filePath.replace(/^\/+/, "").replace(/\\/g, "/");
    // Match imports that reference this file (with or without extension)
    const base = normalized.replace(/\.\w+$/, "");
    const importers = imports
      .filter(edge => {
        const toBase = edge.to.replace(/\.\w+$/, "");
        return toBase === base || edge.to === normalized;
      })
      .map(edge => edge.from);
    return [...new Set(importers)];
  }

  /** Rank files by relevance to an issue. */
  async rankRelevantFiles(issueTitle: string, issueBody: string): Promise<FileRelevance[]> {
    const text = `${issueTitle} ${issueBody}`.toLowerCase();
    const symbols = await this.getSymbols();
    const imports = await this.getImports();
    const scores = new Map<string, { score: number; reasons: Set<string> }>();

    const add = (file: string, points: number, reason: string) => {
      const existing = scores.get(file) ?? { score: 0, reasons: new Set<string>() };
      existing.score += points;
      existing.reasons.add(reason);
      scores.set(file, existing);
    };

    // 1. Stack trace files get highest priority
    const stackFiles = this.extractFileNamesFromText(text);
    for (const f of stackFiles) {
      add(f, 100, "mentioned in stack trace/error");
    }

    // 2. Symbol name matches in issue text
    for (const sym of symbols) {
      if (text.includes(sym.name.toLowerCase())) {
        add(sym.file, 50, `defines '${sym.name}' mentioned in issue`);
      }
    }

    // 3. Filename matches keywords
    const keywords = text.split(/\s+/).filter(w => w.length > 3);
    for (const sym of symbols) {
      const fileLower = sym.file.toLowerCase();
      for (const kw of keywords) {
        if (fileLower.includes(kw)) {
          add(sym.file, 20, `filename matches '${kw}'`);
        }
      }
    }

    // 4. Boost files that import highly-ranked files (callers of buggy code)
    for (const [file, data] of scores) {
      if (data.score >= 50) {
        const importers = imports.filter(e => {
          const toBase = e.to.replace(/\.\w+$/, "");
          const fileBase = file.replace(/\.\w+$/, "");
          return toBase === fileBase;
        });
        for (const edge of importers) {
          add(edge.from, 15, `imports ${file}`);
        }
      }
    }

    const results: FileRelevance[] = Array.from(scores.entries())
      .map(([file, data]) => ({ file, score: data.score, reasons: Array.from(data.reasons) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);

    logger.info({ count: results.length, top: results.slice(0, 5).map(r => r.file) }, "Ranked relevant files");
    return results;
  }

  /** Extract filenames that look like source files from text. */
  private extractFileNamesFromText(text: string): string[] {
    const seen = new Set<string>();
    const matches = text.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|c|cpp|h|hpp|cs|php)/g);
    for (const m of matches) {
      seen.add(m[0].replace(/^.*\//, ""));
    }
    return Array.from(seen);
  }

  /** Build symbol index using grep (fast, works for any language). */
  private async buildSymbolIndex(): Promise<SymbolInfo[]> {
    logger.info("Building symbol index");
    const symbols: SymbolInfo[] = [];

    // Multi-language regex patterns for definitions
    const patterns = [
      // JS/TS: export const|let|var|function|class|interface|type
      { regex: /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+)([A-Za-z_$][A-Za-z0-9_$]*)/, type: "function" as const, glob: "*.{ts,tsx,js,jsx}" },
      // Python: def / class
      { regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/, type: "function" as const, glob: "*.py" },
      { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/, type: "class" as const, glob: "*.py" },
      // Go: func
      { regex: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/, type: "function" as const, glob: "*.go" },
      // Rust: fn / struct / enum / impl
      { regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, type: "function" as const, glob: "*.rs" },
      { regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/, type: "class" as const, glob: "*.rs" },
      // Ruby: def
      { regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/, type: "function" as const, glob: "*.rb" },
      // Java/C#: methods/classes
      { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:[A-Za-z<>\[\]]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, type: "function" as const, glob: "*.{java,kt,cs}" },
    ];

    for (const p of patterns) {
      try {
        const grepResult = await this.execForTools(
          `grep -rn --include=${p.glob} -E '(${p.regex.source})' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=dist --exclude-dir=build 2>/dev/null | head -200`
        );
        for (const line of grepResult.split("\n")) {
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (!match) continue;
          const file = match[1];
          const lineNum = match[2];
          const content = match[3];
          if (!file || !lineNum || !content) continue;
          const symMatch = content.match(p.regex);
          if (symMatch && symMatch[1]) {
            symbols.push({
              name: symMatch[1],
              file: file.replace(/^\.\//, ""),
              line: parseInt(lineNum, 10),
              type: p.type,
            });
          }
        }
      } catch {
        // ignore grep failures for unsupported languages
      }
    }

    logger.info({ count: symbols.length }, "Symbol index built");
    return symbols;
  }

  /** Build import graph using grep. */
  private async buildImportGraph(): Promise<ImportEdge[]> {
    logger.info("Building import graph");
    const edges: ImportEdge[] = [];

    const importPatterns = [
      // JS/TS: import ... from './path' or require('./path')
      { regex: /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/, glob: "*.{ts,tsx,js,jsx}" },
      // Python: import x or from x import y
      { regex: /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/, glob: "*.py" },
      // Go: import "path"
      { regex: /import\s+["']([^'"]+)["']/, glob: "*.go" },
      // Rust: use crate::path or mod path
      { regex: /(?:use\s+crate::|mod\s+)([\w:]+)/, glob: "*.rs" },
    ];

    for (const p of importPatterns) {
      try {
        const grepResult = await this.execForTools(
          `grep -rn --include=${p.glob} -E '(${p.regex.source})' . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=dist --exclude-dir=build 2>/dev/null | head -300`
        );
        for (const line of grepResult.split("\n")) {
          const match = line.match(/^(.+?):\d+:(.+)$/);
          if (!match) continue;
          const fromFile = match[1];
          const content = match[2];
          if (!fromFile || !content) continue;
          const impMatch = content.match(p.regex);
          if (impMatch) {
            const toFile = (impMatch[1] || impMatch[2] || "").replace(/\./g, "/");
            if (toFile) {
              edges.push({
                from: fromFile.replace(/^\.\//, ""),
                to: toFile,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    logger.info({ count: edges.length }, "Import graph built");
    return edges;
  }
}
