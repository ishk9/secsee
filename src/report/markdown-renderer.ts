import type { TestReport, ApiTestResult, PageTestResult, NetworkValidationResult, Issue } from '../types/index.js';

export function renderMarkdown(report: TestReport): string {
  const lines: string[] = [];

  lines.push(`# SecSee Test Report`);
  lines.push(`> Generated at ${report.generatedAt}`);
  lines.push('');

  appendSummary(lines, report);
  appendApiResults(lines, report.apiResults);
  appendFrontendResults(lines, report.frontendResults);
  appendNetworkValidation(lines, report.networkValidation);
  appendIssues(lines, report.issues);

  return lines.join('\n');
}

function appendSummary(lines: string[], report: TestReport): void {
  const s = report.summary;
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total  | ${s.totalTests} |`);
  lines.push(`| Pass ✓ | ${s.passed} |`);
  lines.push(`| Fail ✗ | ${s.failed} |`);
  lines.push(`| Skip ⊘ | ${s.skipped} |`);
  lines.push(`| Error ! | ${s.errors} |`);
  lines.push(`| Duration | ${s.durationMs}ms |`);
  lines.push('');
}

function appendApiResults(lines: string[], results: ApiTestResult[]): void {
  if (results.length === 0) return;

  lines.push('## API Test Results');
  lines.push('');
  lines.push('| Endpoint | Status | Latency | Errors |');
  lines.push('|----------|--------|---------|--------|');

  for (const r of results) {
    const icon = statusIcon(r.status);
    const errs = r.validationErrors.length > 0 ? r.validationErrors.join('; ') : '—';
    lines.push(
      `| \`${r.method} ${r.endpoint}\` | ${icon} ${r.status} | ${r.actualResponse.latencyMs}ms | ${errs} |`,
    );
  }
  lines.push('');
}

function appendFrontendResults(lines: string[], results: PageTestResult[]): void {
  if (results.length === 0) return;

  lines.push('## Frontend Test Results');
  lines.push('');

  for (const p of results) {
    lines.push(`### ${p.url}`);
    lines.push('');
    lines.push(`- **Screenshot:** \`${p.screenshot}\``);
    lines.push(`- **Load time:** ${p.loadTimeMs}ms`);
    lines.push(`- **Interactive elements:** ${p.interactiveElements.length}`);
    lines.push(`- **Forms found:** ${p.formsFound.length}`);

    if (p.formTestResults.length > 0) {
      lines.push(`- **Form tests:** ${p.formTestResults.filter((f) => f.passed).length}/${p.formTestResults.length} passed`);
    }

    if (p.consoleErrors.length > 0) {
      lines.push(`- **Console errors:**`);
      for (const e of p.consoleErrors) {
        lines.push(`  - ${e}`);
      }
    }

    if (p.networkValidation.length > 0) {
      const failing = p.networkValidation.filter((n) => !n.passed);
      if (failing.length > 0) {
        lines.push(`- **Network mismatches:** ${failing.length}`);
      }
    }

    lines.push('');
  }
}

function appendNetworkValidation(lines: string[], results: NetworkValidationResult[]): void {
  if (results.length === 0) return;

  lines.push('## Network Validation');
  lines.push('');
  lines.push('| URL | Method | Expected | Actual | Match |');
  lines.push('|-----|--------|----------|--------|-------|');

  for (const n of results) {
    const expected = n.contract
      ? `${n.contract.method} ${n.contract.path}`
      : '—';
    const actual = `${n.networkEntry.method} ${n.networkEntry.url}`;
    const match = n.passed ? '✓' : '✗';
    lines.push(`| ${n.networkEntry.url} | ${n.networkEntry.method} | ${expected} | ${actual} | ${match} |`);
  }
  lines.push('');
}

function appendIssues(lines: string[], issues: Issue[]): void {
  if (issues.length === 0) return;

  lines.push('## Issues');
  lines.push('');

  for (const issue of issues) {
    const badge = severityBadge(issue.severity);
    const location = issue.endpoint ?? issue.page ?? '';
    lines.push(`- ${badge} **${issue.message}**${location ? ` — \`${location}\`` : ''}`);
    if (issue.details) {
      lines.push(`  > ${issue.details}`);
    }
  }
  lines.push('');
}

function statusIcon(status: string): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'fail':
      return '✗';
    case 'skip':
      return '⊘';
    case 'error':
      return '!';
    default:
      return '?';
  }
}

function severityBadge(severity: string): string {
  switch (severity) {
    case 'critical':
      return '🔴';
    case 'high':
      return '🟠';
    case 'medium':
      return '🟡';
    case 'low':
      return '🔵';
    default:
      return '⚪';
  }
}
