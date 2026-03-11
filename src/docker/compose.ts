import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

function findComposeFile(projectRoot: string): string {
  return path.join(projectRoot, "docker-compose.yml");
}

async function resolveComposePath(projectRoot: string): Promise<string> {
  const primary = findComposeFile(projectRoot);
  try {
    await fs.access(primary);
    return primary;
  } catch {
    const alt = path.join(projectRoot, "docker-compose.yaml");
    await fs.access(alt); // throws if neither exists
    return alt;
  }
}

export interface DockerResult {
  success: boolean;
  stdout: string;
  stderr: string;
  composePath: string;
}

export async function spinUp(projectRoot: string): Promise<DockerResult> {
  const composePath = await resolveComposePath(projectRoot);
  try {
    const { stdout, stderr } = await exec(
      "docker",
      ["compose", "-f", composePath, "up", "-d", "--wait"],
      { cwd: projectRoot, timeout: 120_000 }
    );
    return { success: true, stdout, stderr, composePath };
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      composePath,
    };
  }
}

export async function tearDown(
  projectRoot: string,
  removeVolumes = false
): Promise<DockerResult> {
  const composePath = await resolveComposePath(projectRoot);
  const args = ["compose", "-f", composePath, "down"];
  if (removeVolumes) args.push("-v");

  try {
    const { stdout, stderr } = await exec("docker", args, {
      cwd: projectRoot,
      timeout: 60_000,
    });
    return { success: true, stdout, stderr, composePath };
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      composePath,
    };
  }
}

export async function getStatus(projectRoot: string): Promise<DockerResult> {
  const composePath = await resolveComposePath(projectRoot);
  try {
    const { stdout, stderr } = await exec(
      "docker",
      ["compose", "-f", composePath, "ps", "--format", "table"],
      { cwd: projectRoot, timeout: 15_000 }
    );
    return { success: true, stdout, stderr, composePath };
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      composePath,
    };
  }
}
