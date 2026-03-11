// ============================================================
// SecSee — Shared TypeScript Interfaces & Types
// Follows LLD Sections 2, 3 exactly
// ============================================================

// --- Primitives ---

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type TestStatus = "pass" | "fail" | "skip" | "error";

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export type BrowserType = "chromium" | "firefox" | "webkit";

export type DbType = "postgres" | "mysql" | "mongodb";

export type ServiceType = "backend" | "frontend" | "database";


// --- LLD 3.1: Endpoint Definition (output of Analyzer) ---

export interface SchemaField {
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  example?: unknown;
  children?: Record<string, SchemaField>;
}

export interface AuthScheme {
  kind: "jwt" | "api-key" | "session" | "oauth2" | "basic";
  headerName?: string;
  tokenPrefix?: string;
}

export interface DbInteraction {
  table: string;
  operation: "create" | "read" | "update" | "delete";
  fields: string[];
  service: string;
}

export interface OutboundCall {
  targetUrl: string;
  method: HttpMethod;
  service: string;
  triggeredBy: string;
}

export interface EndpointDefinition {
  service: string;
  method: HttpMethod;
  path: string;
  summary: string;
  auth: AuthScheme | null;
  request: {
    headers: Record<string, SchemaField>;
    queryParams: Record<string, SchemaField>;
    body: Record<string, SchemaField> | null;
    contentType: string;
  };
  response: {
    statusCodes: {
      code: number;
      description: string;
      bodySchema: Record<string, SchemaField>;
    }[];
  };
  dbInteractions: DbInteraction[];
  outboundCalls: OutboundCall[];
  dependsOn: string[];
}

// --- LLD 3.2: Test Result Models ---

export interface NetworkEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  timestamp: number;
  type: "request" | "response";
}

export interface ElementInfo {
  tag: string;
  selector: string;
  text: string;
  href?: string;
  type?: string;
}

export interface FormFieldInfo {
  name: string;
  type: string;
  required: boolean;
  placeholder?: string;
}

export interface FormInfo {
  action: string;
  method: string;
  fields: FormFieldInfo[];
}

export interface FormTestResult {
  formInfo: FormInfo;
  dataSubmitted: Record<string, string>;
  networkRequest?: NetworkEntry;
  networkResponse?: NetworkEntry;
  validationErrors: string[];
  passed: boolean;
}

export interface NetworkValidationResult {
  networkEntry: NetworkEntry;
  contract: EndpointDefinition | null;
  passed: boolean;
  mismatches: string[];
}

export interface ApiTestResult {
  endpoint: string;
  method: string;
  status: TestStatus;
  request: { headers: Record<string, string>; body: unknown };
  expectedResponse: {
    status: number;
    bodySchema: Record<string, SchemaField>;
  };
  actualResponse: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    latencyMs: number;
  };
  dbValidation: { passed: boolean; diff: DbDiff | null };
  webhookValidation: { passed: boolean; detail: string } | null;
  validationErrors: string[];
}

export interface PageTestResult {
  url: string;
  normalizedUrl: string;
  depth: number;
  screenshot: string;
  interactiveElements: ElementInfo[];
  formsFound: FormInfo[];
  formTestResults: FormTestResult[];
  networkRequests: NetworkEntry[];
  networkValidation: NetworkValidationResult[];
  consoleErrors: string[];
  loadTimeMs: number;
}

// --- LLD 3.3: Configuration ---

export interface ServiceConfig {
  name: string;
  path: string;
  framework?: string;
  type: ServiceType;
  port?: number;
  baseUrl?: string;
}

export interface DbConnectionConfig {
  type: DbType;
  connectionString: string;
  name: string;
}

export interface CrawlConfig {
  maxDepth: number;
  maxPages: number;
  waitForNetworkIdle: boolean;
  screenshotOnEveryPage: boolean;
}

export interface TestCredentials {
  username: string;
  password: string;
}

export interface SecseeConfig {
  dockerComposePath: string;
  frontendUrl: string;
  services: ServiceConfig[];
  testCredentials?: TestCredentials;
  excludePaths: string[];
  crawl: CrawlConfig;
  timeout: number;
  browser: BrowserType;
  parallel: number;
  db: DbConnectionConfig[];
}


// --- LLD 2.5: BFS Crawl Data Structures ---

export interface CrawlTarget {
  url: string;
  normalizedUrl: string;
  depth: number;
  referrer: string;
  elementSelector?: string;
}

// --- LLD 2.8: DB Verification ---

export interface DbSnapshot {
  table: string;
  rows: Record<string, unknown>[];
  timestamp: number;
}

export interface DbDiff {
  inserted: Record<string, unknown>[];
  deleted: Record<string, unknown>[];
  modified: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }[];
}

// --- LLD 2.9: Validation ---

export interface ValidationContext {
  endpoint: EndpointDefinition;
  request: { url: string; method: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
  dbBefore: DbSnapshot | null;
  dbAfter: DbSnapshot | null;
}

export interface ValidationResult {
  validatorName: string;
  passed: boolean;
  message: string;
  details?: unknown;
}

// --- LLD 2.7: Report ---

export interface Screenshot {
  path: string;
  url: string;
  timestamp: number;
}

export interface Issue {
  severity: IssueSeverity;
  message: string;
  endpoint?: string;
  page?: string;
  details?: string;
}

export interface TestReportSummary {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface TestReport {
  summary: TestReportSummary;
  apiResults: ApiTestResult[];
  frontendResults: PageTestResult[];
  networkValidation: NetworkValidationResult[];
  issues: Issue[];
  screenshots: Screenshot[];
  generatedAt: string;
}

// --- Analyzer Aggregate Types (LLM-driven, matches update_working_doc input) ---

export interface ServiceAnalysis {
  name: string;
  framework: string;
  type: ServiceType;
  endpoints: EndpointDefinition[];
  dbInteractions: DbInteraction[];
  outboundCalls: OutboundCall[];
  authScheme: AuthScheme | null;
}

// --- Docker Compose Parsing ---

export interface ComposeServiceDefinition {
  name: string;
  image?: string;
  build?: { context: string; dockerfile?: string };
  ports: { host: number; container: number }[];
  environment: Record<string, string>;
  dependsOn: string[];
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
  volumes: string[];
  networks: string[];
}

export interface ComposeDefinition {
  services: ComposeServiceDefinition[];
}

// --- Test Execution Context ---

export interface TestContext {
  resources: Record<string, string>;
  token?: string;
}

export interface TestCase {
  name: string;
  endpoint: EndpointDefinition;
  method: HttpMethod;
  path: string;
  request: {
    headers: Record<string, string>;
    body: unknown;
    queryParams: Record<string, string>;
  };
  expectedStatus: number;
  expectedBodySchema: Record<string, SchemaField>;
  tags: ("happy" | "negative" | "auth" | "method")[];
}
