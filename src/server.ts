import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { Webhooks } from "@octokit/webhooks";
import { createGithubWebhooks } from "./webhooks/github.js";
import { createIssueQueue } from "./queue/issueQueue.js";
import { logger } from "./utils/logger.js";

export async function startApiServer(): Promise<void> {
  const app = express();

  const queue = createIssueQueue();
  const webhooks = createGithubWebhooks(queue);

  const skipWebhookVerify =
    process.env.DEV_SKIP_WEBHOOK_SIGNATURE_VERIFY === "1" ||
    process.env.DEV_SKIP_WEBHOOK_SIGNATURE_VERIFY === "true";
  if (skipWebhookVerify && webhooks) {
    logger.warn(
      "DEV_SKIP_WEBHOOK_SIGNATURE_VERIFY is set — GitHub webhook signatures are NOT verified (local dev only; unsafe if this URL is reachable from the internet)"
    );
  }

  app.disable("x-powered-by");

  // Attach a unique request ID to every request for log correlation
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    res.setHeader("x-request-id", reqId);
    (req as Request & { reqId: string }).reqId = reqId;
    next();
  });

  // Structured access log — method, path, status, latency, requestId
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info({
        reqId: (req as Request & { reqId?: string }).reqId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }, "HTTP request");
    });
    next();
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      webhook: webhooks ? "enabled" : "disabled_missing_secret",
    });
  });

  if (webhooks) {
    app.post(
      "/webhook",
      // GitHub signs the exact raw bytes — use */* so proxies (e.g. Smee) don't skip the parser on odd Content-Types.
      express.raw({ type: "*/*", limit: "25mb" }),
      async (req: Request, res: Response) => {
        const signature = req.headers["x-hub-signature-256"];
        const id = req.headers["x-github-delivery"];
        const name = req.headers["x-github-event"];
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "", "utf8");
        const payloadStr = raw.toString("utf8");

        const reqId = (req as Request & { reqId?: string }).reqId;
        logger.info({ reqId, deliveryId: id, event: name }, "Webhook received");

        try {
          if (skipWebhookVerify) {
            const payload = JSON.parse(payloadStr);
            await webhooks.receive({
              id: String(id),
              name: String(name),
              payload,
            } as Parameters<Webhooks["receive"]>[0]);
          } else {
            await webhooks.verifyAndReceive({
              id: String(id),
              name: String(name),
              payload: payloadStr,
              signature: String(signature),
            });
          }
          logger.info({ reqId, deliveryId: id, event: name }, "Webhook accepted");
          res.status(202).json({ accepted: true });
        } catch (err) {
          logger.warn({ reqId, deliveryId: id, event: name, err }, "Webhook verification failed");
          res.status(401).json({ error: "invalid webhook" });
        }
      }
    );
  } else {
    app.post("/webhook", (_req: Request, res: Response) => {
      res.status(503).json({
        error: "webhook_disabled",
        hint: "Set WEBHOOK_SECRET in .env to match your GitHub App webhook signing secret, then restart.",
      });
    });
  }

  const port = Number(process.env.PORT ?? 3000);

  await new Promise<void>(resolve => {
    app.listen(port, () => {
      logger.info({ port, webhookEnabled: Boolean(webhooks) }, "HTTP server listening");
      resolve();
    });
  });
}
