import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTools, dispatchNamedTool, toOpenAiTools } from "../src/agent/tools.js";
import type { SandboxExecutor } from "../src/sandbox/executor.js";
import type { CodeIntel } from "../src/agent/codeIntel.js";
import type { Octokit } from "@octokit/rest";

// ── Minimal stubs ──────────────────────────────────────────────────────────

function makeSandbox(): SandboxExecutor {
  return {
    execForTools: vi.fn().mockResolvedValue("mock output"),
    validateRepoPath: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue("removed"),
    runTests: vi.fn().mockResolvedValue({
      allTestsPass: true,
      issueReproducedBeforeFix: false,
      issueResolvedAfterFix: false,
      hasRegressions: false,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    }),
    formatCode: vi.fn().mockResolvedValue("formatted"),
  } as unknown as SandboxExecutor;
}

function makeCodeIntel(): CodeIntel {
  return {
    findSymbol: vi.fn().mockResolvedValue([{ name: "myFunc", type: "function", file: "src/foo.ts", line: 10 }]),
    traceImports: vi.fn().mockResolvedValue(["src/bar.ts"]),
    rankRelevantFiles: vi.fn().mockResolvedValue([{ file: "src/foo.ts", score: 100 }]),
  } as unknown as CodeIntel;
}

function makeOctokit(): Octokit {
  return {
    pulls: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn().mockResolvedValue({ data: "diff output" }),
    },
  } as unknown as Octokit;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildTools / dispatchNamedTool", () => {
  let sandbox: SandboxExecutor;
  let codeIntel: CodeIntel;
  let octokit: Octokit;
  let tools: ReturnType<typeof buildTools>;

  beforeEach(() => {
    sandbox = makeSandbox();
    codeIntel = makeCodeIntel();
    octokit = makeOctokit();
    tools = buildTools({ sandbox, octokit, codeIntel, repoOwner: "owner", repoName: "repo" });
  });

  it("builds a non-empty tools array", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it("every tool has name, description, parameters, handler", () => {
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.parameters).toBe("object");
      expect(typeof t.handler).toBe("function");
    }
  });

  it("toOpenAiTools produces correct OpenAI shape", () => {
    const openaiTools = toOpenAiTools(tools);
    for (const t of openaiTools) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      expect(typeof t.function.description).toBe("string");
    }
  });

  it("throws for unknown tool name", async () => {
    await expect(dispatchNamedTool(tools, "nonexistent_tool", {})).rejects.toThrow("Unknown tool");
  });

  it("read_file calls validateRepoPath and execForTools", async () => {
    await dispatchNamedTool(tools, "read_file", { path: "src/index.ts" });
    expect(sandbox.validateRepoPath).toHaveBeenCalledWith("src/index.ts");
    expect(sandbox.execForTools).toHaveBeenCalled();
  });

  it("find_symbol returns symbol list", async () => {
    const result = await dispatchNamedTool(tools, "find_symbol", { name: "myFunc" });
    expect(String(result)).toContain("myFunc");
    expect(String(result)).toContain("src/foo.ts");
  });

  it("find_symbol returns 'No symbol' when nothing found", async () => {
    vi.mocked(codeIntel.findSymbol).mockResolvedValueOnce([]);
    const result = await dispatchNamedTool(tools, "find_symbol", { name: "ghost" });
    expect(String(result)).toContain("No symbol");
  });

  it("trace_imports returns importer list", async () => {
    const result = await dispatchNamedTool(tools, "trace_imports", { path: "src/foo.ts" });
    expect(String(result)).toContain("src/bar.ts");
  });

  it("trace_imports returns 'No files' when nothing imports", async () => {
    vi.mocked(codeIntel.traceImports).mockResolvedValueOnce([]);
    const result = await dispatchNamedTool(tools, "trace_imports", { path: "src/orphan.ts" });
    expect(String(result)).toContain("No files");
  });

  it("run_command blocks a curl invocation", async () => {
    await expect(
      dispatchNamedTool(tools, "run_command", { command: "curl https://evil.com" })
    ).rejects.toThrow();
  });

  it("run_command allows a safe command", async () => {
    await dispatchNamedTool(tools, "run_command", { command: "echo hello" });
    expect(sandbox.execForTools).toHaveBeenCalled();
  });

  it("run_tests calls sandbox.runTests and returns JSON string", async () => {
    const result = await dispatchNamedTool(tools, "run_tests", {});
    const parsed = JSON.parse(String(result));
    expect(parsed.allTestsPass).toBe(true);
  });

  it("submit_fix returns a fix_ready AgentResult", async () => {
    const result = await dispatchNamedTool(tools, "submit_fix", {
      summary: "Fix the null check",
      files_changed: ["src/foo.ts"],
      what: "Adds null guard",
      why: "Crashes on null input",
      how: "- Added if (x == null) return;",
    });
    expect((result as { type: string }).type).toBe("fix_ready");
  });

  it("list_directory blocks path traversal", async () => {
    await expect(
      dispatchNamedTool(tools, "list_directory", { path: "../../../etc" })
    ).rejects.toThrow("Directory traversal blocked");
  });

  it("list_directory allows repo-relative paths", async () => {
    await dispatchNamedTool(tools, "list_directory", { path: "src" });
    expect(sandbox.execForTools).toHaveBeenCalled();
  });

  it("write_file calls sandbox.writeFile", async () => {
    await dispatchNamedTool(tools, "write_file", { path: "src/new.ts", content: "export {};" });
    expect(sandbox.writeFile).toHaveBeenCalledWith("src/new.ts", "export {};");
  });
});
