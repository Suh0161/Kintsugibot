import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

async function readPrivateKey(): Promise<string> {
  const pathEnv = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (pathEnv) {
    const absolute = resolve(process.cwd(), pathEnv);
    return (await readFile(absolute, "utf8")).trim();
  }
  const raw = process.env.GITHUB_APP_PRIVATE_KEY ?? "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const pk = await readPrivateKey();
  if (!appId || !pk) {
    throw new Error(
      "Set GITHUB_APP_ID and either GITHUB_APP_PRIVATE_KEY_PATH (.pem file) or GITHUB_APP_PRIVATE_KEY in .env"
    );
  }

  const auth = createAppAuth({
    appId,
    privateKey: pk,
    installationId,
  });

  const { token } = await auth({ type: "installation", installationId });
  return token;
}

export async function getOctokit(installationId: number): Promise<Octokit> {
  const token = await getInstallationToken(installationId);
  logger.debug({ installationId }, "Created installation-scoped Octokit client");
  return new Octokit({ auth: token });
}
