import type { Page, Request, Response } from 'playwright';
import type {
  NetworkEntry,
  EndpointDefinition,
  NetworkValidationResult,
} from '../../types/index.js';

const STATIC_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.svg', '.woff', '.ico', '.gif', '.map',
];

export class NetworkMonitor {
  private entries: NetworkEntry[] = [];

  attach(page: Page): void {
    page.on('request', (req: Request) => {
      this.entries.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData() ?? null,
        timestamp: Date.now(),
        type: 'request',
      });
    });

    page.on('response', async (res: Response) => {
      const reqUrl = res.url();
      const reqMethod = res.request().method();
      const entry = this.entries.find(
        (e) => e.url === reqUrl && e.method === reqMethod && !e.responseStatus,
      );
      if (!entry) return;

      entry.responseStatus = res.status();
      entry.responseHeaders = res.headers();
      try {
        entry.responseBody = await res.json();
      } catch {
        try {
          entry.responseBody = await res.text();
        } catch {
          entry.responseBody = null;
        }
      }
      entry.type = 'response';
    });
  }

  detach(page: Page): void {
    page.removeAllListeners('request');
    page.removeAllListeners('response');
  }

  clear(): void {
    this.entries = [];
  }

  getEntries(): NetworkEntry[] {
    return [...this.entries];
  }

  getApiEntries(): NetworkEntry[] {
    return this.entries.filter((entry) => {
      try {
        const path = new URL(entry.url).pathname;
        return !STATIC_EXTENSIONS.some((ext) => path.endsWith(ext));
      } catch {
        return true;
      }
    });
  }

  validateAgainstContracts(
    contracts: EndpointDefinition[],
  ): NetworkValidationResult[] {
    const apiEntries = this.getApiEntries();
    const results: NetworkValidationResult[] = [];

    for (const entry of apiEntries) {
      let entryPath: string;
      try {
        entryPath = new URL(entry.url).pathname;
      } catch {
        continue;
      }

      const contract = contracts.find((c) => {
        if (c.method !== entry.method) return false;
        const pattern = c.path.replace(/:[^/]+/g, '[^/]+').replace(/\{[^}]+\}/g, '[^/]+');
        return new RegExp(`^${pattern}$`).test(entryPath);
      });

      const mismatches: string[] = [];

      if (!contract) {
        results.push({
          networkEntry: entry,
          contract: null,
          passed: false,
          mismatches: ['No matching contract found'],
        });
        continue;
      }

      if (entry.responseStatus !== undefined) {
        const expectedCodes = contract.response.statusCodes.map((s) => s.code);
        if (!expectedCodes.includes(entry.responseStatus)) {
          mismatches.push(
            `Status ${entry.responseStatus} not in expected [${expectedCodes.join(', ')}]`,
          );
        }
      }

      results.push({
        networkEntry: entry,
        contract,
        passed: mismatches.length === 0,
        mismatches,
      });
    }

    return results;
  }
}
