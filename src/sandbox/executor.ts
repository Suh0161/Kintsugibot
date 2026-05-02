import { Sandbox } from "e2b";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { shellSingleQuote } from "../utils/shell.js";
import type { TestResult } from "../agent/types.js";

/** Max file write size to prevent disk exhaustion (1 MB). */
const MAX_FILE_WRITE_BYTES = 1_000_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SandboxOptions {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  timeoutMs?: number;
}

export class SandboxExecutor {
  private sandbox: Sandbox | null = null;
  private repoOwner: string;
  private repoName: string;
  private githubToken: string;
  private timeoutMs: number;
  private runtime = "unknown";
  /** Tracks files the bot explicitly touched so format_code only targets them. */
  private modifiedFiles = new Set<string>();

  constructor(opts: SandboxOptions) {
    this.repoOwner = opts.repoOwner;
    this.repoName = opts.repoName;
    this.githubToken = opts.githubToken;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  }

  async boot() {
    logger.info({ repo: `${this.repoOwner}/${this.repoName}` }, "Booting sandbox");

    this.sandbox = await Sandbox.create({
      timeoutMs: this.timeoutMs,
    });

    const authedCloneUrl = `https://x-access-token:${this.githubToken}@github.com/${this.repoOwner}/${this.repoName}.git`;
    const cleanRemoteUrl = `https://github.com/${this.repoOwner}/${this.repoName}.git`;

    await this.sandbox.commands.run("mkdir -p /home/user/repo", { timeoutMs: 10000 });
    await this.execChecked(`git clone ${shellSingleQuote(authedCloneUrl)} /home/user/repo --depth=50`, 120);
    // Strip token from remote so the LLM can't extract it via git remote -v
    await this.execChecked(`git -C /home/user/repo remote set-url origin ${shellSingleQuote(cleanRemoteUrl)}`, 30);

    this.runtime = await this.detectRuntime();
    logger.info({ runtime: this.runtime }, "Runtime detected");

    await this.installDeps();
    logger.info("Sandbox ready");
  }

  async exec(command: string, timeoutSeconds = 60): Promise<ExecResult> {
    if (!this.sandbox) throw new Error("Sandbox not booted");
    const result = await this.sandbox.commands.run(command, {
      cwd: "/home/user/repo",
      timeoutMs: timeoutSeconds * 1000,
    });
    return {
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      exitCode: result.exitCode ?? 0,
    };
  }

  /** Convenience: returns stdout (and stderr on failure) for tool responses. */
  async execForTools(command: string, timeoutSeconds = 60): Promise<string> {
    const r = await this.exec(command, timeoutSeconds);
    if (r.exitCode === 0) return r.stdout;
    const tail = [r.stdout, r.stderr].filter(Boolean).join("\n");
    return `${tail}\n[exit code ${r.exitCode}]`.trim();
  }

  /** Like exec() but throws if the command exits non-zero. */
  async execChecked(command: string, timeoutSeconds = 60): Promise<ExecResult> {
    const r = await this.exec(command, timeoutSeconds);
    if (r.exitCode !== 0) {
      const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      throw new Error(
        `Command failed (exit ${r.exitCode}): ${command.slice(0, 80)}${output ? `\n${output}` : ""}`
      );
    }
    return r;
  }

  /** Resolve a repo-relative path and block traversal outside /home/user/repo. */
  private resolveRepoPath(relPath: string): string {
    const normalized = relPath.replace(/^\/+/, "").replace(/\\/g, "/");
    const base = "/home/user/repo";
    const resolved = path.posix.resolve(base, normalized);
    if (!resolved.startsWith(base + "/") && resolved !== base) {
      throw new Error(`Path traversal blocked: ${relPath} resolves to ${resolved}`);
    }
    return resolved;
  }

  /** Public validation helper for tool handlers. */
  validateRepoPath(relPath: string): string {
    return this.resolveRepoPath(relPath);
  }

  async writeFile(relPath: string, content: string) {
    if (!this.sandbox) throw new Error("Sandbox not booted");

    if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
      throw new Error(`File write too large: ${relPath} exceeds ${MAX_FILE_WRITE_BYTES} bytes`);
    }

    const resolved = this.resolveRepoPath(relPath);
    const repoRel = path.posix.relative("/home/user/repo", resolved);
    this.modifiedFiles.add(repoRel);

    await this.sandbox.files.write(resolved, content);
  }

  async readFile(relPath: string): Promise<string> {
    if (!this.sandbox) throw new Error("Sandbox not booted");
    const resolved = this.resolveRepoPath(relPath);
    return await this.sandbox.files.read(resolved);
  }

  /** Remove a file and track it as a modification. */
  async removeFile(relPath: string): Promise<string> {
    const resolved = this.resolveRepoPath(relPath);
    const repoRel = path.posix.relative("/home/user/repo", resolved);
    this.modifiedFiles.add(repoRel);
    await this.execForTools(`rm ${shellSingleQuote(resolved)}`);
    return `Removed ${repoRel}`;
  }

  /** Return the list of files the bot has explicitly modified. */
  getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }

  /** Push a branch to origin without leaking the token in git remote -v. */
  async pushBranch(branchName: string): Promise<void> {
    const pushUrl = `https://x-access-token:${this.githubToken}@github.com/${this.repoOwner}/${this.repoName}.git`;
    await this.execChecked(`git -C /home/user/repo push -u ${shellSingleQuote(pushUrl)} ${shellSingleQuote(branchName)}`, 60);
  }

  async runTests(filter?: string): Promise<TestResult> {
    const testCmd = this.buildTestCommand(filter);
    logger.info({ testCmd, runtime: this.runtime }, "Running tests");

    try {
      const result = await this.exec(testCmd, 300);

      const fullOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
      await this.exec(`printf '%s' ${shellSingleQuote(fullOutput)} > /tmp/last_test_output.txt`, 10);

      const noTestsIndicators = [
        "no tests found", "no test files found", "could not find any test files",
        "no test runner detected", "no tests matched",
      ];
      const outputLower = `${result.stdout} ${result.stderr}`.toLowerCase();
      const hasNoTests = noTestsIndicators.some(ind => outputLower.includes(ind));

      if (hasNoTests) {
        return {
          allTestsPass: true, issueReproducedBeforeFix: false,
          issueResolvedAfterFix: true, hasRegressions: false,
          stdout: result.stdout, stderr: result.stderr, exitCode: 0,
        };
      }

      const passed = result.exitCode === 0;
      return {
        allTestsPass: passed, issueReproducedBeforeFix: false,
        issueResolvedAfterFix: passed, hasRegressions: !passed,
        stdout: result.stdout, stderr: result.stderr || `(exit ${result.exitCode})`,
        exitCode: result.exitCode,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        allTestsPass: false, issueReproducedBeforeFix: false,
        issueResolvedAfterFix: false, hasRegressions: true,
        stdout: message, stderr: message, exitCode: 1,
      };
    }
  }

  async formatCode(): Promise<string> {
    const files = this.getModifiedFiles();
    if (files.length === 0) return "No modified files to format";

    const fileArgs = files.map(f => shellSingleQuote(f)).join(" ");
    const formatters: Record<string, string> = {
      node: `npx prettier --write ${fileArgs} 2>&1 | tail -10 || true`,
      python: `(black ${fileArgs} 2>&1 || ruff format ${fileArgs} 2>&1) | tail -10 || true`,
      go: `gofmt -w ${fileArgs} 2>&1 || true`,
      rust: `rustfmt ${fileArgs} 2>&1 || true`,
      ruby: `rubocop -A ${fileArgs} 2>&1 | tail -10 || true`,
      java: "true",
      php: `php-cs-fixer fix ${fileArgs} 2>&1 | tail -10 || true`,
      swift: `swiftformat ${fileArgs} 2>&1 | tail -10 || true`,
      dart: `dart format ${fileArgs} 2>&1 | tail -10 || true`,
      elixir: `mix format ${fileArgs} 2>&1 | tail -10 || true`,
      cpp: `clang-format -i ${fileArgs} 2>&1 | tail -10 || true`,
      dotnet: `dotnet format ${fileArgs} 2>&1 | tail -10 || true`,
      unknown: "true",
    };

    const cmd = formatters[this.runtime] || "true";
    logger.info({ runtime: this.runtime, fileCount: files.length }, "Running formatter");
    const r = await this.exec(cmd, 120);
    return r.stdout || "(no output)";
  }

  async analyzeCode(): Promise<string> {
    const analyzers: Record<string, string> = {
      node: "npx tsc --noEmit 2>&1 | tail -30 || true",
      python: "ruff check . 2>&1 | tail -20 || python -m py_compile $(find . -name '*.py' | head -20) 2>&1 | tail -20 || true",
      go: "go vet ./... 2>&1 | tail -20 || true",
      rust: "cargo check 2>&1 | tail -30 || true",
      ruby: "bundle exec rubocop --format simple 2>&1 | tail -20 || true",
      java: "true",
      php: "php -l $(find . -name '*.php' | head -20) 2>&1 | tail -20 || true",
      swift: "swift build 2>&1 | tail -20 || true",
      dart: "dart analyze 2>&1 | tail -20 || true",
      elixir: "mix compile --warnings-as-errors 2>&1 | tail -20 || true",
      cpp: "cppcheck --error-exitcode=1 . 2>&1 | tail -20 || true",
      dotnet: "dotnet build 2>&1 | tail -30 || true",
      unknown: "true",
    };

    const cmd = analyzers[this.runtime] || "true";
    logger.info({ runtime: this.runtime }, "Running static analysis");
    try {
      const r = await this.exec(cmd, 120);
      const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      if (r.exitCode !== 0 && output) return output;
      if (output && !output.includes("error") && !output.includes("Error") && !output.includes("warning")) return "";
      return output;
    } catch {
      return "";
    }
  }

  async destroy() {
    if (!this.sandbox) return;
    try {
      await this.sandbox.kill();
      logger.info("Sandbox destroyed");
    } catch (err) {
      logger.warn({ err }, "Failed to cleanly destroy sandbox");
    }
    this.sandbox = null;
  }

  private async detectRuntime(): Promise<string> {
    const r = await this.exec("ls /home/user/repo");
    const listing = r.stdout;
    if (listing.includes("package.json")) return "node";
    if (listing.includes("requirements.txt") || listing.includes("pyproject.toml")) return "python";
    if (listing.includes("go.mod")) return "go";
    if (listing.includes("Cargo.toml")) return "rust";
    if (listing.includes("pom.xml") || listing.includes("build.gradle")) return "java";
    if (listing.includes("Gemfile")) return "ruby";
    if (listing.includes("composer.json")) return "php";
    if (listing.includes("Package.swift")) return "swift";
    if (listing.includes("pubspec.yaml")) return "dart";
    if (listing.includes("mix.exs")) return "elixir";
    if (listing.includes("CMakeLists.txt") || listing.includes("Makefile")) return "cpp";
    if (listing.includes(".csproj") || listing.includes(".fsproj")) return "dotnet";
    return "unknown";
  }

  private async installDeps() {
    const cmds: Record<string, string> = {
      node: "npm install --prefer-offline 2>&1 | tail -20",
      python: "(pip install -r requirements.txt || pip install -e .) 2>&1 | tail -20",
      go: "go mod download 2>&1 | tail -20",
      rust: "cargo fetch 2>&1 | tail -20",
      java: "true",
      ruby: "bundle install 2>&1 | tail -20",
      php: "composer install --no-interaction 2>&1 | tail -20 || true",
      swift: "swift package resolve 2>&1 | tail -20 || true",
      dart: "dart pub get 2>&1 | tail -20 || true",
      elixir: "mix deps.get 2>&1 | tail -20 || true",
      cpp: "true",
      dotnet: "dotnet restore 2>&1 | tail -20 || true",
    };

    const cmd = cmds[this.runtime];
    if (cmd) {
      logger.info({ runtime: this.runtime }, "Installing dependencies");
      await this.exec(cmd, 180);
    }
  }

  private buildTestCommand(filter?: string): string {
    const sh = shellSingleQuote;
    switch (this.runtime) {
      case "node":
        return filter
          ? `npx jest --testNamePattern=${sh(filter)} 2>&1 || npx vitest run --reporter=verbose 2>&1`
          : `npx jest 2>&1 || npx vitest run 2>&1 || npm test 2>&1`;
      case "python": return filter ? `pytest -k ${sh(filter)} -v 2>&1` : `pytest -v 2>&1`;
      case "go": return filter ? `go test ./... -run ${sh(filter)} -v 2>&1` : `go test ./... 2>&1`;
      case "rust": return filter ? `cargo test ${sh(filter)} 2>&1` : `cargo test 2>&1`;
      case "ruby": return filter ? `bundle exec rspec --example ${sh(filter)} 2>&1` : `bundle exec rspec 2>&1`;
      case "php": return `vendor/bin/phpunit 2>&1 || composer test 2>&1`;
      case "swift": return filter ? `swift test --filter ${sh(filter)} 2>&1` : `swift test 2>&1`;
      case "dart": return filter ? `dart test --name=${sh(filter)} 2>&1` : `dart test 2>&1`;
      case "elixir": return filter ? `mix test --grep ${sh(filter)} 2>&1` : `mix test 2>&1`;
      case "cpp": return `make test 2>&1 || ctest 2>&1 || echo "No C++ test runner detected" 1>&2; exit 2`;
      case "dotnet": return filter ? `dotnet test --filter=${sh(filter)} 2>&1` : `dotnet test 2>&1`;
      default: return `echo "No test runner detected" 1>&2; exit 2`;
    }
  }
}
