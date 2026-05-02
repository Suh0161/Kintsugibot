/** Professional, analytical message templates for KintsugiBot. */

const BOT_NAME = process.env.BOT_NAME?.trim() || "KintsugiBot";
const BOT_SIGNATURE = `> — ${BOT_NAME} 🤖`;

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/* ───────── Issue comment after opening a high-confidence PR ───────── */

export function highConfidenceIssueComment(prNumber: number, result: { what?: string; why?: string; how?: string; summary: string }): string {
  const analysis = buildAnalysis(result);
  const closings = [
    "I've opened a PR with the fix above — feel free to review and let me know if anything needs adjusting.",
    "The fix is ready in the PR above. Happy to iterate if you'd like any changes.",
    "PR opened with the fix. Let me know if the approach looks good or if you'd prefer a different direction.",
  ];

  return `${analysis}\n\n${pick(closings)}\n\n→ **PR #${prNumber}**\n\n${BOT_SIGNATURE}`;
}

/* ───────── Issue comment after opening a draft PR ───────── */

export function draftIssueComment(prNumber: number, result: { what?: string; why?: string; how?: string; summary: string }): string {
  const analysis = buildAnalysis(result);
  return `${analysis}\n\nI've put together a draft in **PR #${prNumber}** — the approach seems reasonable but I'd appreciate a human review before it's finalized.\n\n${BOT_SIGNATURE}`;
}

/* ───────── Low confidence / tests-failing comment ───────── */

export function lowConfidenceComment(result: { what?: string; why?: string; how?: string; summary: string }, testOutput: string): string {
  const analysis = buildAnalysis(result);
  const details = testOutput.trim()
    ? `<details>\n<summary>🔍 <b>Test output</b> (click to expand)</summary>\n\n\`\`\`\n${testOutput.slice(0, 2000)}\n\`\`\`\n</details>`
    : "_No test output captured._";

  return `${analysis}\n\nI wasn't fully confident in a clean fix here — the tests didn't pass cleanly. If any contributor wants to pick this up, the investigation above should be a good starting point.\n\n${details}\n\n${BOT_SIGNATURE}`;
}

/* ───────── No-fix possible comment (invites contributors) ───────── */

export function noFixComment(result: { what?: string; why?: string; how?: string; summary: string }, relevantPRs: { number: number; title: string }[]): string {
  const analysis = buildAnalysis(result);

  let prSection = "";
  if (relevantPRs.length > 0) {
    prSection = `\n\n**Related open PRs:**\n${relevantPRs
      .map(pr => `- #${pr.number}: ${pr.title}`)
      .join("\n")}`;
  }

  return `${analysis}\n\nUnfortunately I wasn't able to land a clean fix for this. It may need deeper architectural changes or more context than I have access to.\n\n**If any contributor would like to take this on, the root-cause analysis above should be a good starting point!**${prSection}\n\n${BOT_SIGNATURE}`;
}

/* ───────── No-result / empty agent result ───────── */

export function noResultComment(): string {
  const templates = [
    `I ran into an unexpected error while investigating this issue and wasn't able to produce a useful result. A manual review would be appreciated.\n\n${BOT_SIGNATURE}`,
    `Something went wrong during my investigation and I couldn't generate a meaningful fix or analysis. This one probably needs human eyes.\n\n${BOT_SIGNATURE}`,
  ];
  return pick(templates);
}

/* ───────── Investigation findings (no fix submitted, just info) ───────── */

export function investigationComment(summary: string): string {
  return `**Investigation Results**\n\n${summary}\n\n${BOT_SIGNATURE}`;
}

/* ───────── Error comment ───────── */

export function errorComment(message: string): string {
  return `I encountered an error while working on this issue.\n\n<details>\n<summary>🐛 <b>Error details</b> (click to expand)</summary>\n\n\`\`\`\n${message.slice(0, 2000)}\n\`\`\`\n</details>\n\nA human review would be greatly appreciated.\n\n${BOT_SIGNATURE}`;
}

/* ───────── Feature-request skip ───────── */

export function featureSkipComment(): string {
  const templates = [
    `I appreciate the suggestion, but I'm specialized for bug fixes and code maintenance rather than new feature development. This looks like a great topic for the maintainers to weigh in on!\n\n${BOT_SIGNATURE}`,
    `Thanks for the idea! I'm tuned for fixing bugs and code issues, so feature requests are outside my scope. The maintainers would be the right folks to evaluate this.\n\n${BOT_SIGNATURE}`,
  ];
  return pick(templates);
}

/* ───────── Question / support skip ───────── */

export function questionSkipComment(): string {
  const templates = [
    `This looks like a support question rather than a code issue. I'm designed to fix bugs and code problems — you'll likely get better help from the project docs or community discussions.\n\n${BOT_SIGNATURE}`,
    `I specialize in fixing bugs and code issues, so support questions are a bit outside my wheelhouse. The docs or discussion forums are probably your best bet for this one!\n\n${BOT_SIGNATURE}`,
  ];
  return pick(templates);
}

/* ───────── CI failure follow-up ───────── */

export function ciFailureComment(prNumber: number, failedChecks: string): string {
  return `**CI checks failed on PR #${prNumber}.**\n\nThe following checks need attention: **${failedChecks}**\n\nA follow-up fix may be needed to get everything green.\n\n${BOT_SIGNATURE}`;
}

/* ───────── PR Body builder (What / Why / How) ───────── */

export function buildPRBody(
  issueNumber: number,
  result: { what?: string; why?: string; how?: string; summary: string; changedPaths?: string[] },
  fileLinks: string,
  isDraft: boolean,
  repoOwner: string,
  repoName: string,
  branchName: string
): string {
  const draftBanner = isDraft
    ? `> 🚧 **Draft PR** — needs a review before it's ready to land.\n\n`
    : "";

  const whatSection = result.what?.trim()
    ? result.what.trim()
    : result.summary;

  const whySection = result.why?.trim()
    ? `\n\n## Why\n\n${result.why.trim()}`
    : "";

  const howSection = result.how?.trim()
    ? `\n\n## How\n\n${result.how.trim()}`
    : "";

  const checklist = isDraft
    ? `- [ ] Review requested\n- [ ] Tests passing\n- [ ] Ready for merge\n`
    : `- [x] Tests passing\n- [x] Ready for review\n`;

  return `${draftBanner}Closes #${issueNumber}

## What

${whatSection}${whySection}${howSection}

## Files Changed

${fileLinks}

## ✅ Status

${checklist}

---

> 🤖 *This PR was generated by [${BOT_NAME}](https://github.com/${repoOwner}/${repoName}/blob/${branchName}/README.md). If something looks off, feel free to close it and open a manual fix.*
`;
}

/* ───────── Helper: build analysis block from result ───────── */

function buildAnalysis(result: { what?: string; why?: string; how?: string; summary: string }): string {
  const parts: string[] = [];

  if (result.what?.trim()) {
    parts.push(`**What:** ${result.what.trim()}`);
  } else if (result.summary) {
    parts.push(`**What:** ${result.summary}`);
  }

  if (result.why?.trim()) {
    parts.push(`**Why:** ${result.why.trim()}`);
  }

  if (result.how?.trim()) {
    parts.push(`**How:**\n${result.how.trim()}`);
  }

  if (parts.length === 0) {
    parts.push(result.summary || "Investigated the issue.");
  }

  return parts.join("\n\n");
}
