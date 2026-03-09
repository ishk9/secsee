# SecSee — Low-Level Design

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    IDE (Cursor / Windsurf)               │
│                         │ MCP Protocol                   │
└─────────────────────────┼───────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  SecSee MCP Server                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Tool     │  │ Config   │  │ Session  │  │ Logger │  │
│  │ Registry │  │ Manager  │  │ Manager  │  │        │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┘  │
│       │              │             │                     │
│  ┌────▼──────────────▼─────────────▼──────────────────┐ │
│  │                  Tool Router                        │ │
│  └──┬──────────┬──────────┬──────────┬───────────┬────┘ │
│     ▼          ▼          ▼          ▼           ▼      │
│  Analyzer  DockerMgr  ApiTester  FrontendTester Report  │
└─────────────────────────────────────────────────────────┘
```

## 2. Design Patterns & Strategies

### 2.1 Strategy Pattern — Framework Analyzers

Each backend framework (Express, FastAPI, Flask, Spring Boot) has wildly different conventions for defining routes, middleware, and DB calls. A single monolithic analyzer would be unmaintainable.

**Strategy:** Define an `IFrameworkAnalyzer` interface. Each framework gets its own concrete implementation. The system auto-detects which strategy to use based on project markers (`package.json` → Express/Nest, `requirements.txt` → FastAPI/Flask, `pom.xml` → Spring Boot).

```
IFrameworkAnalyzer
├── ExpressAnalyzer      (ts-morph / @babel/parser)
├── FastAPIAnalyzer      (tree-sitter-python)
├── FlaskAnalyzer        (tree-sitter-python)
├── SpringBootAnalyzer   (tree-sitter-java)
└── GenericAnalyzer      (regex/heuristic fallback)
```

```typescript
interface IFrameworkAnalyzer {
  detect(servicePath: string): Promise<boolean>;
  extractEndpoints(servicePath: string): Promise<EndpointDefinition[]>;
  extractDbInteractions(servicePath: string): Promise<DbInteraction[]>;
  extractOutboundCalls(servicePath: string): Promise<OutboundCall[]>;
  extractAuthScheme(servicePath: string): Promise<AuthScheme | null>;
}
```

**Why:** New framework support = new class, zero changes to existing code. Open/Closed Principle.

### 2.2 Visitor Pattern — AST Traversal

When walking an AST to find route definitions, DB calls, and outbound HTTP calls, we need to inspect many different node types without coupling the traversal logic to the extraction logic.

**Strategy:** Implement AST visitors that walk the tree and collect specific patterns. Each visitor is responsible for one concern (routes, DB calls, HTTP calls).

```typescript
interface ASTVisitor<T> {
  visit(node: ASTNode, context: VisitorContext): T[];
}

class RouteDefinitionVisitor implements ASTVisitor<EndpointDefinition> { ... }
class DbCallVisitor implements ASTVisitor<DbInteraction> { ... }
class OutboundHttpVisitor implements ASTVisitor<OutboundCall> { ... }
```

Multiple visitors run over the same AST in a single pass via a `CompositeVisitor` that fans out to all registered visitors — avoids parsing the file multiple times.

### 2.3 Plugin Architecture — Analyzer Registry

The analyzer system is plugin-based. At startup, all `IFrameworkAnalyzer` implementations register themselves with an `AnalyzerRegistry`. When asked to analyze a service directory, the registry runs detection in priority order and delegates to the first match.

```typescript
class AnalyzerRegistry {
  private analyzers: IFrameworkAnalyzer[] = [];

  register(analyzer: IFrameworkAnalyzer, priority: number): void;
  async resolve(servicePath: string): Promise<IFrameworkAnalyzer>;
}
```

This also enables users to write custom analyzers as plugins in the future.

### 2.4 State Machine — Docker Container Lifecycle

Docker containers transition through well-defined states. Using an explicit state machine prevents invalid transitions (e.g., trying to health-check a container that hasn't started) and makes error recovery predictable.

```
         ┌──────────────────────────────────────┐
         ▼                                      │
    [NOT_CREATED] ──create──> [CREATED] ──start──> [STARTING]
                                                      │
                                               health check
                                                      │
                                    ┌────────────┬────┴────┐
                                    ▼            ▼         ▼
                                [HEALTHY]   [UNHEALTHY]  [FAILED]
                                    │            │
                                    └─────┬──────┘
                                          │ stop
                                          ▼
                                      [STOPPED]
                                          │ remove
                                          ▼
                                     [REMOVED]
```

```typescript
interface ContainerState {
  name: string;
  status: 'not_created' | 'created' | 'starting' | 'healthy' | 'unhealthy' | 'failed' | 'stopped' | 'removed';
  port?: number;
  healthCheckAttempts: number;
  error?: string;
}
```

Transitions are driven by a `DockerOrchestrator` that manages all containers as a group and handles partial-failure recovery (e.g., if DB starts but API server fails, it tears down cleanly).

### 2.5 BFS Crawl with Visited Set — Playwright Page Discovery

The frontend crawler must discover all pages without getting stuck in loops. This is a classic graph traversal problem where pages are nodes and links are edges.

**Data Structures:**

```typescript
interface CrawlState {
  queue: CrawlTarget[];          // BFS FIFO queue
  visited: Set<string>;          // Normalized URLs already processed
  results: PageTestResult[];     // Results per page
  networkLog: NetworkEntry[];    // All captured requests/responses
  sessionCookies: string[];      // Maintained auth state
}

interface CrawlTarget {
  url: string;
  normalizedUrl: string;
  depth: number;                 // Distance from start page
  referrer: string;              // Which page linked here
  elementSelector?: string;      // The element that led here (for reporting)
}
```

**URL Normalization** is critical. These should all resolve to the same page:
- `/dashboard`, `/dashboard/`, `/dashboard?tab=overview`, `http://localhost:3000/dashboard`

```typescript
function normalizeUrl(raw: string, baseUrl: string): string {
  const url = new URL(raw, baseUrl);
  url.search = '';          // strip query params
  url.hash = '';            // strip fragment
  let path = url.pathname;
  if (path.endsWith('/') && path !== '/') {
    path = path.slice(0, -1);  // strip trailing slash
  }
  return `${url.origin}${path}`;
}
```

**Loop Prevention:** Before enqueuing, check `visited.has(normalizedUrl)`. Also enforce a `maxDepth` (default: 10) and `maxPages` (default: 100) to bound the crawl.

**SPA Handling:** After clicking a link/button, wait for either a `popstate` event, `pushState` interception, or network idle — whichever comes first. Compare `page.url()` before and after to detect client-side route changes.

### 2.6 Observer Pattern — Network Request Interception

During Playwright testing, we need to capture every network request and response for validation. This maps directly to the Observer pattern via Playwright's event emitters.

```typescript
class NetworkMonitor {
  private entries: NetworkEntry[] = [];

  attach(page: Page): void {
    page.on('request', (req) => {
      this.entries.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData(),
        timestamp: Date.now(),
        type: 'request',
      });
    });

    page.on('response', (res) => {
      // Match to corresponding request and attach response data
    });
  }

  getEntriesForUrl(urlPattern: string): NetworkEntry[];
  validateAgainstContract(contract: EndpointDefinition): ValidationResult;
}
```

Each captured request is later matched against the endpoint contracts from `working.md` to verify:
- Correct method and path
- Expected request headers present
- Payload matches expected schema
- Response status and body match expected shape

### 2.7 Builder Pattern — Report Generation

The final report is assembled from many heterogeneous data sources (API test results, frontend crawl results, network logs, screenshots). A Builder lets us construct this incrementally without a massive constructor.

```typescript
class ReportBuilder {
  private report: TestReport = { sections: [] };

  withSummary(pass: number, fail: number, skip: number): this;
  withApiResults(results: ApiTestResult[]): this;
  withFrontendResults(results: PageTestResult[]): this;
  withNetworkValidation(results: NetworkValidationResult[]): this;
  withScreenshots(screenshots: Screenshot[]): this;
  withIssues(issues: Issue[]): this;

  toMarkdown(): string;
  toJson(): object;
  build(): TestReport;
}
```

### 2.8 Repository Pattern — DB Verification

API tests need to verify DB state changes across different database engines (Postgres, MySQL, MongoDB). The Repository pattern abstracts the DB-specific query logic behind a common interface.

```typescript
interface IDbVerifier {
  connect(connectionString: string): Promise<void>;
  snapshot(table: string, filter?: Record<string, any>): Promise<DbSnapshot>;
  diff(before: DbSnapshot, after: DbSnapshot): DbDiff;
  disconnect(): Promise<void>;
}

class PostgresVerifier implements IDbVerifier { ... }
class MongoVerifier implements IDbVerifier { ... }
class MySQLVerifier implements IDbVerifier { ... }
```

**Test flow:**
1. `snapshot("users")` → before state
2. Execute API call (POST /api/users)
3. `snapshot("users")` → after state
4. `diff(before, after)` → verify exactly 1 row inserted with expected fields

### 2.9 Chain of Responsibility — Request Validation Pipeline

When validating an API response, multiple checks run in sequence: status code → headers → body schema → DB state → webhook delivery. Each check is a handler in the chain.

```typescript
interface IValidationHandler {
  setNext(handler: IValidationHandler): IValidationHandler;
  handle(context: ValidationContext): Promise<ValidationResult>;
}

class StatusCodeValidator implements IValidationHandler { ... }
class HeaderValidator implements IValidationHandler { ... }
class BodySchemaValidator implements IValidationHandler { ... }
class DbStateValidator implements IValidationHandler { ... }
class WebhookValidator implements IValidationHandler { ... }
```

Each handler either passes, fails (with detail), or delegates to the next handler. Results accumulate into a `ValidationResult[]` per endpoint.

### 2.10 Topological Sort — Test Ordering

API endpoints have dependencies: you can't test `PUT /users/:id` before `POST /users` creates one. The `working.md` analysis captures these dependencies, and we use **topological sort** (Kahn's algorithm) to determine execution order.

```typescript
interface TestNode {
  endpointId: string;         // e.g., "POST /api/users"
  dependsOn: string[];        // e.g., [] (no deps)
}

// Kahn's algorithm produces execution order:
// 1. POST /api/users          (no deps)
// 2. GET /api/users/:id       (depends on 1)
// 3. PUT /api/users/:id       (depends on 1)
// 4. DELETE /api/users/:id    (depends on 1)
// 5. POST /api/orders         (depends on 1 — needs a user)
```

Circular dependencies are detected and reported as configuration errors.

## 3. Core Data Models

### 3.1 Endpoint Definition (output of Analyzer)

```typescript
interface EndpointDefinition {
  service: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
    statusCodes: { code: number; description: string; bodySchema: Record<string, SchemaField> }[];
  };
  dbInteractions: DbInteraction[];
  outboundCalls: OutboundCall[];
  dependsOn: string[];
}

interface SchemaField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  example?: any;
  children?: Record<string, SchemaField>;
}
```

### 3.2 Test Result Models

```typescript
interface ApiTestResult {
  endpoint: string;
  method: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  request: { headers: object; body: any };
  expectedResponse: { status: number; bodySchema: object };
  actualResponse: { status: number; headers: object; body: any; latencyMs: number };
  dbValidation: { passed: boolean; diff: DbDiff | null };
  webhookValidation: { passed: boolean; detail: string } | null;
  validationErrors: string[];
}

interface PageTestResult {
  url: string;
  normalizedUrl: string;
  depth: number;
  screenshot: string;           // file path
  interactiveElements: ElementInfo[];
  formsFound: FormInfo[];
  formTestResults: FormTestResult[];
  networkRequests: NetworkEntry[];
  networkValidation: NetworkValidationResult[];
  consoleErrors: string[];
  loadTimeMs: number;
}
```

### 3.3 Configuration

```typescript
interface SecseeConfig {
  dockerComposePath: string;
  frontendUrl: string;
  services: ServiceConfig[];
  testCredentials: { username: string; password: string };
  excludePaths: string[];
  crawl: {
    maxDepth: number;
    maxPages: number;
    waitForNetworkIdle: boolean;
    screenshotOnEveryPage: boolean;
  };
  timeout: number;
  browser: 'chromium' | 'firefox' | 'webkit';
  parallel: number;
  db: DbConnectionConfig[];
}
```

## 4. Module Structure

```
secsee/
├── src/
│   ├── index.ts                    # Entry point, MCP server bootstrap
│   ├── cli.ts                      # CLI entry point (commander)
│   ├── server/
│   │   ├── mcp-server.ts           # MCP server setup & tool registration
│   │   └── tools/                  # One file per MCP tool
│   │       ├── analyze-project.ts
│   │       ├── spin-up-services.ts
│   │       ├── tear-down-services.ts
│   │       ├── test-apis.ts
│   │       ├── test-frontend.ts
│   │       ├── test-single-endpoint.ts
│   │       ├── test-page.ts
│   │       ├── generate-report.ts
│   │       └── update-working-doc.ts
│   ├── analyzer/
│   │   ├── registry.ts             # AnalyzerRegistry (plugin system)
│   │   ├── interface.ts            # IFrameworkAnalyzer
│   │   ├── strategies/
│   │   │   ├── express.ts
│   │   │   ├── fastapi.ts
│   │   │   ├── flask.ts
│   │   │   ├── spring-boot.ts
│   │   │   └── generic.ts
│   │   ├── visitors/
│   │   │   ├── route-visitor.ts
│   │   │   ├── db-call-visitor.ts
│   │   │   └── outbound-http-visitor.ts
│   │   └── working-doc-generator.ts
│   ├── docker/
│   │   ├── orchestrator.ts         # DockerOrchestrator (state machine)
│   │   ├── health-checker.ts
│   │   └── compose-parser.ts
│   ├── tester/
│   │   ├── api/
│   │   │   ├── test-runner.ts      # Orchestrates API test execution
│   │   │   ├── test-generator.ts   # Generates test cases from working.md
│   │   │   ├── request-builder.ts
│   │   │   └── validators/
│   │   │       ├── chain.ts        # Chain of responsibility setup
│   │   │       ├── status-code.ts
│   │   │       ├── headers.ts
│   │   │       ├── body-schema.ts
│   │   │       ├── db-state.ts
│   │   │       └── webhook.ts
│   │   └── frontend/
│   │       ├── crawler.ts          # BFS page crawler
│   │       ├── page-tester.ts      # Per-page test logic
│   │       ├── network-monitor.ts  # Observer for req/res capture
│   │       ├── form-detector.ts    # Finds and interacts with forms
│   │       ├── auth-handler.ts     # Detects login, authenticates
│   │       └── url-normalizer.ts
│   ├── db/
│   │   ├── interface.ts            # IDbVerifier
│   │   ├── postgres.ts
│   │   ├── mysql.ts
│   │   └── mongo.ts
│   ├── report/
│   │   ├── builder.ts             # ReportBuilder
│   │   ├── markdown-renderer.ts
│   │   └── json-renderer.ts
│   ├── config/
│   │   ├── loader.ts
│   │   └── schema.ts              # Zod schema for config validation
│   └── types/
│       └── index.ts               # All shared TypeScript interfaces
├── package.json
├── tsconfig.json
└── .secsee/
    └── config.json
```

## 5. Key Algorithms

### 5.1 Service Discovery

```
for each subdir in project root:
  if has Dockerfile → candidate service
  detect framework:
    package.json with "express" dep → Express
    requirements.txt with "fastapi" → FastAPI
    pom.xml with spring-boot parent → Spring Boot
  run AnalyzerRegistry.resolve(path)
  extract endpoints, db calls, outbound calls
```

### 5.2 Crawler BFS

```
queue = [{ url: frontendUrl, depth: 0 }]
visited = Set()

while queue is not empty AND visited.size < maxPages:
  target = queue.shift()
  normalized = normalize(target.url)

  if visited.has(normalized) OR target.depth > maxDepth:
    continue

  visited.add(normalized)

  page.goto(target.url)
  wait for network idle

  attach NetworkMonitor
  screenshot()
  detect interactive elements
  test forms if found

  for each link/nav element on page:
    href = resolve(link.href, page.url)
    if same origin AND not in excludePaths AND not visited:
      queue.push({ url: href, depth: target.depth + 1 })
```

### 5.3 API Test Execution

```
endpoints = parse(working.md)
ordered = topologicalSort(endpoints)
context = {}  // stores created resource IDs across tests

for each endpoint in ordered:
  before = dbVerifier.snapshot(endpoint.affectedTables)
  response = execute(endpoint, context)
  after = dbVerifier.snapshot(endpoint.affectedTables)

  run validation chain:
    StatusCodeValidator → HeaderValidator → BodySchemaValidator
    → DbStateValidator(before, after) → WebhookValidator

  store created IDs in context for dependent tests
  record result
```

## 6. Concurrency Model

- **Docker startup:** Containers start in parallel (Docker Compose handles this natively). Health checks poll concurrently.
- **API tests:** Sequential by default (due to dependency ordering). Independent endpoints can run in parallel worker pools.
- **Playwright crawl:** Single browser context to maintain session state. Pages are tested sequentially within the BFS. Multiple browser contexts can run in parallel for independent page groups if `parallel > 1`.

## 7. Error Handling Strategy

| Failure Type | Handling |
|---|---|
| Container fails to start | Mark as FAILED, continue with remaining services, report degraded mode |
| API endpoint unreachable | Retry 3x with exponential backoff, then mark as ERROR |
| DB connection fails | Skip DB validation, report as SKIP with warning |
| Playwright navigation timeout | Screenshot current state, mark page as ERROR, continue crawl |
| Infinite redirect detected | Track redirect count, abort at 10, mark as ERROR |
| Auth flow fails | Abort crawl, report auth failure prominently |

## 8. Security Considerations

- Test credentials stored in `.secsee/config.json` — gitignore by default.
- DB connection strings never logged; masked in reports.
- Network captures can contain sensitive tokens — report files should be gitignored.
- Playwright runs in sandboxed browser context.
- Docker containers run on isolated bridge network by default.
