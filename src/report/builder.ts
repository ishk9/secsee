import type {
  TestReport,
  TestReportSummary,
  ApiTestResult,
  PageTestResult,
  NetworkValidationResult,
  Issue,
  Screenshot,
  IssueSeverity,
} from '../types/index.js';

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class ReportBuilder {
  private apiResults: ApiTestResult[] = [];
  private frontendResults: PageTestResult[] = [];
  private networkValidation: NetworkValidationResult[] = [];
  private issues: Issue[] = [];
  private screenshots: Screenshot[] = [];
  private durationMs = 0;

  withApiResults(results: ApiTestResult[]): this {
    this.apiResults = results;
    return this;
  }

  withFrontendResults(results: PageTestResult[]): this {
    this.frontendResults = results;
    return this;
  }

  withNetworkValidation(results: NetworkValidationResult[]): this {
    this.networkValidation = results;
    return this;
  }

  withIssues(issues: Issue[]): this {
    this.issues = [...issues].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    return this;
  }

  withScreenshots(screenshots: Screenshot[]): this {
    this.screenshots = screenshots;
    return this;
  }

  withDuration(ms: number): this {
    this.durationMs = ms;
    return this;
  }

  build(): TestReport {
    const summary = this.computeSummary();
    return {
      summary,
      apiResults: this.apiResults,
      frontendResults: this.frontendResults,
      networkValidation: this.networkValidation,
      issues: this.issues,
      screenshots: this.screenshots,
      generatedAt: new Date().toISOString(),
    };
  }

  private computeSummary(): TestReportSummary {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let errors = 0;

    for (const r of this.apiResults) {
      switch (r.status) {
        case 'pass':
          passed++;
          break;
        case 'fail':
          failed++;
          break;
        case 'skip':
          skipped++;
          break;
        case 'error':
          errors++;
          break;
      }
    }

    for (const p of this.frontendResults) {
      const hasFail =
        p.consoleErrors.length > 0 ||
        p.formTestResults.some((f) => !f.passed) ||
        p.networkValidation.some((n) => !n.passed);

      if (hasFail) {
        failed++;
      } else {
        passed++;
      }
    }

    for (const n of this.networkValidation) {
      if (n.passed) {
        passed++;
      } else {
        failed++;
      }
    }

    return {
      totalTests: passed + failed + skipped + errors,
      passed,
      failed,
      skipped,
      errors,
      durationMs: this.durationMs,
    };
  }
}
