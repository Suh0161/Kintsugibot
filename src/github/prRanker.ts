import type { Octokit } from "@octokit/rest";
import { logger } from "../utils/logger.js";

interface PRRankerOptions {
  octokit: Octokit;
  repoOwner: string;
  repoName: string;
}

export interface RankedPR {
  number: number;
  title: string;
  body: string;
  score: number;
  changedFiles: string[];
}

export class PRRanker {
  private octokit: Octokit;
  private repoOwner: string;
  private repoName: string;

  constructor(opts: PRRankerOptions) {
    this.octokit = opts.octokit;
    this.repoOwner = opts.repoOwner;
    this.repoName = opts.repoName;
  }

  async findRelevant(issueTitle: string, issueBody: string, topK = 5): Promise<RankedPR[]> {
    logger.info("Fetching open PRs for ranking");

    const allPRs = await this.fetchAllOpenPRs();
    logger.info({ count: allPRs.length }, "Open PRs fetched");

    if (allPRs.length === 0) return [];

    const keywords = this.extractKeywords(`${issueTitle} ${issueBody}`);
    const filtered = allPRs
      .map(pr => ({
        ...pr,
        score: this.keywordScore(pr, keywords),
      }))
      .filter(pr => pr.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    if (filtered.length === 0) return [];

    const withFiles = await Promise.all(
      filtered.map(async pr => {
        try {
          const { data: files } = await this.octokit.pulls.listFiles({
            owner: this.repoOwner,
            repo: this.repoName,
            pull_number: pr.number,
            per_page: 30,
          });
          return {
            ...pr,
            changedFiles: files.map(f => f.filename),
          };
        } catch {
          return { ...pr, changedFiles: [] as string[] };
        }
      })
    );

    const issueNumbers = this.extractIssueNumbers(issueBody);
    const final = withFiles.map(pr => {
      let score = pr.score;
      const body = (pr.body || "").toLowerCase();
      if (issueNumbers.some(n => body.includes(`#${n}`) || body.includes(`fixes #${n}`))) {
        score += 50;
      }
      return { ...pr, score };
    });

    return final
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async getFileOverlap(prNumbers: number[], targetFiles: string[]): Promise<Map<number, string[]>> {
    const overlap = new Map<number, string[]>();

    await Promise.all(
      prNumbers.map(async prNum => {
        const { data: files } = await this.octokit.pulls.listFiles({
          owner: this.repoOwner,
          repo: this.repoName,
          pull_number: prNum,
          per_page: 100,
        });
        const prFiles = files.map(f => f.filename);
        const shared = prFiles.filter(f => targetFiles.includes(f));
        if (shared.length > 0) overlap.set(prNum, shared);
      })
    );

    return overlap;
  }

  private async fetchAllOpenPRs(): Promise<{ number: number; title: string; body: string }[]> {
    const allPRs: { number: number; title: string; body: string }[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.octokit.pulls.list({
        owner: this.repoOwner,
        repo: this.repoName,
        state: "open",
        per_page: perPage,
        page,
        sort: "updated",
        direction: "desc",
      });

      allPRs.push(...data.map(pr => ({ number: pr.number, title: pr.title, body: pr.body ?? "" })));
      if (data.length < perPage) break;
      page++;

      if (allPRs.length >= 1000) break;
    }

    return allPRs;
  }

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));
  }

  private keywordScore(pr: { title: string; body: string }, keywords: string[]): number {
    const haystack = `${pr.title} ${pr.body || ""}`.toLowerCase();
    return keywords.filter(kw => haystack.includes(kw)).length;
  }

  private extractIssueNumbers(text: string): number[] {
    const matches = text.match(/#(\d+)/g) || [];
    return matches.map(m => parseInt(m.slice(1), 10));
  }
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "when",
  "what",
  "where",
  "which",
  "there",
  "their",
  "they",
  "will",
  "been",
  "more",
  "also",
  "into",
  "some",
  "than",
  "then",
  "them",
  "these",
  "would",
  "could",
]);
