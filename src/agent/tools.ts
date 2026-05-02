import type OpenAI from "openai";
import type { SandboxExecutor } from "../sandbox/executor.js";
import type { Octokit } from "@octokit/rest";
import type { AgentResult } from "./types.js";
import type { CodeIntel } from "./codeIntel.js";
import { shellSingleQuote } from "../utils/shell.js";

export interface ToolContext {
  sandbox: SandboxExecutor;
  octokit: Octokit;
  codeIntel: CodeIntel;
  repoOwner: string;
  repoName: string;
}

export interface InternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export function sanitizeCommand(cmd: string): string {
  const structuralBlocks: Array<[RegExp, string]> = [
    [/<\s*\(|>\s*\(/, "process substitution"],
    [/>:?\s*\/dev\/(?!null|zero|stdin|stdout|stderr)\w+/, "device file write"],
    [/\/proc\/(?:self|\d+)\/environ/, "/proc environ access"],
    [/\/etc\/(?:shadow|sudoers|gshadow|master\.passwd)/, "sensitive /etc file"],
    [/\/root\/\.ssh/, "SSH key directory"],
    [/>\s*[^\s]*\.env\b/, ".env file write"],
    [/\$\([^)]*(?:curl|wget|nc|netcat|ssh|scp|ftp|telnet|python|ruby|perl|php)[^)]*\)/, "subshell with network binary"],
    [/base64\s+[^|]*\|/, "base64 pipe"],
    [/\|\s*base64/, "pipe to base64"],
  ];

  for (const [pattern, label] of structuralBlocks) {
    if (pattern.test(cmd)) {
      throw new Error(`Blocked: ${label} in command`);
    }
  }

  const tokens = cmd.trim().split(/\s+/);
  let binaryToken = tokens[0] ?? "";
  for (const tok of tokens) {
    if (/^[A-Z_][A-Z0-9_]*=/.test(tok)) continue;
    binaryToken = tok;
    break;
  }

  const binaryName = binaryToken.replace(/^.*\//, "").toLowerCase();

  const ALLOWED_BINARIES = new Set([
    "node", "npm", "npx", "yarn", "pnpm", "tsx", "ts-node", "jest", "vitest",
    "mocha", "jasmine", "ava", "tap", "nyc", "c8",
    "python", "python3", "pip", "pip3", "pytest", "poetry", "pipenv", "uv",
    "go", "dlv",
    "cargo", "rustc",
    "ruby", "gem", "bundle", "rspec", "rake", "minitest",
    "java", "javac", "mvn", "gradle",
    "dotnet",
    "php", "composer",
    "make", "cmake", "ninja",
    "git",
    "sh", "bash", "echo", "printf", "cat", "head", "tail", "grep", "egrep",
    "fgrep", "sed", "awk", "cut", "sort", "uniq", "wc", "tr", "tee",
    "find", "ls", "stat", "file", "diff", "patch",
    "mkdir", "cp", "mv", "rm", "touch", "chmod", "chown",
    "true", "false", "test", "[",
    "env", "export",
    "which", "type", "command",
    "date", "whoami", "id", "uname",
    "jq", "xargs", "tee",
    "zip", "unzip", "tar", "gzip", "gunzip",
    "prettier", "eslint", "black", "isort", "ruff", "gofmt", "goimports",
    "rustfmt", "shfmt", "clang-format",
    "coverage", "mypy", "pyright", "tsc",
  ]);

  if (binaryName && !ALLOWED_BINARIES.has(binaryName)) {
    const isRelativeScript = binaryToken.startsWith("./");
    const isNodeModulesBin = binaryToken.includes("node_modules/.bin/");
    if (!isRelativeScript && !isNodeModulesBin && binaryToken !== "") {
      throw new Error(`Blocked: binary '${binaryName}' is not on the allowlist`);
    }
  }

  const argStr = tokens.slice(1).join(" ");

  if (binaryName === "git") {
    if (/remote\s+(?:-v|get-url|show|add|set-url)/.test(argStr)) {
      throw new Error("Blocked: git remote credential-leaking subcommand");
    }
    if (/push\s+.*--force/.test(argStr)) {
      throw new Error("Blocked: git push --force");
    }
    if (/config\s+.*(?:--global|--system)/.test(argStr)) {
      throw new Error("Blocked: git config --global/--system");
    }
  }

  if (binaryName === "python" || binaryName === "python3") {
    if (/(?:urllib|requests|httpx|aiohttp|socket|http\.client)\s*\./.test(argStr) ||
        /import\s+(?:urllib|requests|httpx|aiohttp|socket)/.test(argStr)) {
      throw new Error("Blocked: python inline network module usage");
    }
  }

  if (binaryName === "env") {
    if (!argStr.trim() || /^\s*$/.test(argStr)) {
      throw new Error("Blocked: bare 'env' dump (would leak secrets)");
    }
    if (/^\s*-[a-z]*i/.test(argStr)) {
      throw new Error("Blocked: env -i (could bypass variable isolation)");
    }
  }

  if (/\bprintenv\b/.test(cmd) || /\bset\s+\|/.test(cmd)) {
    throw new Error("Blocked: environment variable dump command");
  }

  if (/\bcat\b[^|]*\.env\b/.test(cmd)) {
    throw new Error("Blocked: reading .env file");
  }

  return cmd;
}

export function toOpenAiTools(tools: InternalTool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function dispatchNamedTool(
  tools: InternalTool[],
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(input);
}

export function buildTools(ctx: ToolContext): InternalTool[] {
  const ci = ctx.codeIntel;
  const sh = shellSingleQuote;

  return [
    {
      name: "read_file",
      description: "Read the contents of a file in the repository",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to repo root" } },
        required: ["path"],
      },
      handler: async input => {
        const p = String(input.path);
        ctx.sandbox.validateRepoPath(p);
        return ctx.sandbox.execForTools(`cat ${sh(p)} 2>&1 || echo FILE_NOT_FOUND`);
      },
    },
    {
      name: "read_file_range",
      description: "Read a specific range of lines from a file (e.g. around an error or a function). Much faster than reading the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
          start_line: { type: "number", description: "First line to read (1-based)" },
          end_line: { type: "number", description: "Last line to read (1-based)" },
        },
        required: ["path", "start_line", "end_line"],
      },
      handler: async input => {
        const p = String(input.path);
        ctx.sandbox.validateRepoPath(p);
        const start = Math.max(1, Number(input.start_line));
        const end = Math.max(start, Number(input.end_line));
        return ctx.sandbox.execForTools(`sed -n '${start},${end}p' ${sh(p)} 2>&1 || echo FILE_NOT_FOUND`);
      },
    },
    {
      name: "get_line_numbers",
      description: "Get the line numbers where a pattern appears in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          pattern: { type: "string", description: "Text to search for" },
        },
        required: ["path", "pattern"],
      },
      handler: async input => {
        const p = String(input.path);
        ctx.sandbox.validateRepoPath(p);
        return ctx.sandbox.execForTools(`grep -n ${sh(String(input.pattern))} ${sh(p)} 2>&1 || echo PATTERN_NOT_FOUND`);
      },
    },
    {
      name: "list_directory",
      description: "List files and directories at a path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path, default is repo root" },
          depth: { type: "number", description: "How deep to list, default 2" },
        },
        required: [],
      },
      handler: async input => {
        const dir = input.path != null ? String(input.path) : ".";
        const depth = typeof input.depth === "number" ? input.depth : 2;
        if (dir.startsWith("/") || dir.includes("..")) {
          throw new Error("Directory traversal blocked in list_directory");
        }
        return ctx.sandbox.execForTools(
          `find ${sh(dir)} -maxdepth ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100`
        );
      },
    },
    {
      name: "search_codebase",
      description: "Search for a string or regex pattern across files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          file_pattern: { type: "string", description: "Optional glob, e.g. '*.ts'" },
          use_regex: { type: "boolean", description: "Treat query as regex (default false)" },
        },
        required: ["query"],
      },
      handler: async input => {
        const query = String(input.query);
        const glob = input.file_pattern != null ? `--include=${sh(String(input.file_pattern))} ` : "";
        const regexFlag = input.use_regex === true ? "-E " : "-F ";
        return ctx.sandbox.execForTools(
          `grep -rn -i ${regexFlag}${glob}${sh(query)} --exclude-dir=node_modules --exclude-dir=.git . 2>&1 | head -50`
        );
      },
    },
    {
      name: "find_symbol",
      description: "Find where a function, class, or variable is defined across the entire repo.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async input => {
        const name = String(input.name);
        const symbols = await ci.findSymbol(name);
        if (symbols.length === 0) return `No symbol named '${name}' found.`;
        return symbols.map(s => `- ${s.name} (${s.type}) → ${s.file}:${s.line}`).join("\n");
      },
    },
    {
      name: "trace_imports",
      description: "Show which files import a given file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async input => {
        const importers = await ci.traceImports(String(input.path));
        if (importers.length === 0) return `No files import '${input.path}'.`;
        return `Files that import '${input.path}':\n${importers.map(f => `- ${f}`).join("\n")}`;
      },
    },
    {
      name: "rank_relevant_files",
      description: "Re-rank repository files by relevance to the current issue.",
      parameters: {
        type: "object",
        properties: { issue_title: { type: "string" }, issue_body: { type: "string" } },
        required: ["issue_title", "issue_body"],
      },
      handler: async input => {
        const ranked = await ci.rankRelevantFiles(String(input.issue_title), String(input.issue_body));
        return ranked.map(r => `- ${r.file} (score: ${r.score})`).join("\n");
      },
    },
    {
      name: "git_bisect",
      description: "Find the commit that introduced a regression using git bisect.",
      parameters: {
        type: "object",
        properties: {
          good_commit: { type: "string" },
          bad_commit: { type: "string", description: "Default: HEAD" },
          test_command: { type: "string" },
        },
        required: ["good_commit", "test_command"],
      },
      handler: async input => {
        const good = String(input.good_commit);
        const bad = String(input.bad_commit || "HEAD");
        const testCmd = String(input.test_command);
        return ctx.sandbox.execForTools(
          `git bisect start ${sh(bad)} ${sh(good)} && git bisect run ${sh(testCmd)} && git bisect reset`,
          300
        );
      },
    },
    {
      name: "debug_run",
      description: "Run a command with the language debugger to inspect state at crash.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          runtime: { type: "string", description: "node, python, go — auto-detected if omitted" },
        },
        required: ["command"],
      },
      handler: async input => {
        const cmd = sanitizeCommand(String(input.command));
        const rt = String(input.runtime || "auto").toLowerCase();
        let debugCmd: string;
        if (rt === "node" || (rt === "auto" && cmd.includes("node"))) {
          debugCmd = `node --inspect-brk=0.0.0.0:9229 ${cmd.replace(/^node\s+/, "")} 2>&1 || true`;
        } else if (rt === "python" || (rt === "auto" && (cmd.includes("python") || cmd.includes("pytest")))) {
          debugCmd = `python -m pdb -c 'continue' -c 'quit' ${cmd.replace(/^python\s+/, "")} 2>&1 || true`;
        } else if (rt === "go" || (rt === "auto" && cmd.includes("go "))) {
          debugCmd = `dlv debug -- ${cmd.replace(/^go\s+(run|test)\s+/, "")} 2>&1 || ${cmd} 2>&1 || true`;
        } else {
          debugCmd = `${cmd} 2>&1 || true`;
        }
        return ctx.sandbox.execForTools(debugCmd, 120);
      },
    },
    {
      name: "find_files",
      description: "Find files by name pattern (glob-style, e.g. '*.test.ts')",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      handler: async input => {
        return ctx.sandbox.execForTools(
          `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -name ${sh(String(input.pattern))} | head -50`
        );
      },
    },
    {
      name: "get_git_log",
      description: "Get recent git commits for a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "number", description: "Default 10" } },
        required: ["path"],
      },
      handler: async input => {
        const p = String(input.path);
        ctx.sandbox.validateRepoPath(p);
        const limit = typeof input.limit === "number" ? input.limit : 10;
        return ctx.sandbox.execForTools(`git log --oneline -${limit} -- ${sh(p)}`);
      },
    },
    {
      name: "run_command",
      description: "Run a shell command in the sandbox",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number", description: "Timeout seconds, default 60" },
        },
        required: ["command"],
      },
      handler: async input => {
        const command = sanitizeCommand(String(input.command));
        const timeout = typeof input.timeout === "number" ? input.timeout : 60;
        return ctx.sandbox.execForTools(command, timeout);
      },
    },
    {
      name: "remove_file",
      description: "Remove a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async input => ctx.sandbox.removeFile(String(input.path)),
    },
    {
      name: "write_file",
      description: "Write or overwrite a file with new content. Only use for new files or full rewrites — prefer patch_file for small edits.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async input => {
        await ctx.sandbox.writeFile(String(input.path), String(input.content));
        return `File written: ${input.path}`;
      },
    },
    {
      name: "patch_file",
      description: "Replace a unique substring in a file. Use this for small surgical edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_content: { type: "string" },
          new_content: { type: "string" },
        },
        required: ["path", "old_content", "new_content"],
      },
      handler: async input => {
        const filePath = String(input.path);
        ctx.sandbox.validateRepoPath(filePath);
        const oldContent = String(input.old_content);
        const newContent = String(input.new_content);
        const current = await ctx.sandbox.execForTools(`cat ${sh(filePath)}`);
        if (!current.includes(oldContent)) {
          return `ERROR: old_content not found in ${filePath}. Read the file first and match exactly. If this keeps failing, use replace_lines instead.`;
        }
        await ctx.sandbox.writeFile(filePath, current.replace(oldContent, newContent));
        return `Patched ${filePath} successfully`;
      },
    },
    {
      name: "replace_lines",
      description: "Replace a range of lines in a file with new content. More reliable than patch_file for multi-line changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number", description: "First line to replace (1-based, inclusive)" },
          end_line: { type: "number", description: "Last line to replace (1-based, inclusive)" },
          new_content: { type: "string" },
        },
        required: ["path", "start_line", "end_line", "new_content"],
      },
      handler: async input => {
        const filePath = String(input.path);
        ctx.sandbox.validateRepoPath(filePath);
        const start = Math.max(1, Number(input.start_line));
        const end = Math.max(start, Number(input.end_line));
        const current = await ctx.sandbox.execForTools(`cat ${sh(filePath)}`);
        const lines = current.split("\n");
        if (start > lines.length) return `ERROR: start_line ${start} exceeds file length (${lines.length}).`;
        const updated = [...lines.slice(0, start - 1), String(input.new_content), ...lines.slice(end)].join("\n");
        await ctx.sandbox.writeFile(filePath, updated);
        return `Replaced lines ${start}-${end} in ${filePath}`;
      },
    },
    {
      name: "append_to_file",
      description: "Append content to the end of a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async input => {
        const filePath = String(input.path);
        ctx.sandbox.validateRepoPath(filePath);
        const current = await ctx.sandbox.execForTools(`cat ${sh(filePath)}`);
        const needsNewline = current.length > 0 && !current.endsWith("\n");
        await ctx.sandbox.writeFile(filePath, current + (needsNewline ? "\n" : "") + String(input.content));
        return `Appended to ${filePath}`;
      },
    },
    {
      name: "format_code",
      description: "Auto-detect and run the project's code formatter on modified files.",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => ctx.sandbox.formatCode(),
    },
    {
      name: "run_tests",
      description: "Run the repository test suite. Call this BEFORE submit_fix to verify your fix.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "Optional test name filter" } },
        required: [],
      },
      handler: async input => {
        const filter = input.filter != null ? String(input.filter) : undefined;
        return JSON.stringify(await ctx.sandbox.runTests(filter));
      },
    },
    {
      name: "get_diff",
      description: "Show git diff for current workspace changes",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => ctx.sandbox.execForTools("git diff"),
    },
    {
      name: "search_open_prs",
      description: "Search open PR titles/bodies for keywords",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      handler: async input => {
        const query = String(input.query).toLowerCase();
        const { data } = await ctx.octokit.pulls.list({
          owner: ctx.repoOwner, repo: ctx.repoName, state: "open", per_page: 100,
        });
        const matched = data
          .filter(pr => pr.title.toLowerCase().includes(query) || (pr.body || "").toLowerCase().includes(query))
          .slice(0, 10);
        return JSON.stringify(matched.map(pr => ({ number: pr.number, title: pr.title, body: pr.body?.slice(0, 300), url: pr.html_url })));
      },
    },
    {
      name: "read_pr_diff",
      description: "Read the unified diff for an open PR",
      parameters: {
        type: "object",
        properties: { pr_number: { type: "number" } },
        required: ["pr_number"],
      },
      handler: async input => {
        const { data } = await ctx.octokit.pulls.get({
          owner: ctx.repoOwner, repo: ctx.repoName,
          pull_number: Number(input.pr_number),
          mediaType: { format: "diff" },
        });
        return (data as unknown as string).slice(0, 8000);
      },
    },
    {
      name: "submit_fix",
      description: "Signal that changes are ready for automated verification (runs tests + scoring)",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One-line commit message, imperative mood" },
          files_changed: { type: "array", items: { type: "string" }, description: "Paths modified" },
          what: { type: "string", description: "What this fix does (1-2 sentences)" },
          why: { type: "string", description: "Why this fix is needed — the root cause" },
          how: { type: "string", description: "How the fix was implemented — bullet points" },
        },
        required: ["summary", "files_changed", "what", "why", "how"],
      },
      handler: async input => {
        const result: AgentResult = {
          type: "fix_ready",
          summary: String(input.summary),
          changedPaths: Array.isArray(input.files_changed) ? input.files_changed.map(String) : [],
          what: String(input.what || ""),
          why: String(input.why || ""),
          how: String(input.how || ""),
        };
        return result;
      },
    },
  ];
}
