import { Webhooks } from "@octokit/webhooks";
import type { Queue } from "bullmq";
import { logger } from "../utils/logger.js";
import { setInstallationPlan } from "../billing/plans.js";
import type { PlanTier } from "../billing/plans.js";
import type { IssueJobData } from "../utils/types.js";

/** Narrow payload shape used for enqueueing — avoids brittle coupling to full webhook unions. */
interface IssueEnqueuePayload {
  installation?: { id: number } | null;
  repository: { name: string; owner: { login: string }; private: boolean };
  issue: { id: number; number: number; title: string; body: string | null };
}

export function createGithubWebhooks(queue: Queue<IssueJobData>): Webhooks | null {
  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (!secret) {
    logger.warn(
      "WEBHOOK_SECRET is not set; POST /webhook returns 503 until you add it to .env (GitHub App webhook secret)."
    );
    return null;
  }

  const webhooks = new Webhooks({ secret });

  webhooks.on("issues.opened", async ({ payload }) => {
    await enqueueIssueJob(queue, payload as IssueEnqueuePayload);
  });

  webhooks.on("issues.labeled", async ({ payload }) => {
    if (payload.label?.name !== "bot-fix") return;
    await enqueueIssueJob(queue, payload as IssueEnqueuePayload);
  });

  // GitHub Marketplace: fired on subscribe, upgrade, downgrade, cancel, pending_change
  webhooks.on("marketplace_purchase" as any, async ({ payload }: any) => {
    const installationId = payload.marketplace_purchase?.account?.id;
    const action: string = payload.action;
    const planName: string = payload.marketplace_purchase?.plan?.name?.toLowerCase() ?? "";

    if (!installationId) {
      logger.warn({ action }, "marketplace_purchase missing account id");
      return;
    }

    if (action === "cancelled" || action === "pending_change_cancelled") {
      await setInstallationPlan(installationId, "free");
      logger.info({ installationId, action }, "Installation downgraded to free");
      return;
    }

    // Any active paid plan maps to "paid"
    const tier: PlanTier = "paid";

    await setInstallationPlan(installationId, tier);
    logger.info({ installationId, action, planName, tier }, "Installation plan updated");
  });

  return webhooks;
}

async function enqueueIssueJob(queue: Queue<IssueJobData>, payload: IssueEnqueuePayload) {
  const installationId = payload.installation?.id;
  if (!installationId) {
    logger.warn("Skipping issue event without installation id");
    return;
  }

  const job: IssueJobData = {
    installationId,
    repoOwner: payload.repository.owner.login,
    repoName: payload.repository.name,
    repoPrivate: payload.repository.private,
    issueNumber: payload.issue.number,
    issueTitle: payload.issue.title,
    issueBody: payload.issue.body ?? "",
  };

  const jobId = `${job.repoOwner}/${job.repoName}/issue-${payload.issue.id}`;

  // Guard against duplicate webhook deliveries by checking for an existing active/waiting job
  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "active" || state === "waiting" || state === "delayed") {
        logger.info({ jobId, state }, "Skipping duplicate enqueue, job already in queue");
        return;
      }
    }
  } catch (err) {
    logger.warn({ err, jobId }, "Failed to check existing job state, proceeding with enqueue");
  }

  await queue.add("process-issue", job, {
    jobId,
    // GitHub/Smee often delivers twice within ms — collapse duplicate adds so we log/process once.
    deduplication: { id: `gh-issue-${payload.issue.id}`, ttl: 120_000 },
  });

  logger.info({ jobId }, "Enqueued issue job");
}

/** Simple keyword-based label suggestion for triage. */
export function suggestLabels(title: string, body: string): string[] {
  const text = `${title} ${body ?? ""}`.toLowerCase();
  const labels: string[] = [];

  if (/\b(bug|crash|error|exception|broken|fail|not working|doesn't work)\b/.test(text)) {
    labels.push("bug");
  }
  if (/\b(feature|request|add support|implement|would be nice|should have)\b/.test(text)) {
    labels.push("enhancement");
  }
  if (/\b(doc|readme|documentation|wiki|comment|guide|tutorial)\b/.test(text)) {
    labels.push("documentation");
  }
  if (/\b(test|testing|coverage|spec|jest|pytest)\b/.test(text)) {
    labels.push("tests");
  }
  if (/\b(refactor|cleanup|clean up|rename|move|extract)\b/.test(text)) {
    labels.push("refactor");
  }
  if (/\b(security|vulnerability|cve|xss|sql injection|auth)\b/.test(text)) {
    labels.push("security");
  }
  if (/\b(dependencies|bump|upgrade|update .+ version|outdated)\b/.test(text)) {
    labels.push("dependencies");
  }
  if (/\b(good first issue|beginner|easy|starter|newcomer)\b/.test(text)) {
    labels.push("good first issue");
  }

  return labels;
}
