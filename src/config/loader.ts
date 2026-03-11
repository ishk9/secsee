import fs from "node:fs/promises";
import path from "node:path";
import type { SecseeConfig } from "../types/index.js";
import { SecseeConfigSchema } from "./schema.js";

const CONFIG_DIR = ".secsee";
const CONFIG_FILE = "config.json";

export async function loadConfig(projectRoot: string): Promise<SecseeConfig> {
  const configPath = path.join(projectRoot, CONFIG_DIR, CONFIG_FILE);

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return SecseeConfigSchema.parse(parsed) as SecseeConfig;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return SecseeConfigSchema.parse({
        frontendUrl: "http://localhost:3000",
      }) as SecseeConfig;
    }
    throw err;
  }
}

const DEFAULT_CONFIG = {
  dockerComposePath: "docker-compose.yml",
  frontendUrl: "http://localhost:3000",
  services: [],
  excludePaths: [],
  crawl: {
    maxDepth: 10,
    maxPages: 100,
    waitForNetworkIdle: true,
    screenshotOnEveryPage: true,
  },
  timeout: 30000,
  browser: "chromium",
  parallel: 1,
  db: [],
};

export async function initConfig(projectRoot: string): Promise<void> {
  const configDir = path.join(projectRoot, CONFIG_DIR);
  const configPath = path.join(configDir, CONFIG_FILE);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");

  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entriesToAdd = [
    ".secsee/test-report.*",
    ".secsee/screenshots/",
    ".secsee/working.md",
    ".secsee/working.json",
  ];

  try {
    const existing = await fs.readFile(gitignorePath, "utf-8");
    const linesToAdd = entriesToAdd.filter((entry) => !existing.includes(entry));
    if (linesToAdd.length > 0) {
      await fs.appendFile(gitignorePath, "\n" + linesToAdd.join("\n") + "\n");
    }
  } catch {
    await fs.writeFile(gitignorePath, entriesToAdd.join("\n") + "\n");
  }
}
