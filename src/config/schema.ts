import { z } from "zod";

export const DbConnectionConfigSchema = z.object({
  type: z.enum(["postgres", "mysql", "mongodb"]),
  connectionString: z.string(),
  name: z.string(),
});

export const ServiceConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
  framework: z.string().optional(),
  type: z.enum(["backend", "frontend", "database"]),
  port: z.number().optional(),
  baseUrl: z.string().optional(),
});

export const CrawlConfigSchema = z.object({
  maxDepth: z.number().default(10),
  maxPages: z.number().default(100),
  waitForNetworkIdle: z.boolean().default(true),
  screenshotOnEveryPage: z.boolean().default(true),
});

export const TestCredentialsSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const SecseeConfigSchema = z.object({
  dockerComposePath: z.string().default("docker-compose.yml"),
  frontendUrl: z.string().url(),
  services: z.array(ServiceConfigSchema).default([]),
  testCredentials: TestCredentialsSchema.optional(),
  excludePaths: z.array(z.string()).default([]),
  crawl: CrawlConfigSchema.default({
    maxDepth: 10,
    maxPages: 100,
    waitForNetworkIdle: true,
    screenshotOnEveryPage: true,
  }),
  timeout: z.number().default(30000),
  browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
  parallel: z.number().default(1),
  db: z.array(DbConnectionConfigSchema).default([]),
});

export type SecseeConfigInput = z.input<typeof SecseeConfigSchema>;
