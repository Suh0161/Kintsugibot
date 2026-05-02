import "dotenv/config";
import { createIssueWorker } from "./queue/issueQueue.js";
import { logger } from "./utils/logger.js";

createIssueWorker();
logger.info({ mode: "worker" }, "KintsugiBot worker started");
