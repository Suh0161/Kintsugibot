import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

/**
 * Create a child logger pre-bound with job context fields.
 * All log lines from an agent run will carry issueNumber, repoOwner, repoName
 * so they can be correlated in any structured log aggregator.
 */
export function jobLogger(fields: {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  jobId?: string;
}) {
  return logger.child(fields);
}

export type JobLogger = ReturnType<typeof jobLogger>;
