import type { Octokit } from "@octokit/rest";
import type { AgentResult } from "../agent/types.js";
import type { SandboxExecutor } from "../sandbox/executor.js";
import type { RankedPR } from "./prRanker.js";
import { logger } from "../utils/logger.js";
import { shellSingleQuote } from "../utils/shell.js";

const BOT_NAME = process.env.BOT_NAME?.trim() || "KintsugiBot";
const BOT_EMAIL = process.env.BOT_GIT_EMAIL?.trim() || "kintsugibot@users.noreply.github.com";
const BRANCH_PREFIX = process.env.BOT_BRANCH_PREFIX?.trim() || "kintsugi";
import {
  highConfidenceIssueComment,
  draftIssueComment,
  lowConfidenceComment,
  noFixComment,
  noResultComment,
  investigationComment,
  alreadyFixedComment,
  ciFailureComment,
  buildPRBody,
} from "./messages.js";

interface DispatchOptions {
  octokit: Octokit;
  repoOwner: string;
  repoName: string;
}

interface DispatchInput {
  issueNumber: number;
  issueTitle: string;
  agentResult: AgentResult | null;
  sandbox: SandboxExecutor;
  relevantPRs: RankedPR[];
}

export class ActionDispatcher {
  private octokit: Octokit;
  private repoOwner: string;
  private repoName: string;
  private defaultBranchPromise: Promise<string> | null = null;

  constructor(opts: DispatchOptions) {
    this.octokit = opts.octokit;
    this.repoOwner = opts.repoOwner;
    this.repoName = opts.repoName;
  }

  private async defaultBranch(): Promise<string> {
    if (!this.defaultBranchPromise) {
      this.defaultBranchPromise = this.octokit.repos
        .get({ owner: this.repoOwner, repo: this.repoName })
        .then(r => r.data.default_branch);
    }
    return this.defaultBranchPromise;
  }

  async dispatch({ issueNumber, issueTitle, agentResult, sandbox, relevantPRs }: DispatchInput) {
    if (!agentResult) {
      await this.postNoResult(issueNumber);
      return;
    }

    const confidence = agentResult.confidence ?? 0;
    logger.info({ issueNumber, confidence, type: agentResult.type }, "Dispatching action");

    if (agentResult.type === "fix_ready" && agentResult.testResult) {
      const { testResult } = agentResult;

      if (!agentResult.changedPaths || agentResult.changedPaths.length === 0) {
        logger.warn({ issueNumber, confidence }, "Fix reported but no changed paths; downgrading to comment");
        await this.lowConfidenceAction(issueNumber, agentResult, testResult.stdout);
        return;
      }

      if (confidence >= 85) {
        await this.highConfidenceAction(issueNumber, issueTitle, agentResult, sandbox);
      } else if (confidence >= 50) {
        await this.mediumConfidenceAction(issueNumber, issueTitle, agentResult, sandbox);
      } else {
        await this.lowConfidenceAction(issueNumber, agentResult, testResult.stdout);
      }
    } else if (agentResult.type === "no_fix") {
      await this.postNoFix(issueNumber, agentResult, relevantPRs);
    } else {
      await this.postInvestigationFindings(issueNumber, agentResult);
    }
  }

  private async highConfidenceAction(issueNumber: number, issueTitle: string, result: AgentResult, sandbox: SandboxExecutor) {
    const base = await this.defaultBranch();
    const branchName = `${BRANCH_PREFIX}/fix-issue-${issueNumber}`;

    await sandbox.execChecked(`git checkout -B ${shellSingleQuote(branchName)}`);
    await sandbox.execChecked(`git config user.email ${shellSingleQuote(BOT_EMAIL)}`);
    await sandbox.execChecked(`git config user.name ${shellSingleQuote(BOT_NAME)}`);
    await sandbox.formatCode();
    const committed = await this.commitOnly(result.changedPaths ?? [], this.buildCommitMessage(issueNumber, issueTitle, result), sandbox);
    if (!committed) {
      logger.warn({ issueNumber }, "Nothing to commit after staging — issue appears already fixed");
      await this.postAlreadyFixed(issueNumber, result);
      return;
    }
    await sandbox.pushBranch(branchName);

    const title = this.buildPRTitle(issueNumber, issueTitle, result, false);
    const { data: pr } = await this.octokit.pulls.create({
      owner: this.repoOwner,
      repo: this.repoName,
      title,
      body: this.buildPRBody(issueNumber, result, branchName, false),
      head: branchName,
      base,
    });

    await this.octokit.issues.addLabels({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: pr.number,
      labels: ["bot-fix", "high-confidence"],
    });

    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: highConfidenceIssueComment(pr.number, result),
    });

    // Fire-and-forget CI check — if checks fail, post a follow-up comment
    this.checkCIAndReport(issueNumber, pr.number, branchName).catch(() => {});

    logger.info({ issueNumber, prNumber: pr.number }, "High confidence PR opened");
  }

  private async mediumConfidenceAction(issueNumber: number, issueTitle: string, result: AgentResult, sandbox: SandboxExecutor) {
    const base = await this.defaultBranch();
    const branchName = `${BRANCH_PREFIX}/draft-fix-issue-${issueNumber}`;

    await sandbox.execChecked(`git checkout -B ${shellSingleQuote(branchName)}`);
    await sandbox.execChecked(`git config user.email ${shellSingleQuote(BOT_EMAIL)}`);
    await sandbox.execChecked(`git config user.name ${shellSingleQuote(BOT_NAME)}`);
    await sandbox.formatCode();
    const committed = await this.commitOnly(result.changedPaths ?? [], this.buildCommitMessage(issueNumber, issueTitle, result), sandbox);
    if (!committed) {
      logger.warn({ issueNumber }, "Nothing to commit after staging — issue appears already fixed");
      await this.postAlreadyFixed(issueNumber, result);
      return;
    }
    await sandbox.pushBranch(branchName);

    const title = this.buildPRTitle(issueNumber, issueTitle, result, true);
    const { data: pr } = await this.octokit.pulls.create({
      owner: this.repoOwner,
      repo: this.repoName,
      title,
      body: this.buildPRBody(issueNumber, result, branchName, true),
      head: branchName,
      base,
      draft: true,
    });

    await this.octokit.issues.addLabels({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: pr.number,
      labels: ["bot-fix"],
    });

    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: draftIssueComment(pr.number, result),
    });
  }

  private async lowConfidenceAction(issueNumber: number, result: AgentResult, testOutput: string) {
    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: lowConfidenceComment(result, testOutput),
    });
  }

  private async postNoFix(issueNumber: number, result: AgentResult, relevantPRs: RankedPR[]) {
    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: noFixComment(
        result,
        relevantPRs.map(pr => ({ number: pr.number, title: pr.title }))
      ),
    });
  }

  private async postNoResult(issueNumber: number) {
    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: noResultComment(),
    });
  }

  private async postAlreadyFixed(issueNumber: number, result: AgentResult) {
    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: alreadyFixedComment(result),
    });
  }

  private async postInvestigationFindings(issueNumber: number, result: AgentResult) {
    await this.octokit.issues.createComment({
      owner: this.repoOwner,
      repo: this.repoName,
      issue_number: issueNumber,
      body: investigationComment(result.summary),
    });
  }

  /** Poll CI checks on a PR and post a comment if they fail. */
  private async checkCIAndReport(issueNumber: number, prNumber: number, branchName: string) {
    // Wait for CI to start
    await new Promise(r => setTimeout(r, 15_000));

    let attempts = 0;
    const maxAttempts = 12; // ~3 minutes total

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const { data: checks } = await this.octokit.checks.listForRef({
          owner: this.repoOwner,
          repo: this.repoName,
          ref: branchName,
        });

        if (checks.total_count === 0) {
          await new Promise(r => setTimeout(r, 15_000));
          continue;
        }

        const allCompleted = checks.check_runs.every(c => c.status === "completed");
        if (!allCompleted) {
          await new Promise(r => setTimeout(r, 15_000));
          continue;
        }

        const failures = checks.check_runs.filter(c => c.conclusion !== "success" && c.conclusion !== "neutral" && c.conclusion !== "skipped");
        if (failures.length > 0) {
          const names = failures.map(f => f.name).join(", ");
          await this.octokit.issues.createComment({
            owner: this.repoOwner,
            repo: this.repoName,
            issue_number: issueNumber,
            body: ciFailureComment(prNumber, names),
          });
        }
        return;
      } catch {
        await new Promise(r => setTimeout(r, 15_000));
      }
    }
  }

  /** Reset any unintended working-tree changes and commit only the specified paths. Returns false if nothing was staged. */
  private async commitOnly(paths: string[], message: string, sandbox: SandboxExecutor): Promise<boolean> {
    const keep = new Set(paths);

    // Discard tracked modifications that aren't in our intended set
    const diffResult = await sandbox.exec("git diff --name-only", 30);
    for (const file of diffResult.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
      if (!keep.has(file)) {
        await sandbox.exec(`git checkout -- ${shellSingleQuote(file)}`, 10);
      }
    }

    // Discard staged modifications that aren't intended
    const stagedResult = await sandbox.exec("git diff --cached --name-only", 30);
    for (const file of stagedResult.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
      if (!keep.has(file)) {
        await sandbox.exec(`git reset HEAD ${shellSingleQuote(file)} && git checkout -- ${shellSingleQuote(file)}`, 10);
      }
    }

    // Stage only intended paths
    for (const p of paths) {
      await sandbox.execChecked(`git add ${shellSingleQuote(p)}`, 10);
    }

    // Check if there's actually anything staged — git commit exits 1 with nothing to commit
    const statusResult = await sandbox.exec("git diff --cached --name-only", 10);
    if (!statusResult.stdout.trim()) {
      return false; // caller should treat as no-op
    }

    await sandbox.execChecked(`git commit -m ${shellSingleQuote(message)}`, 30);
    return true;
  }

  private buildCommitMessage(issueNumber: number, issueTitle: string, result: AgentResult): string {
    // Try to derive a clean commit message from the issue title first
    const title = issueTitle?.trim() || "";
    const summary = result.summary.split("\n")[0] ?? "";

    // Detect change type for conventional commit prefix
    const changed = result.changedPaths ?? [];
    const isDocOnly = changed.length > 0 && changed.every(p =>
      /\.(md|txt|rst|markdown)$/i.test(p) || /^(readme|changelog|contributing|license)/i.test(p.split("/").pop() ?? "")
    );
    const prefix = isDocOnly ? "docs:" : "fix:";

    // Use issue title if it's short and clean, otherwise use the agent summary
    const base = title.length > 5 && title.length <= 60 ? title : summary;

    // Clean up: remove trailing period, "as requested", quotes, etc.
    const cleaned = base
      .replace(/\.$/, "")
      .replace(/\s+as requested/gi, "")
      .replace(/""/g, "")
      .trim();

    const msg = `${prefix} ${cleaned}`.slice(0, 72);
    return msg || `${prefix} update for issue #${issueNumber}`;
  }

  private buildPRTitle(issueNumber: number, issueTitle: string, result: AgentResult, isDraft: boolean): string {
    const prefix = isDraft ? "[DRAFT] " : "";
    const title = issueTitle?.trim() || (result.summary.split(".")[0] ?? `Fix for issue #${issueNumber}`);
    return `${prefix}${title}`;
  }

  private buildPRBody(issueNumber: number, result: AgentResult, branchName: string, isDraft: boolean): string {
    const fileLinks =
      result.changedPaths?.map(p => {
        const url = `https://github.com/${this.repoOwner}/${this.repoName}/blob/${branchName}/${p}`;
        return `- [${p}](${url})`;
      }).join("\n") ||
      (result.fixedFiles || []).map(f => `- \`${f.path}\``).join("\n") ||
      "_see diff_";

    return buildPRBody(issueNumber, result, fileLinks, isDraft, this.repoOwner, this.repoName, branchName);
  }
}
