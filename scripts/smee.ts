/**
 * Forwards your public Smee channel to local KintsugiBot POST /webhook.
 *
 * 1. SMEE_URL in .env = same URL as GitHub App webhook (e.g. https://smee.io/xyz)
 * 2. npm run dev (port 3000)
 * 3. npm run smee
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const url = process.env.SMEE_URL?.trim();
const target = process.env.SMEE_TARGET?.trim() ?? "http://127.0.0.1:3000/webhook";

if (!url) {
  console.error("Set SMEE_URL in .env (your channel from https://smee.io)");
  process.exit(1);
}

const smeeCli = resolve(process.cwd(), "node_modules/smee-client/bin/smee.js");

const child = spawn(process.execPath, [smeeCli, "--url", url, "--target", target], {
  stdio: "inherit",
});

child.on("exit", code => {
  process.exit(code ?? 0);
});
