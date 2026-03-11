import type { TestCase, TestContext } from "../../types/index.js";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function buildRequest(
  testCase: TestCase,
  context: TestContext,
  baseUrl: string,
): BuiltRequest {
  const resolvedPath = resolvePath(testCase.path, context.resources);
  const url = buildUrl(baseUrl, resolvedPath, testCase.request.queryParams);

  const headers: Record<string, string> = { ...testCase.request.headers };

  if (context.token) {
    for (const [key, value] of Object.entries(headers)) {
      if (value.includes("{{TOKEN}}")) {
        headers[key] = value.replace("{{TOKEN}}", context.token);
      }
    }
  }

  const ep = testCase.endpoint;
  if (ep.request.contentType && !headers["content-type"] && !headers["Content-Type"]) {
    headers["Content-Type"] = ep.request.contentType;
  }

  return {
    url,
    method: testCase.method,
    headers,
    body: testCase.request.body,
  };
}

function resolvePath(
  path: string,
  resources: Record<string, string>,
): string {
  return path.replace(/:([a-zA-Z_]\w*)/g, (_match, param: string) => {
    return resources[param] ?? `:${param}`;
  });
}

function buildUrl(
  baseUrl: string,
  path: string,
  queryParams: Record<string, string>,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const fullPath = path.startsWith("/") ? path : `/${path}`;

  const entries = Object.entries(queryParams);
  if (entries.length === 0) return `${base}${fullPath}`;

  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  return `${base}${fullPath}?${qs}`;
}
