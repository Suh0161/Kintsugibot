import { createRedisConnection } from "../infra/redis.js";

export type PlanTier = "free" | "paid";

export interface Plan {
  tier: PlanTier;
  monthlyLimit: number;  // max issues processed per month
  repoLimit: number;     // max repos (-1 = public only for free)
  allowsPrivate: boolean;
}

export const PLANS: Record<PlanTier, Plan> = {
  free: { tier: "free", monthlyLimit: 10,  repoLimit: -1,  allowsPrivate: false }, // public only
  paid: { tier: "paid", monthlyLimit: 100, repoLimit: 10,  allowsPrivate: true  }, // $5/month
};

const PLAN_KEY  = (installationId: number) => `billing:plan:${installationId}`;
const REPOS_KEY = (installationId: number) => `billing:repos:${installationId}`;

/** Persist the plan tier for an installation (called from marketplace_purchase webhook). */
export async function setInstallationPlan(installationId: number, tier: PlanTier): Promise<void> {
  const redis = createRedisConnection();
  try {
    await redis.set(PLAN_KEY(installationId), tier);
  } finally {
    redis.disconnect();
  }
}

/** Get the plan for an installation. Defaults to free if not set. */
export async function getInstallationPlan(installationId: number): Promise<Plan> {
  const redis = createRedisConnection();
  try {
    const tier = (await redis.get(PLAN_KEY(installationId))) as PlanTier | null;
    return PLANS[tier ?? "free"] ?? PLANS.free;
  } finally {
    redis.disconnect();
  }
}

/**
 * Track a repo for this installation. Returns the total number of unique repos seen.
 * Uses a Redis set so duplicates are ignored automatically.
 */
export async function trackRepo(installationId: number, repoFullName: string): Promise<number> {
  const redis = createRedisConnection();
  try {
    await redis.sadd(REPOS_KEY(installationId), repoFullName);
    return await redis.scard(REPOS_KEY(installationId));
  } finally {
    redis.disconnect();
  }
}

/** Get number of unique repos seen for this installation. */
export async function getRepoCount(installationId: number): Promise<number> {
  const redis = createRedisConnection();
  try {
    return await redis.scard(REPOS_KEY(installationId));
  } finally {
    redis.disconnect();
  }
}
