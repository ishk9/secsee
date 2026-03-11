import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { ServiceType } from "../types/index.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__",
  ".venv", ".next", ".secsee", ".taskmaster", ".nuxt",
  "coverage", ".turbo", ".cache", ".output",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

const MAX_SCAN_DEPTH = 3;
const MAX_FILE_SIZE_BYTES = 100_000; // skip files larger than ~100KB

const BACKEND_DEPS: Record<string, string> = {
  express: "express",
  "@nestjs/core": "nestjs",
  fastify: "fastify",
  koa: "koa",
  "@hapi/hapi": "hapi",
};

const FRONTEND_DEPS: Record<string, string> = {
  react: "react",
  "react-dom": "react",
  vue: "vue",
  next: "nextjs",
  nuxt: "nuxt",
  angular: "angular",
  "@angular/core": "angular",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
};

export interface DiscoveredService {
  name: string;
  path: string;
  detectedFramework: string | null;
  type: ServiceType;
  composePorts?: { host: number; container: number }[];
}

export interface CollectedFile {
  relativePath: string;
  content: string;
  sizeBytes: number;
}

export interface ProjectSnapshot {
  projectRoot: string;
  services: DiscoveredService[];
  files: CollectedFile[];
  dockerCompose: string | null;
  discoveredAt: number;
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readTextSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function detectNodeFramework(
  deps: Record<string, unknown>
): { framework: string; type: ServiceType } | null {
  for (const [dep, name] of Object.entries(BACKEND_DEPS)) {
    if (dep in deps) return { framework: name, type: "backend" };
  }
  for (const [dep, name] of Object.entries(FRONTEND_DEPS)) {
    if (dep in deps) return { framework: name, type: "frontend" };
  }
  return null;
}

async function detectServiceInDir(
  dirPath: string
): Promise<{ framework: string | null; type: ServiceType } | null> {
  const pkgJsonPath = path.join(dirPath, "package.json");
  const pkgJson = await readJsonSafe(pkgJsonPath);
  if (pkgJson) {
    const allDeps: Record<string, unknown> = {
      ...(typeof pkgJson.dependencies === "object" && pkgJson.dependencies !== null
        ? pkgJson.dependencies as Record<string, unknown>
        : {}),
      ...(typeof pkgJson.devDependencies === "object" && pkgJson.devDependencies !== null
        ? pkgJson.devDependencies as Record<string, unknown>
        : {}),
    };
    const detected = detectNodeFramework(allDeps);
    if (detected) return detected;
  }
  return null;
}

async function walkDirectories(
  rootDir: string,
  currentDepth: number
): Promise<DiscoveredService[]> {
  if (currentDepth > MAX_SCAN_DEPTH) return [];

  const services: DiscoveredService[] = [];

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;

    const dirPath = path.join(rootDir, entry.name);
    const detected = await detectServiceInDir(dirPath);

    if (detected) {
      services.push({
        name: entry.name,
        path: dirPath,
        detectedFramework: detected.framework,
        type: detected.type,
      });
    } else {
      const nested = await walkDirectories(dirPath, currentDepth + 1);
      services.push(...nested);
    }
  }

  return services;
}

function parseComposePortString(portStr: string): { host: number; container: number } | null {
  const parts = portStr.split(":");
  if (parts.length === 2) {
    const host = parseInt(parts[0]!, 10);
    const container = parseInt(parts[1]!, 10);
    if (!isNaN(host) && !isNaN(container)) return { host, container };
  }
  return null;
}

async function enrichWithCompose(
  services: DiscoveredService[],
  projectRoot: string
): Promise<void> {
  const composePath = path.join(projectRoot, "docker-compose.yml");
  const raw = await readTextSafe(composePath);
  if (!raw) {
    const altPath = path.join(projectRoot, "docker-compose.yaml");
    const altRaw = await readTextSafe(altPath);
    if (!altRaw) return;
    enrichFromYaml(services, altRaw, projectRoot);
    return;
  }
  enrichFromYaml(services, raw, projectRoot);
}

function enrichFromYaml(
  services: DiscoveredService[],
  raw: string,
  projectRoot: string
): void {
  try {
    const doc = yaml.load(raw) as Record<string, unknown>;
    const composeServices = doc.services as Record<string, Record<string, unknown>> | undefined;
    if (!composeServices) return;

    for (const [composeName, composeDef] of Object.entries(composeServices)) {
      const match = services.find((s) => {
        if (s.name === composeName) return true;
        const buildCtx = composeDef.build;
        if (typeof buildCtx === "string") {
          return s.path === path.resolve(projectRoot, buildCtx);
        }
        if (typeof buildCtx === "object" && buildCtx !== null) {
          const ctx = (buildCtx as Record<string, unknown>).context;
          if (typeof ctx === "string") {
            return s.path === path.resolve(projectRoot, ctx);
          }
        }
        return false;
      });

      if (match) {
        const ports = composeDef.ports;
        if (Array.isArray(ports)) {
          match.composePorts = ports
            .map((p: unknown) => parseComposePortString(String(p)))
            .filter((p): p is { host: number; container: number } => p !== null);
        }
      }
    }
  } catch {
    // Ignore YAML parse errors
  }
}

async function collectSourceFiles(
  serviceDir: string,
  projectRoot: string
): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name));
        }
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const fullPath = path.join(dir, entry.name);

      const isRelevant =
        SOURCE_EXTENSIONS.has(ext) ||
        entry.name === "package.json" ||
        entry.name === "Dockerfile" ||
        entry.name === "tsconfig.json" ||
        entry.name === ".env.example";

      if (!isRelevant) continue;

      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;

        const content = await fs.readFile(fullPath, "utf-8");
        files.push({
          relativePath: path.relative(projectRoot, fullPath),
          content,
          sizeBytes: stat.size,
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  await walk(serviceDir);
  return files;
}

export async function scanProject(
  projectRoot: string
): Promise<ProjectSnapshot> {
  const rootDetected = await detectServiceInDir(projectRoot);
  let services: DiscoveredService[] = [];

  if (rootDetected) {
    services.push({
      name: path.basename(projectRoot),
      path: projectRoot,
      detectedFramework: rootDetected.framework,
      type: rootDetected.type,
    });
  }

  const nested = await walkDirectories(projectRoot, 0);
  services.push(...nested);

  await enrichWithCompose(services, projectRoot);

  const dockerCompose =
    (await readTextSafe(path.join(projectRoot, "docker-compose.yml"))) ??
    (await readTextSafe(path.join(projectRoot, "docker-compose.yaml"))) ??
    null;

  const allFiles: CollectedFile[] = [];
  for (const svc of services) {
    const svcFiles = await collectSourceFiles(svc.path, projectRoot);
    allFiles.push(...svcFiles);
  }

  return {
    projectRoot,
    services,
    files: allFiles,
    dockerCompose,
    discoveredAt: Date.now(),
  };
}
