import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BrowserType,
  CrawlConfig,
  EndpointDefinition,
  ElementInfo,
  FormTestResult,
  NetworkValidationResult,
  PageTestResult,
} from '../../types/index.js';
import { normalizeUrl, CrawlState } from './url-normalizer.js';
import { NetworkMonitor } from './network-monitor.js';
import { FormDetector, AuthHandler } from './form-detector.js';

export interface CrawlerOptions {
  frontendUrl: string;
  browser: BrowserType;
  crawl: CrawlConfig;
  excludePaths: string[];
  testCredentials?: { username: string; password: string };
  contracts: EndpointDefinition[];
  headed?: boolean;
  screenshotDir: string;
}

const NAVIGATION_TIMEOUT = 30_000;

function sanitizeUrlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .replace(/^\//, '')
      .replace(/\//g, '_')
      .replace(/[^a-zA-Z0-9_.-]/g, '') || 'index';
  } catch {
    return 'page';
  }
}

function launchBrowser(type: BrowserType, headed: boolean): Promise<Browser> {
  const opts = { headless: !headed };
  switch (type) {
    case 'firefox': return firefox.launch(opts);
    case 'webkit': return webkit.launch(opts);
    default: return chromium.launch(opts);
  }
}

export class PageCrawler {
  private formDetector = new FormDetector();
  private authHandler = new AuthHandler();
  private authenticated = false;

  constructor(private options: CrawlerOptions) {
    mkdirSync(options.screenshotDir, { recursive: true });
  }

  async crawl(): Promise<PageTestResult[]> {
    const { crawl, excludePaths, frontendUrl } = this.options;

    const browser = await launchBrowser(
      this.options.browser,
      this.options.headed ?? false,
    );

    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      page = await context.newPage();

      const crawlState = new CrawlState(
        crawl.maxPages,
        crawl.maxDepth,
        excludePaths,
        frontendUrl,
      );
      crawlState.enqueue({ url: frontendUrl, depth: 0, referrer: '' });

      while (!crawlState.shouldStop()) {
        const target = crawlState.dequeue();
        if (!target) break;
        crawlState.markVisited(target.normalizedUrl);

        const result = await this.visitPage(page, target.url, target.normalizedUrl, target.depth);
        crawlState.results.push(result);

        for (const el of result.interactiveElements) {
          if (el.href) {
            crawlState.enqueue({
              url: el.href,
              depth: target.depth + 1,
              referrer: target.url,
              elementSelector: el.selector,
            });
          }
        }
      }

      return crawlState.results;
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async testSinglePage(url: string): Promise<PageTestResult> {
    const browser = await launchBrowser(
      this.options.browser,
      this.options.headed ?? false,
    );

    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      page = await context.newPage();

      const normalized = normalizeUrl(url, this.options.frontendUrl);
      return await this.visitPage(page, url, normalized, 0);
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  private async visitPage(
    page: Page,
    url: string,
    normalizedUrl: string,
    depth: number,
  ): Promise<PageTestResult> {
    const monitor = new NetworkMonitor();
    const consoleErrors: string[] = [];

    const onConsole = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    };
    page.on('console', onConsole);
    monitor.attach(page);

    let loadTimeMs = 0;
    let screenshot = '';
    let interactiveElements: ElementInfo[] = [];
    let formsFound: FormTestResult['formInfo'][] = [];
    let formTestResults: FormTestResult[] = [];
    let networkValidation: NetworkValidationResult[] = [];

    try {
      const start = Date.now();
      const waitUntil = this.options.crawl.waitForNetworkIdle ? 'networkidle' as const : 'load' as const;
      await page.goto(url, { waitUntil, timeout: NAVIGATION_TIMEOUT });
      loadTimeMs = Date.now() - start;
    } catch {
      loadTimeMs = -1;
      try {
        const errPath = join(
          this.options.screenshotDir,
          `error_${sanitizeUrlToFilename(url)}.png`,
        );
        await page.screenshot({ path: errPath, fullPage: true });
        screenshot = errPath;
      } catch { /* ignore screenshot failure */ }

      return {
        url,
        normalizedUrl,
        depth,
        screenshot,
        interactiveElements: [],
        formsFound: [],
        formTestResults: [],
        networkRequests: monitor.getEntries(),
        networkValidation: [],
        consoleErrors: [...consoleErrors, `Navigation failed for ${url}`],
        loadTimeMs,
      };
    } finally {
      // cleanup happens after the try/catch for nav failures
    }

    try {
      if (!this.authenticated && this.options.testCredentials) {
        const isLogin = await this.authHandler.detectLoginPage(page);
        if (isLogin) {
          this.authenticated = await this.authHandler.authenticate(page, this.options.testCredentials);
        }
      }

      if (this.options.crawl.screenshotOnEveryPage) {
        const ssPath = join(
          this.options.screenshotDir,
          `${sanitizeUrlToFilename(normalizedUrl)}.png`,
        );
        await page.screenshot({ path: ssPath, fullPage: true });
        screenshot = ssPath;
      }

      formsFound = await this.formDetector.detectForms(page);
      formTestResults = await this.testForms(page, formsFound, monitor);

      interactiveElements = await this.discoverElements(page);

      networkValidation = monitor.validateAgainstContracts(this.options.contracts);
    } catch (err) {
      consoleErrors.push(
        `Page processing error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result: PageTestResult = {
      url,
      normalizedUrl,
      depth,
      screenshot,
      interactiveElements,
      formsFound,
      formTestResults,
      networkRequests: monitor.getEntries(),
      networkValidation,
      consoleErrors,
      loadTimeMs,
    };

    monitor.detach(page);
    page.off('console', onConsole);

    return result;
  }

  private async discoverElements(page: Page): Promise<ElementInfo[]> {
    try {
      const links: ElementInfo[] = await page.$$eval('a[href]', (els) =>
        els.map((el) => ({
          tag: 'a',
          selector: `a[href="${el.getAttribute('href') ?? ''}"]`,
          text: el.textContent?.trim() ?? '',
          href: (el as HTMLAnchorElement).href,
        })),
      );

      const buttons: ElementInfo[] = await page.$$eval(
        'button, input[type="button"], input[type="submit"]',
        (els) =>
          els.map((el) => ({
            tag: el.tagName.toLowerCase(),
            selector: el.id
              ? `#${el.id}`
              : `${el.tagName.toLowerCase()}:has-text("${el.textContent?.trim().slice(0, 30) ?? ''}")`,
            text: el.textContent?.trim() ?? '',
            type: el.getAttribute('type') ?? undefined,
          })),
      );

      return [...links, ...buttons];
    } catch {
      return [];
    }
  }

  private async testForms(
    page: Page,
    forms: FormTestResult['formInfo'][],
    monitor: NetworkMonitor,
  ): Promise<FormTestResult[]> {
    const results: FormTestResult[] = [];

    for (const form of forms) {
      const testData: Record<string, string> = {};
      for (const field of form.fields) {
        if (field.type === 'password') {
          testData[field.name] = 'TestPass123!';
        } else if (field.type === 'email') {
          testData[field.name] = 'test@example.com';
        } else if (field.type === 'number') {
          testData[field.name] = '42';
        } else if (field.type === 'checkbox' || field.type === 'radio') {
          testData[field.name] = 'true';
        } else if (field.name) {
          testData[field.name] = 'test-value';
        }
      }

      const result = await this.formDetector.fillAndSubmit(page, form, testData, monitor);
      results.push(result);
    }

    return results;
  }
}
