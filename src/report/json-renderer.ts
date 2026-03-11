import type { TestReport } from '../types/index.js';

export function renderJson(report: TestReport): string {
  return JSON.stringify(report, null, 2);
}
