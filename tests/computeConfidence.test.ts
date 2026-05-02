import { describe, it, expect } from "vitest";
import type { AgentResult, TestResult } from "../src/agent/types.js";

// Re-export the private function for testing by duplicating its logic.
// If you ever make computeConfidence exported, import it directly.
function computeConfidence(result: AgentResult, testResult: TestResult): number {
  let score = 0;
  if (testResult.allTestsPass) score += 40;
  if (testResult.issueReproducedBeforeFix && testResult.issueResolvedAfterFix) score += 30;
  if (!testResult.hasRegressions) score += 20;
  if (result.prReferenceFound) score += 10;
  return Math.min(score, 100);
}

const baseResult: AgentResult = {
  type: "fix_ready",
  summary: "Fix the bug",
};

const passingTests: TestResult = {
  allTestsPass: true,
  issueReproducedBeforeFix: true,
  issueResolvedAfterFix: true,
  hasRegressions: false,
  stdout: "All tests pass",
  stderr: "",
  exitCode: 0,
};

describe("computeConfidence", () => {
  it("returns 100 for a perfect fix with PR reference", () => {
    expect(computeConfidence({ ...baseResult, prReferenceFound: true }, passingTests)).toBe(100);
  });

  it("returns 90 for a perfect fix without PR reference", () => {
    expect(computeConfidence(baseResult, passingTests)).toBe(90);
  });

  it("returns 60 when tests pass but issue was not reproduced before fix", () => {
    const tr: TestResult = { ...passingTests, issueReproducedBeforeFix: false };
    expect(computeConfidence(baseResult, tr)).toBe(60);
  });

  it("returns 70 when tests pass + reproduced but has regressions", () => {
    const tr: TestResult = { ...passingTests, hasRegressions: true };
    expect(computeConfidence(baseResult, tr)).toBe(70);
  });

  it("returns 0 when nothing passes", () => {
    const tr: TestResult = {
      allTestsPass: false,
      issueReproducedBeforeFix: false,
      issueResolvedAfterFix: false,
      hasRegressions: true,
      stdout: "",
      stderr: "FAIL",
      exitCode: 1,
    };
    expect(computeConfidence(baseResult, tr)).toBe(0);
  });

  it("never exceeds 100", () => {
    // Even with all bonuses applied, score is capped
    const score = computeConfidence({ ...baseResult, prReferenceFound: true }, passingTests);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("PR reference bonus adds 10 to any base score", () => {
    const without = computeConfidence(baseResult, passingTests);
    const with_ = computeConfidence({ ...baseResult, prReferenceFound: true }, passingTests);
    // Difference is 10, unless already at 100 (cap)
    expect(with_ - without).toBe(10);
  });
});
