import { Queue, Worker } from "bullmq";
import { createRedisConnection } from "../infra/redis.js";
import { runIssueAgent } from "../agent/issueAgent.js";
import { logger } from "../utils/logger.js";
import { checkLimit, incrementUsage } from "../billing/usageTracker.js";
import type { IssueJobData } from "../utils/types.js";

export const ISSUE_QUEUE_NAME = "issuebot-issues";

export function createIssueQueue() {
  const connection = createRedisConnection();
  return new Queue<IssueJobData>(ISSUE_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  });
}

export function createIssueWorker() {
  const connection = createRedisConnection();
  const worker = new Worker<IssueJobData>(
    ISSUE_QUEUE_NAME,
    async job => {
      const { installationId, repoPrivate, repoOwner, repoName, issueNumber } = job.data;
      const repoFullName = `${repoOwner}/${repoName}`;
      logger.info({ jobId: job.id, issue: issueNumber }, "Processing issue job");

      const limitCheck = await checkLimit(installationId, repoPrivate, repoFullName);
      if (!limitCheck.allowed) {
        logger.warn(
          { jobId: job.id, installationId, reason: limitCheck.reason },
          "Billing limit reached — skipping job"
        );
        // Return without throwing so BullMQ marks it completed (not retried)
        return;
      }

      try {
        await runIssueAgent(job.data, job.id);
        await incrementUsage(installationId);
      } catch (err) {
        logger.error({ jobId: job.id, err }, "Issue agent threw an error");
        throw err;
      }
    },
    { connection, concurrency: Math.max(1, parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10) || 2) }
  );

  worker.on("completed", job => {
    logger.info({ jobId: job.id }, "Issue job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Issue job failed");
  });

  worker.on("error", err => {
    logger.error({ err }, "Worker runtime error");
  });

  return worker;
}
