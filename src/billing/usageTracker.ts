import { createRedisConnection } from "../infra/redis.js";
import { getInstallationPlan, trackRepo } from "./plans.js";

const USAGE_KEY = (installationId: number) => {
  const month = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  return `billing:usage:${installationId}:${month}`;
};

/** Increment usage counter for the current month. Returns new count. */
export async function incrementUsage(installationId: number): Promise<number> {
  const redis = createRedisConnection();
  try {
    const key = USAGE_KEY(installationId);
    const count = await redis.incr(key);
    // Auto-expire after 35 days so old keys clean themselves up
    await redis.expire(key, 60 * 60 * 24 * 35);
    return count;
  } finally {
    redis.disconnect();
  }
}

/** Get current month usage for an installation. */
export async function getUsage(installationId: number): Promise<number> {
  const redis = createRedisConnection();
  try {
    const val = await redis.get(USAGE_KEY(installationId));
    return val ? parseInt(val, 10) : 0;
  } finally {
    redis.disconnect();
  }
}

/**
 * Check if the installation is within its plan limits.
 *
 * Free plan: public repos only, 10 issues/month, no repo cap.
 * Paid plan ($5/mo): public + private, 100 issues/month, max 10 repos.
 */
export async function checkLimit(
  installationId: number,
  repoPrivate: boolean,
  repoFullName: string
): Promise<{ allowed: true } | { allowed: false; reason: "private_repo" | "limit_reached" | "repo_limit"; usage?: number; limit?: number }> {
  const plan = await getInstallationPlan(installationId);

  // Private repos require paid plan
  if (repoPrivate && !plan.allowsPrivate) {
    return { allowed: false, reason: "private_repo" };
  }

  // Check monthly issue limit
  const usage = await getUsage(installationId);
  if (usage >= plan.monthlyLimit) {
    return { allowed: false, reason: "limit_reached", usage, limit: plan.monthlyLimit };
  }

  // Check repo limit (paid plan only — free has no repo cap, just public-only)
  if (plan.repoLimit > 0) {
    const repoCount = await trackRepo(installationId, repoFullName);
    if (repoCount > plan.repoLimit) {
      return { allowed: false, reason: "repo_limit", limit: plan.repoLimit };
    }
  }

  return { allowed: true };
}
