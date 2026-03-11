import type { CrawlTarget, PageTestResult } from '../../types/index.js';

export function normalizeUrl(raw: string, baseUrl: string): string {
  try {
    const parsed = new URL(raw, baseUrl);
    parsed.search = '';
    parsed.hash = '';
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return parsed.origin + path;
  } catch {
    return raw;
  }
}

export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function isExcluded(url: string, excludePaths: string[]): boolean {
  try {
    const path = new URL(url).pathname;
    return excludePaths.some((pattern) => path.startsWith(pattern));
  } catch {
    return false;
  }
}

export class CrawlState {
  private queue: CrawlTarget[] = [];
  private visited = new Set<string>();
  results: PageTestResult[] = [];

  constructor(
    private maxPages: number,
    private maxDepth: number,
    private excludePaths: string[],
    private baseUrl: string,
  ) {}

  enqueue(target: {
    url: string;
    depth: number;
    referrer: string;
    elementSelector?: string;
  }): void {
    const normalizedUrl = normalizeUrl(target.url, this.baseUrl);

    if (this.visited.has(normalizedUrl)) return;
    if (isExcluded(normalizedUrl, this.excludePaths)) return;
    if (!isSameOrigin(normalizedUrl, this.baseUrl)) return;
    if (target.depth > this.maxDepth) return;

    this.queue.push({
      url: target.url,
      normalizedUrl,
      depth: target.depth,
      referrer: target.referrer,
      elementSelector: target.elementSelector,
    });
  }

  dequeue(): CrawlTarget | undefined {
    return this.queue.shift();
  }

  isVisited(url: string): boolean {
    return this.visited.has(normalizeUrl(url, this.baseUrl));
  }

  markVisited(url: string): void {
    this.visited.add(normalizeUrl(url, this.baseUrl));
  }

  shouldStop(): boolean {
    return this.queue.length === 0 || this.visited.size >= this.maxPages;
  }

  getStats(): { visited: number; queued: number; remaining: number } {
    return {
      visited: this.visited.size,
      queued: this.queue.length,
      remaining: Math.max(0, this.maxPages - this.visited.size),
    };
  }
}
