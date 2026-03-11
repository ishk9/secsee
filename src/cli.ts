#!/usr/bin/env node

import { Command } from "commander";
import { initConfig, loadConfig } from "./config/loader.js";
import fs from "node:fs/promises";
import path from "node:path";

const program = new Command("secsee")
  .version("0.1.0")
  .description("AI-powered E2E integration tester via MCP");

program.option("-p, --project <path>", "Project root directory", process.cwd());
program.option("-v, --verbose", "Enable verbose logging", false);

program
  .command("init")
  .description("Initialize SecSee configuration in current project")
  .action(async () => {
    const projectRoot = program.opts().project as string;
    await initConfig(projectRoot);
    console.log("SecSee initialized. Edit .secsee/config.json to configure your project.");
  });

program
  .command("analyze")
  .description("Scan the project and collect source files for LLM analysis")
  .action(async () => {
    const { scanProject } = await import("./analyzer/scanner.js");
    const projectRoot = program.opts().project as string;
    const snapshot = await scanProject(projectRoot);
    console.log(`Discovered ${snapshot.services.length} service(s), collected ${snapshot.files.length} file(s).`);
    for (const svc of snapshot.services) {
      console.log(`  - ${svc.name} (${svc.type}, ${svc.detectedFramework ?? "unknown"})`);
    }
    console.log("\nUse the MCP analyze_project tool from your IDE for full LLM-driven analysis.");
  });

program
  .command("up")
  .description("Run docker compose up -d --wait")
  .action(async () => {
    const { spinUp } = await import("./docker/compose.js");
    const projectRoot = program.opts().project as string;
    console.log("Starting services...");
    const result = await spinUp(projectRoot);
    console.log(result.success ? "Services started." : "Failed to start services.");
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exitCode = result.success ? 0 : 1;
  });

program
  .command("down")
  .description("Run docker compose down")
  .option("-v, --volumes", "Also remove volumes")
  .action(async (opts) => {
    const { tearDown } = await import("./docker/compose.js");
    const projectRoot = program.opts().project as string;
    console.log("Stopping services...");
    const result = await tearDown(projectRoot, opts.volumes ?? false);
    console.log(result.success ? "Services stopped." : "Failed to stop services.");
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exitCode = result.success ? 0 : 1;
  });

program
  .command("test")
  .description("Run full E2E test suite (API + frontend)")
  .option("--skip-analyze", "Skip analysis, use existing working.json")
  .option("--keep-alive", "Don't tear down services after testing")
  .option("--headed", "Run Playwright in headed mode")
  .action(async (opts) => {
    const projectRoot = program.opts().project as string;
    const config = await loadConfig(projectRoot);
    const secseeDir = path.join(projectRoot, ".secsee");

    if (!opts.skipAnalyze) {
      console.log("Run 'secsee analyze' or use the MCP analyze_project tool first.");
    }

    let analysis: any;
    try {
      const raw = await fs.readFile(path.join(secseeDir, "working.json"), "utf-8");
      analysis = JSON.parse(raw);
    } catch {
      console.error("No working.json found. Run analysis first.");
      process.exitCode = 1;
      return;
    }

    // API tests
    console.log("\n--- API Tests ---");
    const { ApiTestRunner } = await import("./tester/api/test-runner.js");
    const apiRunner = new ApiTestRunner(config);
    const apiResults = await apiRunner.runAll(analysis.services);
    const apiPass = apiResults.filter((r: any) => r.status === "pass").length;
    console.log(`API: ${apiPass}/${apiResults.length} passed`);
    await fs.writeFile(path.join(secseeDir, "api-results.json"), JSON.stringify(apiResults, null, 2));

    // Frontend tests
    console.log("\n--- Frontend Tests ---");
    const { PageCrawler } = await import("./tester/frontend/crawler.js");
    const screenshotDir = path.join(secseeDir, "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });
    const crawler = new PageCrawler({
      frontendUrl: config.frontendUrl,
      browser: config.browser,
      crawl: config.crawl,
      excludePaths: config.excludePaths,
      testCredentials: config.testCredentials,
      contracts: analysis.services.flatMap((s: any) => s.endpoints),
      headed: opts.headed ?? false,
      screenshotDir,
    });
    const feResults = await crawler.crawl();
    console.log(`Frontend: ${feResults.length} pages crawled`);
    await fs.writeFile(path.join(secseeDir, "frontend-results.json"), JSON.stringify(feResults, null, 2));

    // Report
    console.log("\n--- Generating Report ---");
    const { ReportBuilder } = await import("./report/builder.js");
    const { renderMarkdown } = await import("./report/markdown-renderer.js");
    const report = new ReportBuilder()
      .withApiResults(apiResults)
      .withFrontendResults(feResults)
      .build();
    const md = renderMarkdown(report);
    await fs.writeFile(path.join(secseeDir, "test-report.md"), md);
    console.log(`Report saved to .secsee/test-report.md`);
    console.log(`\nSummary: ${report.summary.passed} pass, ${report.summary.failed} fail, ${report.summary.errors} error`);
  });

program
  .command("test:api")
  .description("Run API integration tests only")
  .action(async () => {
    const projectRoot = program.opts().project as string;
    const config = await loadConfig(projectRoot);
    const secseeDir = path.join(projectRoot, ".secsee");

    let analysis: any;
    try {
      const raw = await fs.readFile(path.join(secseeDir, "working.json"), "utf-8");
      analysis = JSON.parse(raw);
    } catch {
      console.error("No working.json found. Run analysis first.");
      process.exitCode = 1;
      return;
    }

    const { ApiTestRunner } = await import("./tester/api/test-runner.js");
    const runner = new ApiTestRunner(config);
    const results = await runner.runAll(analysis.services);
    await fs.writeFile(path.join(secseeDir, "api-results.json"), JSON.stringify(results, null, 2));

    for (const r of results) {
      const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!";
      console.log(`  ${icon} ${r.method} ${r.endpoint} [${r.actualResponse.latencyMs}ms] ${r.status}`);
    }
    const pass = results.filter((r: any) => r.status === "pass").length;
    console.log(`\n${pass}/${results.length} passed`);
  });

program
  .command("test:ui")
  .description("Run Playwright frontend tests only")
  .option("--headed", "Launch browser in headed mode")
  .option("--page <url>", "Test a specific page only")
  .action(async (opts) => {
    const projectRoot = program.opts().project as string;
    const config = await loadConfig(projectRoot);
    const secseeDir = path.join(projectRoot, ".secsee");

    let contracts: any[] = [];
    try {
      const raw = await fs.readFile(path.join(secseeDir, "working.json"), "utf-8");
      contracts = JSON.parse(raw).services.flatMap((s: any) => s.endpoints);
    } catch { /* continue without contracts */ }

    const screenshotDir = path.join(secseeDir, "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });

    const { PageCrawler } = await import("./tester/frontend/crawler.js");
    const crawler = new PageCrawler({
      frontendUrl: config.frontendUrl,
      browser: config.browser,
      crawl: config.crawl,
      excludePaths: config.excludePaths,
      testCredentials: config.testCredentials,
      contracts,
      headed: opts.headed ?? false,
      screenshotDir,
    });

    if (opts.page) {
      const result = await crawler.testSinglePage(opts.page);
      console.log(`  ${result.url} — ${result.loadTimeMs}ms, ${result.formsFound.length} forms, ${result.consoleErrors.length} errors`);
    } else {
      const results = await crawler.crawl();
      await fs.writeFile(path.join(secseeDir, "frontend-results.json"), JSON.stringify(results, null, 2));
      for (const r of results) {
        console.log(`  ${r.url} — ${r.loadTimeMs}ms, ${r.formsFound.length} forms, ${r.consoleErrors.length} errors`);
      }
      console.log(`\n${results.length} pages crawled`);
    }
  });

program
  .command("report")
  .description("View the latest test report")
  .option("--format <type>", "Output format: markdown, json", "markdown")
  .action(async (opts) => {
    const projectRoot = program.opts().project as string;
    const secseeDir = path.join(projectRoot, ".secsee");
    const file = opts.format === "json" ? "test-report.json" : "test-report.md";
    try {
      const content = await fs.readFile(path.join(secseeDir, file), "utf-8");
      console.log(content);
    } catch {
      console.error(`No report found. Run 'secsee test' first.`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
