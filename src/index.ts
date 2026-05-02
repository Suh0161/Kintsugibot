import "dotenv/config";
import { startApiServer } from "./server.js";
import { createIssueWorker } from "./queue/issueQueue.js";
import { logger } from "./utils/logger.js";

const mode = process.env.RUN_MODE ?? "both";

async function main() {
  if (!process.env.LLM_API_KEY) {
    logger.warn("LLM_API_KEY is not set - agent runs will fail until configured.");
  }

  if (mode === "worker") {
    createIssueWorker();
    logger.info({ mode }, "Worker running");
    return;
  }

  if (mode === "api") {
    await startApiServer();
    return;
  }

  createIssueWorker();
  await startApiServer();
}

main().catch(err => {
  logger.error(err);
  process.exit(1);
});
