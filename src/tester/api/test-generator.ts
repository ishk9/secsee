import type {
  EndpointDefinition,
  SchemaField,
  ServiceConfig,
  TestCase,
} from "../../types/index.js";

export function topologicalSort(
  endpoints: EndpointDefinition[],
): EndpointDefinition[] {
  const keyOf = (ep: EndpointDefinition) => `${ep.method}:${ep.path}`;

  const graph = new Map<string, EndpointDefinition>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const ep of endpoints) {
    const key = keyOf(ep);
    graph.set(key, ep);
    if (!inDegree.has(key)) inDegree.set(key, 0);
    if (!adjacency.has(key)) adjacency.set(key, []);
  }

  for (const ep of endpoints) {
    const key = keyOf(ep);
    for (const dep of ep.dependsOn) {
      if (graph.has(dep)) {
        adjacency.get(dep)!.push(key);
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }

  const sorted: EndpointDefinition[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const ep = graph.get(current);
    if (ep) sorted.push(ep);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== endpoints.length) {
    const visited = new Set(sorted.map(keyOf));
    for (const ep of endpoints) {
      if (!visited.has(keyOf(ep))) sorted.push(ep);
    }
  }

  return sorted;
}

export function generateTestCases(
  endpoints: EndpointDefinition[],
  _services: ServiceConfig[],
): TestCase[] {
  const sorted = topologicalSort(endpoints);
  const cases: TestCase[] = [];

  for (const ep of sorted) {
    cases.push(buildHappyPath(ep));

    if (ep.auth) {
      cases.push(buildAuthTest(ep));
    }

    if (ep.request.body && Object.keys(ep.request.body).length > 0) {
      cases.push(buildInvalidPayload(ep));
    }
  }

  return cases;
}

function buildHappyPath(ep: EndpointDefinition): TestCase {
  const successStatus =
    ep.response.statusCodes.find(
      (sc) => sc.code >= 200 && sc.code < 300,
    ) ?? ep.response.statusCodes[0];

  const headers = buildExampleHeaders(ep);
  const body = ep.request.body ? buildExampleBody(ep.request.body) : undefined;
  const queryParams = buildExampleQueryParams(ep);

  return {
    name: `[Happy] ${ep.method} ${ep.path}`,
    endpoint: ep,
    method: ep.method,
    path: ep.path,
    request: { headers, body, queryParams },
    expectedStatus: successStatus?.code ?? 200,
    expectedBodySchema: successStatus?.bodySchema ?? {},
    tags: ["happy"],
  };
}

function buildAuthTest(ep: EndpointDefinition): TestCase {
  const headers = buildExampleHeaders(ep);

  if (ep.auth?.headerName) {
    delete headers[ep.auth.headerName];
    delete headers[ep.auth.headerName.toLowerCase()];
  } else {
    delete headers["authorization"];
    delete headers["Authorization"];
  }

  const body = ep.request.body ? buildExampleBody(ep.request.body) : undefined;
  const queryParams = buildExampleQueryParams(ep);

  return {
    name: `[Auth] ${ep.method} ${ep.path} — no credentials`,
    endpoint: ep,
    method: ep.method,
    path: ep.path,
    request: { headers, body, queryParams },
    expectedStatus: 401,
    expectedBodySchema: {},
    tags: ["auth"],
  };
}

function buildInvalidPayload(ep: EndpointDefinition): TestCase {
  const headers = buildExampleHeaders(ep);
  const queryParams = buildExampleQueryParams(ep);

  const body: Record<string, unknown> = {};
  if (ep.request.body) {
    for (const [key, field] of Object.entries(ep.request.body)) {
      body[key] = invertType(field);
    }
  }

  return {
    name: `[Negative] ${ep.method} ${ep.path} — invalid payload`,
    endpoint: ep,
    method: ep.method,
    path: ep.path,
    request: { headers, body, queryParams },
    expectedStatus: 400,
    expectedBodySchema: {},
    tags: ["negative"],
  };
}

function buildExampleHeaders(ep: EndpointDefinition): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, field] of Object.entries(ep.request.headers)) {
    headers[key] = field.example != null ? String(field.example) : "test-value";
  }

  if (ep.auth) {
    const headerName = ep.auth.headerName ?? "Authorization";
    const prefix = ep.auth.tokenPrefix ?? "Bearer";
    headers[headerName] = `${prefix} {{TOKEN}}`;
  }

  return headers;
}

function buildExampleQueryParams(
  ep: EndpointDefinition,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, field] of Object.entries(ep.request.queryParams)) {
    params[key] = field.example != null ? String(field.example) : "test";
  }
  return params;
}

function buildExampleBody(
  schema: Record<string, SchemaField>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    body[key] = exampleForField(field);
  }
  return body;
}

function exampleForField(field: SchemaField): unknown {
  if (field.example !== undefined) return field.example;
  switch (field.type) {
    case "string":
      return "test-string";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return field.children
        ? [buildExampleBody(field.children)]
        : [];
    case "object":
      return field.children ? buildExampleBody(field.children) : {};
  }
}

function invertType(field: SchemaField): unknown {
  switch (field.type) {
    case "string":
      return 12345;
    case "number":
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    case "array":
      return "not-an-array";
    case "object":
      return "not-an-object";
  }
}
