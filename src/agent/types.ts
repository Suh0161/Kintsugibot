export interface AgentResult {
  type: "complete" | "fix_ready" | "no_fix";
  summary: string;
  fixedFiles?: { path: string; content?: string }[];
  /** Paths reported by submit_fix (filename strings). */
  changedPaths?: string[];
  testResult?: TestResult;
  confidence?: number;
  prReferenceFound?: boolean;
  existingPRNumber?: number;
  /** PR description sections — What/Why/How for human reviewers. */
  what?: string;
  why?: string;
  how?: string;
}

export interface TestResult {
  allTestsPass: boolean;
  issueReproducedBeforeFix: boolean;
  issueResolvedAfterFix: boolean;
  hasRegressions: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}
