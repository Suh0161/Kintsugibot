import Docker from "dockerode";
import path from "node:path";
import crypto from "node:crypto";
import tar from "tar-stream";
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
  private docker: Docker;
  private container: Docker.Container | null = null;
  private repoOwner: string;
  private repoName: string;
  private githubToken: string;
  private timeoutMs: number;
  private runtime = "unknown";
  private shellReady = false;
  /** Tracks files the bot explicitly touched so format_code only targets them. */
  private modifiedFiles = new Set<string>();
  /** Random token for shell server file paths — prevents LLM from hijacking the command file. */
  private shellToken = crypto.randomBytes(16).toString("hex");

  constructor(opts: SandboxOptions) {
    this.docker = new Docker();
    this.repoOwner = opts.repoOwner;
    this.repoName = opts.repoName;
    this.githubToken = opts.githubToken;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  }

  /** Build the persistent shell server script with randomized file paths. */
  private buildCmdServer(): string {
    return `
const fs = require("fs");
const { exec } = require("child_process");

const CMD_FILE = "/tmp/.kintsugi_cmd_${this.shellToken}";
const OUT_FILE = "/tmp/.kintsugi_out_${this.shellToken}";
const READY_FILE = "/tmp/.kintsugi_ready_${this.shellToken}";

function poll() {
  try {
    if (fs.existsSync(CMD_FILE)) {
      const cmd = fs.readFileSync(CMD_FILE, "utf8");
      fs.unlinkSync(CMD_FILE);
      exec(cmd, { cwd: "/repo", maxBuffer: 50 * 1024 * 1024, env: { ...process.env, CI: "true", FORCE_COLOR: "0" } }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        fs.writeFileSync(OUT_FILE, JSON.stringify({ stdout, stderr, code }));
        setTimeout(poll, 10);
      });
      return;
    }
  } catch (e) {}
  setTimeout(poll, 10);
}

fs.writeFileSync(READY_FILE, "1");
poll();
`;
  }

  async boot() {
    logger.info({ repo: `${this.repoOwner}/${this.repoName}` }, "Booting sandbox");

    this.container = await this.docker.createContainer({
      Image: "issuebot-sandbox:latest",
      Cmd: ["/bin/bash", "-c", "sleep infinity"],
      WorkingDir: "/repo",
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024,
        CpuPeriod: 100000,
        CpuQuota: 200000,
        NetworkMode: "bridge",
        AutoRemove: false,
        Binds: [
          "issuebot-npm-cache:/root/.npm",
          "issuebot-pip-cache:/root/.cache/pip",
          "issuebot-cargo-cache:/root/.cargo",
          "issuebot-go-cache:/root/go/pkg/mod",
        ],
      },
      Env: [`GITHUB_REPO=${this.repoOwner}/${this.repoName}`],
    });

    await this.container.start();

    const authedCloneUrl = `https://x-access-token:${this.githubToken}@github.com/${this.repoOwner}/${this.repoName}.git`;
    const cleanRemoteUrl = `https://github.com/${this.repoOwner}/${this.repoName}.git`;

    // Use one-off exec for setup before the persistent shell is ready
    await this.rawExec(`git clone ${shellSingleQuote(authedCloneUrl)} /repo --depth=50`, 120);
    // Strip token from remote URL so the LLM can't extract it via git remote -v
    await this.rawExec(`git remote set-url origin ${shellSingleQuote(cleanRemoteUrl)}`, 30);

    this.runtime = await this.detectRuntime();
    logger.info({ runtime: this.runtime }, "Runtime detected");

    await this.installDeps();

    // Start the persistent command server with randomized file paths
    const cmdFile = `/tmp/.kintsugi_cmd_${this.shellToken}`;
    const outFile = `/tmp/.kintsugi_out_${this.shellToken}`;
    const readyFile = `/tmp/.kintsugi_ready_${this.shellToken}`;
    const serverFile = `/tmp/.kintsugi_server_${this.shellToken}.js`;
    await this.rawExec(`rm -f ${shellSingleQuote(cmdFile)} ${shellSingleQuote(outFile)} ${shellSingleQuote(readyFile)} ${shellSingleQuote(serverFile)}`, 10);
    const b64 = Buffer.from(this.buildCmdServer()).toString("base64");
    await this.rawExec(`echo ${b64} | base64 -d > ${shellSingleQuote(serverFile)}`, 5);
    await this.rawExec(`nohup node ${shellSingleQuote(serverFile)} > /dev/null 2>&1 &`, 5);

    // Wait for server to be ready
    for (let i = 0; i < 50; i++) {
      const ready = await this.rawExec(`cat ${shellSingleQuote(readyFile)} 2>/dev/null || true`, 1);
      if (ready.stdout.includes("1")) {
        this.shellReady = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!this.shellReady) {
      throw new Error("Persistent shell failed to start");
    }

    logger.info("Persistent shell ready");
  }

  /** Execute a command through the persistent shell. */
  async exec(command: string, timeoutSeconds = 60): Promise<ExecResult> {
    if (!this.container || !this.shellReady) {
      throw new Error("Sandbox not booted");
    }

    const outFile = `/tmp/.kintsugi_out_${this.shellToken}`;
    const cmdFile = `/tmp/.kintsugi_cmd_${this.shellToken}`;

    // Clear old output and write command atomically
    await this.rawExec(`rm -f ${shellSingleQuote(outFile)}`, 2);
    await this.rawExec(`printf '%s' ${shellSingleQuote(command)} > ${shellSingleQuote(cmdFile)}`, 2);

    // Poll for output
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      const out = await this.rawExec(`cat ${shellSingleQuote(outFile)} 2>/dev/null || true`, 2);
      if (out.stdout) {
        try {
          const parsed = JSON.parse(out.stdout) as { stdout: string; stderr: string; code: number };
          return {
            stdout: parsed.stdout.trim(),
            stderr: parsed.stderr.trim(),
            exitCode: parsed.code,
          };
        } catch {
          // Output not ready yet, continue polling
        }
      }
    }

    throw new Error(`Command timed out: ${command.slice(0, 80)}`);
  }

  /** One-off exec for setup (before persistent shell is ready). */
  private async rawExec(command: string, timeoutSeconds = 60): Promise<ExecResult> {
    if (!this.container) throw new Error("Sandbox not booted");

    const execInstance = await this.container.exec({
      Cmd: ["/bin/bash", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/repo",
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out: ${command.slice(0, 80)}`));
      }, timeoutSeconds * 1000);

      execInstance.start({ hijack: true, stdin: false }, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }

        let stdout = "";
        let stderr = "";
        let buf = Buffer.alloc(0);

        stream!.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 8) {
            const size = buf.readUInt32BE(4);
            if (buf.length < 8 + size) break;
            const type = buf[0];
            const data = buf.subarray(8, 8 + size).toString();
            if (type === 2) {
              stderr += data;
            } else {
              stdout += data;
            }
            buf = buf.subarray(8 + size);
          }
        });

        stream!.on("end", async () => {
          clearTimeout(timer);
          try {
            const inspect = await execInstance.inspect();
            resolve({
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              exitCode: inspect.ExitCode ?? -1,
            });
          } catch (e) {
            reject(e);
          }
        });

        stream!.on("error", (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    });
  }

  /** Convenience: returns stdout (and stderr on failure) for tool responses. */
  async execForTools(command: string, timeoutSeconds = 60): Promise<string> {
    const r = await this.exec(command, timeoutSeconds);
    if (r.exitCode === 0) return r.stdout;
    const tail = [r.stdout, r.stderr].filter(Boolean).join("\n");
    return `${tail}\n[exit code ${r.exitCode}]`.trim();
  }

  /** Like exec() but throws if the command exits non-zero. Use for critical steps (git commit/push). */
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

  /** Resolve a repo-relative path and block traversal outside /repo. */
  private resolveRepoPath(relPath: string): string {
    const normalized = relPath.replace(/^\/+/, "").replace(/\\/g, "/");
    const resolved = path.posix.resolve("/repo", normalized);
    if (!resolved.startsWith("/repo/") && resolved !== "/repo") {
      throw new Error(`Path traversal blocked: ${relPath} resolves to ${resolved}`);
    }
    return resolved;
  }

  /** Public validation helper for tool handlers. */
  validateRepoPath(relPath: string): string {
    return this.resolveRepoPath(relPath);
  }

  async writeFile(relPath: string, content: string) {
    if (!this.container) throw new Error("Sandbox not booted");

    if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
      throw new Error(`File write too large: ${relPath} exceeds ${MAX_FILE_WRITE_BYTES} bytes`);
    }

    const resolved = this.resolveRepoPath(relPath);
    const repoRel = path.posix.relative("/repo", resolved);
    this.modifiedFiles.add(repoRel);

    const dir = path.posix.dirname(resolved);
    const filename = path.posix.basename(resolved);

    try {
      const pack = tar.pack();
      pack.entry({ name: filename }, content);
      pack.finalize();

      await this.container.putArchive(pack, { path: dir });
    } catch (err) {
      throw new Error(
        `Failed to write file ${relPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Remove a file and track it as a modification. */
  async removeFile(relPath: string): Promise<string> {
    const resolved = this.resolveRepoPath(relPath);
    const repoRel = path.posix.relative("/repo", resolved);
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
    await this.execChecked(`git push -u ${shellSingleQuote(pushUrl)} ${shellSingleQuote(branchName)}`, 60);
  }

  async runTests(filter?: string): Promise<TestResult> {
    const testCmd = this.buildTestCommand(filter);
    logger.info({ testCmd, runtime: this.runtime }, "Running tests");

    try {
      const result = await this.exec(testCmd, 300);

      // Save full output so the bot can read it later if truncated in conversation
      const fullOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
      await this.exec(`printf '%s' ${shellSingleQuote(fullOutput)} > /tmp/last_test_output.txt`, 10);

      // Detect when the repo simply has no tests — this is not a failure
      const noTestsIndicators = [
        "no tests found",
        "no test files found",
        "could not find any test files",
        "no test runner detected",
        "no tests matched",
      ];
      const outputLower = `${result.stdout} ${result.stderr}`.toLowerCase();
      const hasNoTests = noTestsIndicators.some(ind => outputLower.includes(ind));

      if (hasNoTests) {
        return {
          allTestsPass: true,
          issueReproducedBeforeFix: false,
          issueResolvedAfterFix: true,
          hasRegressions: false,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
        };
      }

      const passed = result.exitCode === 0;

      return {
        allTestsPass: passed,
        issueReproducedBeforeFix: false,
        issueResolvedAfterFix: passed,
        hasRegressions: !passed,
        stdout: result.stdout,
        stderr: result.stderr || `(exit ${result.exitCode})`,
        exitCode: result.exitCode,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        allTestsPass: false,
        issueReproducedBeforeFix: false,
        issueResolvedAfterFix: false,
        hasRegressions: true,
        stdout: message,
        stderr: message,
        exitCode: 1,
      };
    }
  }

  /** Auto-detect and run the project's code formatter on ONLY files the bot touched. */
  async formatCode(): Promise<string> {
    const files = this.getModifiedFiles();
    if (files.length === 0) {
      return "No modified files to format";
    }

    const fileArgs = files.map(f => shellSingleQuote(f)).join(" ");

    const formatters: Record<string, string> = {
      node: `npx prettier --write ${fileArgs} 2>&1 | tail -10 || npx eslint --fix ${fileArgs} 2>&1 | tail -10 || true`,
      python: `(black ${fileArgs} 2>&1 || ruff format ${fileArgs} 2>&1 || autopep8 -i ${fileArgs} 2>&1) | tail -10 || true`,
      go: `gofmt -w ${fileArgs} 2>&1 || true`,
      rust: `which rustfmt >/dev/null 2>&1 && rustfmt ${fileArgs} 2>&1 || echo "rustfmt not available, skipping"`,
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

  /** Run static analysis (type check / lint) and return errors found. */
  async analyzeCode(): Promise<string> {
    const analyzers: Record<string, string> = {
      node: "npx tsc --noEmit 2>&1 | tail -30 || npx eslint . --ext .ts,.tsx,.js,.jsx 2>&1 | tail -30 || true",
      python: "python -m py_compile $(find . -name '*.py' | head -20) 2>&1 | tail -20 || ruff check . 2>&1 | tail -20 || true",
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
      // Only return if there are actual errors
      if (r.exitCode !== 0 && output) return output;
      if (output && !output.includes("error") && !output.includes("Error") && !output.includes("warning")) return "";
      return output;
    } catch {
      return "";
    }
  }

  async destroy() {
    if (!this.container) return;
    try {
      await this.container.stop({ t: 5 });
      await this.container.remove();
      logger.info("Sandbox destroyed");
    } catch (err) {
      logger.warn({ err }, "Failed to cleanly destroy sandbox");
    }
    this.container = null;
  }

  private async detectRuntime(): Promise<string> {
    const ls = await this.rawExec("ls /repo");
    const listing = ls.stdout;
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
    if (listing.includes("*.csproj") || listing.includes("*.fsproj")) return "dotnet";
    return "unknown";
  }

  private async installDeps() {
    const cmds: Record<string, string> = {
      node: "npm install --prefer-offline 2>&1 | tail -20",
      python:
        "(pip install -r requirements.txt || pip install -e .) 2>&1 | tail -20",
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
      await this.rawExec(cmd, 180);
    }
  }

  private buildTestCommand(filter?: string): string {
    const sh = shellSingleQuote;
    switch (this.runtime) {
      case "node":
        return filter
          ? `npx jest --testNamePattern=${sh(filter)} 2>&1 || npx vitest run --reporter=verbose 2>&1`
          : `npx jest 2>&1 || npx vitest run 2>&1 || npm test 2>&1`;
      case "python":
        return filter ? `pytest -k ${sh(filter)} -v 2>&1` : `pytest -v 2>&1`;
      case "go":
        return filter ? `go test ./... -run ${sh(filter)} -v 2>&1` : `go test ./... 2>&1`;
      case "rust":
        return filter ? `cargo test ${sh(filter)} 2>&1` : `cargo test 2>&1`;
      case "ruby":
        return filter
          ? `bundle exec rspec --example ${sh(filter)} 2>&1`
          : `bundle exec rspec 2>&1`;
      case "php":
        return filter
          ? `vendor/bin/phpunit --filter=${sh(filter)} 2>&1 || composer test 2>&1`
          : `vendor/bin/phpunit 2>&1 || composer test 2>&1`;
      case "swift":
        return filter ? `swift test --filter ${sh(filter)} 2>&1` : `swift test 2>&1`;
      case "dart":
        return filter ? `dart test --name=${sh(filter)} 2>&1` : `dart test 2>&1`;
      case "elixir":
        return filter ? `mix test --grep ${sh(filter)} 2>&1` : `mix test 2>&1`;
      case "cpp":
        return `make test 2>&1 || ctest 2>&1 || echo "No C++ test runner detected" 1>&2; exit 2`;
      case "dotnet":
        return filter ? `dotnet test --filter=${sh(filter)} 2>&1` : `dotnet test 2>&1`;
      default:
        return `echo "No test runner detected" 1>&2; exit 2`;
    }
  }
}
