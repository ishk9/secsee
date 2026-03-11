import type {
  ApiTestResult,
  DbSnapshot,
  EndpointDefinition,
  SecseeConfig,
  ServiceAnalysis,
  TestCase,
  TestContext,
  TestStatus,
  ValidationContext,
} from "../../types/index.js";
import { createDbVerifier } from "../../db/interface.js";
import type { IDbVerifier } from "../../db/interface.js";
import { generateTestCases } from "./test-generator.js";
import { buildRequest } from "./request-builder.js";
import { buildValidationChain } from "./validators/chain.js";

export class ApiTestRunner {
  constructor(private config: SecseeConfig) {}

  async runAll(services: ServiceAnalysis[]): Promise<ApiTestResult[]> {
    const endpoints = services.flatMap((s) => s.endpoints);
    const testCases = generateTestCases(endpoints, this.config.services);

    const verifiers = await this.connectVerifiers();
    const chain = buildValidationChain();
    const context: TestContext = { resources: {} };
    const results: ApiTestResult[] = [];

    try {
      for (const tc of testCases) {
        const result = await this.executeTestCase(
          tc,
          context,
          services,
          verifiers,
          chain,
        );
        results.push(result);

        if (
          tc.method === "POST" &&
          result.status === "pass" &&
          result.actualResponse.status === 201
        ) {
          const body = result.actualResponse.body as Record<string, unknown> | null;
          if (body && typeof body === "object" && "id" in body) {
            const resourceKey = tc.endpoint.path.split("/").filter(Boolean).pop() ?? tc.endpoint.path;
            context.resources[resourceKey] = String(body.id);
          }
        }
      }
    } finally {
      await this.disconnectVerifiers(verifiers);
    }

    return results;
  }

  async runSingle(
    endpointPath: string,
    method: string,
    services: ServiceAnalysis[],
  ): Promise<ApiTestResult> {
    const endpoints = services.flatMap((s) => s.endpoints);
    const target = endpoints.find(
      (ep) =>
        ep.path === endpointPath &&
        ep.method.toUpperCase() === method.toUpperCase(),
    );

    if (!target) {
      return {
        endpoint: endpointPath,
        method,
        status: "error",
        request: { headers: {}, body: null },
        expectedResponse: { status: 0, bodySchema: {} },
        actualResponse: { status: 0, headers: {}, body: null, latencyMs: 0 },
        dbValidation: { passed: false, diff: null },
        webhookValidation: null,
        validationErrors: [`Endpoint ${method} ${endpointPath} not found`],
      };
    }

    const testCases = generateTestCases([target], this.config.services);
    if (testCases.length === 0) {
      return {
        endpoint: endpointPath,
        method,
        status: "skip",
        request: { headers: {}, body: null },
        expectedResponse: { status: 0, bodySchema: {} },
        actualResponse: { status: 0, headers: {}, body: null, latencyMs: 0 },
        dbValidation: { passed: true, diff: null },
        webhookValidation: null,
        validationErrors: [],
      };
    }

    const verifiers = await this.connectVerifiers();
    const chain = buildValidationChain();
    const context: TestContext = { resources: {} };

    try {
      return await this.executeTestCase(
        testCases[0],
        context,
        services,
        verifiers,
        chain,
      );
    } finally {
      await this.disconnectVerifiers(verifiers);
    }
  }

  private async executeTestCase(
    tc: TestCase,
    context: TestContext,
    services: ServiceAnalysis[],
    verifiers: IDbVerifier[],
    chain: ReturnType<typeof buildValidationChain>,
  ): Promise<ApiTestResult> {
    const baseUrl = this.resolveBaseUrl(tc.endpoint, services);
    const built = buildRequest(tc, context, baseUrl);

    let dbBefore: DbSnapshot | null = null;
    let dbAfter: DbSnapshot | null = null;

    const affectedTables = tc.endpoint.dbInteractions.map((d) => d.table);
    const primaryTable = affectedTables[0] ?? null;

    if (primaryTable && verifiers.length > 0) {
      dbBefore = await verifiers[0].snapshot(primaryTable);
    }

    let status: number;
    let responseHeaders: Record<string, string>;
    let responseBody: unknown;
    let latencyMs: number;

    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.config.timeout,
      );

      const start = performance.now();
      const response = await fetch(built.url, {
        method: built.method,
        headers: built.headers,
        body:
          built.body != null && built.method !== "GET"
            ? JSON.stringify(built.body)
            : undefined,
        signal: controller.signal,
      });
      latencyMs = Math.round(performance.now() - start);
      clearTimeout(timer);

      status = response.status;
      responseHeaders = Object.fromEntries(response.headers.entries());

      const text = await response.text();
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      const isTimeout =
        err instanceof DOMException && err.name === "AbortError";

      return {
        endpoint: tc.path,
        method: tc.method,
        status: "error" as TestStatus,
        request: { headers: built.headers, body: built.body },
        expectedResponse: {
          status: tc.expectedStatus,
          bodySchema: tc.expectedBodySchema,
        },
        actualResponse: { status: 0, headers: {}, body: null, latencyMs: 0 },
        dbValidation: { passed: false, diff: null },
        webhookValidation: null,
        validationErrors: [
          isTimeout
            ? `Request timed out after ${this.config.timeout}ms`
            : `Network error: ${message}`,
        ],
      };
    }

    if (primaryTable && verifiers.length > 0) {
      dbAfter = await verifiers[0].snapshot(primaryTable);
    }

    const validationCtx: ValidationContext = {
      endpoint: tc.endpoint,
      request: {
        url: built.url,
        method: built.method,
        headers: built.headers,
        body: built.body,
      },
      response: {
        status,
        headers: responseHeaders,
        body: responseBody,
      },
      dbBefore,
      dbAfter,
    };

    const validationResults = await chain.handle(validationCtx);
    const validationErrors = validationResults
      .filter((v) => !v.passed)
      .map((v) => `[${v.validatorName}] ${v.message}`);

    const dbDiff =
      dbBefore && dbAfter && verifiers.length > 0
        ? verifiers[0].diff(dbBefore, dbAfter)
        : null;
    const dbPassed = validationResults
      .filter((v) => v.validatorName === "DbStateValidator")
      .every((v) => v.passed);

    const testStatus: TestStatus =
      validationErrors.length === 0 ? "pass" : "fail";

    return {
      endpoint: tc.path,
      method: tc.method,
      status: testStatus,
      request: { headers: built.headers, body: built.body },
      expectedResponse: {
        status: tc.expectedStatus,
        bodySchema: tc.expectedBodySchema,
      },
      actualResponse: {
        status,
        headers: responseHeaders,
        body: responseBody,
        latencyMs,
      },
      dbValidation: { passed: dbPassed, diff: dbDiff },
      webhookValidation: null,
      validationErrors,
    };
  }

  private resolveBaseUrl(
    endpoint: EndpointDefinition,
    services: ServiceAnalysis[],
  ): string {
    const svcConfig = this.config.services.find(
      (s) => s.name === endpoint.service,
    );

    if (svcConfig?.baseUrl) return svcConfig.baseUrl;
    if (svcConfig?.port) return `http://localhost:${svcConfig.port}`;

    const svcAnalysis = services.find((s) => s.name === endpoint.service);
    if (svcAnalysis) {
      const matchedConfig = this.config.services.find(
        (sc) => sc.name === svcAnalysis.name,
      );
      if (matchedConfig?.baseUrl) return matchedConfig.baseUrl;
      if (matchedConfig?.port) return `http://localhost:${matchedConfig.port}`;
    }

    return "http://localhost:3000";
  }

  private async connectVerifiers(): Promise<IDbVerifier[]> {
    const verifiers: IDbVerifier[] = [];
    for (const dbConfig of this.config.db) {
      const verifier = createDbVerifier(dbConfig);
      await verifier.connect();
      verifiers.push(verifier);
    }
    return verifiers;
  }

  private async disconnectVerifiers(verifiers: IDbVerifier[]): Promise<void> {
    for (const v of verifiers) {
      await v.disconnect();
    }
  }
}
