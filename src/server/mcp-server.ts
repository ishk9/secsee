import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { scanProject } from "../analyzer/scanner.js";
import { writeWorkingDoc } from "../analyzer/working-doc-writer.js";
import { spinUp, tearDown } from "../docker/compose.js";
import { ApiTestRunner } from "../tester/api/test-runner.js";
import { PageCrawler } from "../tester/frontend/crawler.js";
import { ReportBuilder } from "../report/builder.js";
import { renderMarkdown } from "../report/markdown-renderer.js";
import { renderJson } from "../report/json-renderer.js";
import { loadConfig } from "../config/loader.js";
import type { ServiceAnalysis } from "../types/index.js";

async function readWorkingJson(projectRoot: string): Promise<{ services: ServiceAnalysis[] }> {
  const jsonPath = path.join(projectRoot, ".secsee", "working.json");
  const raw = await fs.readFile(jsonPath, "utf-8");
  return JSON.parse(raw);
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "secsee", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );

  const projectRootInput = z.object({
    projectRoot: z.string().describe("Absolute path to the project root directory"),
  });

  // ─── Phase 1: Analysis ───

  server.registerTool("analyze_project", {
    description: [
      "Scan the project to discover services and collect source files.",
      "Returns the full project structure with file contents so the LLM",
      "can analyze endpoints, DB interactions, auth schemes, etc.",
      "After reviewing the output, call update_working_doc with the structured analysis.",
    ].join(" "),
    inputSchema: projectRootInput,
  }, async ({ projectRoot }) => {
    const snapshot = await scanProject(projectRoot);

    const summary = [
      `# Project Snapshot`,
      ``,
      `**Root:** ${snapshot.projectRoot}`,
      `**Services found:** ${snapshot.services.length}`,
      `**Source files collected:** ${snapshot.files.length}`,
      `**Scanned at:** ${new Date(snapshot.discoveredAt).toISOString()}`,
      ``,
      `## Services`,
      ``,
      ...snapshot.services.map((s) =>
        `- **${s.name}** (${s.type}, framework: ${s.detectedFramework ?? "unknown"})` +
        (s.composePorts?.length
          ? ` — ports: ${s.composePorts.map((p) => `${p.host}:${p.container}`).join(", ")}`
          : "")
      ),
    ];

    if (snapshot.dockerCompose) {
      summary.push(``, `## docker-compose.yml`, ``, "```yaml", snapshot.dockerCompose, "```");
    }

    summary.push(``, `## Source Files`, ``);

    for (const file of snapshot.files) {
      const ext = file.relativePath.split(".").pop() ?? "";
      summary.push(
        `### ${file.relativePath} (${file.sizeBytes} bytes)`,
        ``,
        `\`\`\`${ext}`,
        file.content,
        `\`\`\``,
        ``
      );
    }

    summary.push(
      ``,
      `---`,
      ``,
      `Now analyze the above source files and call **update_working_doc** with a JSON object containing:`,
      `- services: array of { name, framework, type, endpoints, dbInteractions, outboundCalls, authScheme }`,
      `- Each endpoint should include: method, path, summary, auth, request (headers, queryParams, body), response (statusCodes), dbInteractions, outboundCalls, dependsOn`,
      ``,
    );

    return { content: [{ type: "text" as const, text: summary.join("\n") }] };
  });

  server.registerTool("update_working_doc", {
    description: "Accept structured project analysis from the LLM and write working.md + working.json.",
    inputSchema: z.object({
      projectRoot: z.string().describe("Absolute path to the project root directory"),
      analysis: z.object({
        services: z.array(z.object({
          name: z.string(),
          framework: z.string(),
          type: z.enum(["backend", "frontend", "database"]),
          endpoints: z.array(z.any()).describe("Array of EndpointDefinition objects"),
          dbInteractions: z.array(z.any()).describe("Array of DbInteraction objects"),
          outboundCalls: z.array(z.any()).describe("Array of OutboundCall objects"),
          authScheme: z.any().nullable().describe("AuthScheme or null"),
        })),
      }).describe("Structured analysis output from the LLM"),
    }),
  }, async ({ projectRoot, analysis }) => {
    const result = await writeWorkingDoc(projectRoot, analysis);
    return {
      content: [{
        type: "text" as const,
        text: `working.md written to ${result.mdPath} (${result.endpointCount} endpoints across ${result.serviceCount} services). JSON saved to ${result.jsonPath}.`,
      }],
    };
  });

  // ─── Phase 2: Docker ───

  server.registerTool("spin_up_services", {
    description: "Run docker compose up -d --wait to start all services",
    inputSchema: projectRootInput,
  }, async ({ projectRoot }) => {
    const result = await spinUp(projectRoot);
    const text = result.success
      ? `Services started successfully.\n\n${result.stdout}\n${result.stderr}`.trim()
      : `Failed to start services.\n\n${result.stderr}\n${result.stdout}`.trim();
    return { content: [{ type: "text" as const, text }] };
  });

  server.registerTool("tear_down_services", {
    description: "Run docker compose down to stop and remove all containers",
    inputSchema: z.object({
      projectRoot: z.string().describe("Absolute path to the project root directory"),
      removeVolumes: z.boolean().optional().describe("Also remove Docker volumes"),
    }),
  }, async ({ projectRoot, removeVolumes }) => {
    const result = await tearDown(projectRoot, removeVolumes ?? false);
    const text = result.success
      ? `Services stopped.\n\n${result.stdout}\n${result.stderr}`.trim()
      : `Failed to stop services.\n\n${result.stderr}\n${result.stdout}`.trim();
    return { content: [{ type: "text" as const, text }] };
  });

  // ─── Phase 3: API Testing ───

  server.registerTool("test_apis", {
    description: "Run all API integration tests based on working.json analysis",
    inputSchema: projectRootInput,
  }, async ({ projectRoot }) => {
    const config = await loadConfig(projectRoot);
    const analysis = await readWorkingJson(projectRoot);
    const runner = new ApiTestRunner(config);
    const results = await runner.runAll(analysis.services);

    const pass = results.filter((r) => r.status === "pass").length;
    const fail = results.filter((r) => r.status === "fail").length;
    const err = results.filter((r) => r.status === "error").length;

    const resultsPath = path.join(projectRoot, ".secsee", "api-results.json");
    await fs.mkdir(path.dirname(resultsPath), { recursive: true });
    await fs.writeFile(resultsPath, JSON.stringify(results, null, 2), "utf-8");

    const lines = [
      `# API Test Results`,
      ``,
      `**Total:** ${results.length} | **Pass:** ${pass} | **Fail:** ${fail} | **Error:** ${err}`,
      ``,
      `| Endpoint | Status | Latency |`,
      `|----------|--------|---------|`,
      ...results.map((r) =>
        `| ${r.method} ${r.endpoint} | ${r.status} | ${r.actualResponse.latencyMs}ms |`
      ),
    ];

    if (fail > 0 || err > 0) {
      lines.push(``, `## Failures`, ``);
      for (const r of results.filter((r) => r.status !== "pass")) {
        lines.push(`### ${r.method} ${r.endpoint} (${r.status})`);
        for (const e of r.validationErrors) lines.push(`- ${e}`);
        lines.push(``);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });

  server.registerTool("test_single_endpoint", {
    description: "Test a specific API endpoint by path and method",
    inputSchema: z.object({
      projectRoot: z.string().describe("Absolute path to the project root directory"),
      path: z.string().describe("The endpoint path (e.g., /api/users)"),
      method: z.string().describe("HTTP method (GET, POST, PUT, DELETE, PATCH)"),
    }),
  }, async ({ projectRoot, path: epPath, method }) => {
    const config = await loadConfig(projectRoot);
    const analysis = await readWorkingJson(projectRoot);
    const runner = new ApiTestRunner(config);
    const result = await runner.runSingle(epPath, method, analysis.services);

    const lines = [
      `## ${result.method} ${result.endpoint}: ${result.status}`,
      ``,
      `**Latency:** ${result.actualResponse.latencyMs}ms`,
      `**Expected status:** ${result.expectedResponse.status}`,
      `**Actual status:** ${result.actualResponse.status}`,
    ];
    if (result.validationErrors.length > 0) {
      lines.push(``, `**Errors:**`);
      for (const e of result.validationErrors) lines.push(`- ${e}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });

  // ─── Phase 4: Frontend Testing ───

  server.registerTool("test_frontend", {
    description: "Launch Playwright and crawl the frontend, testing all pages and forms",
    inputSchema: z.object({
      projectRoot: z.string().describe("Absolute path to the project root directory"),
      headed: z.boolean().optional().describe("Run browser in headed mode"),
    }),
  }, async ({ projectRoot, headed }) => {
    const config = await loadConfig(projectRoot);
    let contracts: any[] = [];
    try {
      const analysis = await readWorkingJson(projectRoot);
      contracts = analysis.services.flatMap((s) => s.endpoints);
    } catch { /* no working.json yet */ }

    const screenshotDir = path.join(projectRoot, ".secsee", "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });

    const crawler = new PageCrawler({
      frontendUrl: config.frontendUrl,
      browser: config.browser,
      crawl: config.crawl,
      excludePaths: config.excludePaths,
      testCredentials: config.testCredentials,
      contracts,
      headed: headed ?? false,
      screenshotDir,
    });

    const results = await crawler.crawl();

    const resultsPath = path.join(projectRoot, ".secsee", "frontend-results.json");
    await fs.writeFile(resultsPath, JSON.stringify(results, null, 2), "utf-8");

    const lines = [
      `# Frontend Test Results`,
      ``,
      `**Pages crawled:** ${results.length}`,
      `**Console errors:** ${results.reduce((n, r) => n + r.consoleErrors.length, 0)}`,
      `**Forms tested:** ${results.reduce((n, r) => n + r.formTestResults.length, 0)}`,
      ``,
      `| Page | Load Time | Forms | Errors |`,
      `|------|-----------|-------|--------|`,
      ...results.map((r) =>
        `| ${r.url} | ${r.loadTimeMs}ms | ${r.formsFound.length} | ${r.consoleErrors.length} |`
      ),
    ];

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });

  server.registerTool("test_page", {
    description: "Test a specific frontend page with Playwright",
    inputSchema: z.object({
      projectRoot: z.string().describe("Absolute path to the project root directory"),
      url: z.string().describe("The page URL or path to test"),
    }),
  }, async ({ projectRoot, url }) => {
    const config = await loadConfig(projectRoot);
    let contracts: any[] = [];
    try {
      const analysis = await readWorkingJson(projectRoot);
      contracts = analysis.services.flatMap((s) => s.endpoints);
    } catch { /* no working.json */ }

    const screenshotDir = path.join(projectRoot, ".secsee", "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });

    const crawler = new PageCrawler({
      frontendUrl: config.frontendUrl,
      browser: config.browser,
      crawl: config.crawl,
      excludePaths: config.excludePaths,
      testCredentials: config.testCredentials,
      contracts,
      headed: false,
      screenshotDir,
    });

    const result = await crawler.testSinglePage(url);

    const lines = [
      `## ${result.url}`,
      `**Load time:** ${result.loadTimeMs}ms`,
      `**Elements:** ${result.interactiveElements.length}`,
      `**Forms:** ${result.formsFound.length}`,
      `**Console errors:** ${result.consoleErrors.length}`,
      `**Network requests:** ${result.networkRequests.length}`,
    ];
    if (result.consoleErrors.length > 0) {
      lines.push(``, `**Console errors:**`);
      for (const e of result.consoleErrors) lines.push(`- ${e}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });

  // ─── Phase 5: Reporting ───

  server.registerTool("generate_report", {
    description: "Generate a combined test report from the latest test results",
    inputSchema: z.object({
      projectRoot: z.string().describe("Absolute path to the project root directory"),
      format: z.enum(["markdown", "json", "both"]).optional().describe("Output format"),
    }),
  }, async ({ projectRoot, format }) => {
    const fmt = format ?? "both";
    const secseeDir = path.join(projectRoot, ".secsee");
    const builder = new ReportBuilder();

    try {
      const apiRaw = await fs.readFile(path.join(secseeDir, "api-results.json"), "utf-8");
      builder.withApiResults(JSON.parse(apiRaw));
    } catch { /* no API results */ }

    try {
      const feRaw = await fs.readFile(path.join(secseeDir, "frontend-results.json"), "utf-8");
      builder.withFrontendResults(JSON.parse(feRaw));
    } catch { /* no frontend results */ }

    const report = builder.build();

    const outputs: string[] = [];
    if (fmt === "markdown" || fmt === "both") {
      const md = renderMarkdown(report);
      const mdPath = path.join(secseeDir, "test-report.md");
      await fs.writeFile(mdPath, md, "utf-8");
      outputs.push(`Markdown report: ${mdPath}`);
    }
    if (fmt === "json" || fmt === "both") {
      const json = renderJson(report);
      const jsonPath = path.join(secseeDir, "test-report.json");
      await fs.writeFile(jsonPath, json, "utf-8");
      outputs.push(`JSON report: ${jsonPath}`);
    }

    const summary = [
      `# Report Generated`,
      ``,
      `**Total tests:** ${report.summary.totalTests}`,
      `**Passed:** ${report.summary.passed}`,
      `**Failed:** ${report.summary.failed}`,
      `**Errors:** ${report.summary.errors}`,
      ``,
      ...outputs,
    ];

    return { content: [{ type: "text" as const, text: summary.join("\n") }] };
  });

  return server;
}
