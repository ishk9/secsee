import fs from "node:fs/promises";
import path from "node:path";

interface AnalysisInput {
  services: {
    name: string;
    framework: string;
    type: "backend" | "frontend" | "database";
    endpoints: any[];
    dbInteractions: any[];
    outboundCalls: any[];
    authScheme: any;
  }[];
}

interface WriteResult {
  mdPath: string;
  jsonPath: string;
  serviceCount: number;
  endpointCount: number;
}

export async function writeWorkingDoc(
  projectRoot: string,
  analysis: AnalysisInput
): Promise<WriteResult> {
  const secseeDir = path.join(projectRoot, ".secsee");
  await fs.mkdir(secseeDir, { recursive: true });

  const mdPath = path.join(secseeDir, "working.md");
  const jsonPath = path.join(secseeDir, "working.json");

  const totalEndpoints = analysis.services.reduce(
    (sum, s) => sum + s.endpoints.length,
    0
  );

  const md = generateMarkdown(analysis, totalEndpoints);

  await fs.writeFile(mdPath, md, "utf-8");
  await fs.writeFile(jsonPath, JSON.stringify(analysis, null, 2), "utf-8");

  return {
    mdPath,
    jsonPath,
    serviceCount: analysis.services.length,
    endpointCount: totalEndpoints,
  };
}

function generateMarkdown(analysis: AnalysisInput, totalEndpoints: number): string {
  const lines: string[] = [];

  lines.push(`# Project Analysis — working.md`);
  lines.push(``);
  lines.push(`> Generated at ${new Date().toISOString()}`);
  lines.push(``);

  // Service overview table
  lines.push(`## Service Overview`);
  lines.push(``);
  lines.push(`| Service | Framework | Type | Endpoints | DB Tables |`);
  lines.push(`|---------|-----------|------|-----------|-----------|`);
  for (const svc of analysis.services) {
    const tables = new Set(svc.dbInteractions.map((d: any) => d.table));
    lines.push(
      `| ${svc.name} | ${svc.framework} | ${svc.type} | ${svc.endpoints.length} | ${tables.size} |`
    );
  }
  lines.push(``);
  lines.push(`**Total endpoints:** ${totalEndpoints}`);
  lines.push(``);

  // Dependency graph (mermaid)
  const allOutbound = analysis.services.flatMap((s) =>
    s.outboundCalls.map((c: any) => ({ from: s.name, to: c.targetUrl ?? c.service ?? "?" }))
  );
  if (allOutbound.length > 0) {
    lines.push(`## Dependency Graph`);
    lines.push(``);
    lines.push("```mermaid");
    lines.push("graph LR");
    for (const dep of allOutbound) {
      lines.push(`  ${dep.from} --> ${dep.to}`);
    }
    lines.push("```");
    lines.push(``);
  }

  // Per-service endpoint documentation
  for (const svc of analysis.services) {
    lines.push(`## ${svc.name} (${svc.framework})`);
    lines.push(``);

    if (svc.authScheme) {
      lines.push(`**Auth:** ${svc.authScheme.kind ?? JSON.stringify(svc.authScheme)}`);
      lines.push(``);
    }

    for (const ep of svc.endpoints) {
      lines.push(`### \`${ep.method} ${ep.path}\``);
      lines.push(``);
      if (ep.summary) lines.push(ep.summary);
      lines.push(``);

      if (ep.auth) {
        lines.push(`- **Auth:** ${ep.auth.kind ?? JSON.stringify(ep.auth)}`);
      }

      if (ep.request?.body) {
        lines.push(`- **Request body:**`);
        lines.push("```json");
        lines.push(JSON.stringify(ep.request.body, null, 2));
        lines.push("```");
      }

      if (ep.request?.queryParams && Object.keys(ep.request.queryParams).length > 0) {
        lines.push(`- **Query params:** ${Object.keys(ep.request.queryParams).join(", ")}`);
      }

      if (ep.response?.statusCodes?.length) {
        lines.push(`- **Responses:**`);
        for (const sc of ep.response.statusCodes) {
          lines.push(`  - \`${sc.code}\`: ${sc.description ?? ""}`);
          if (sc.bodySchema) {
            lines.push("    ```json");
            lines.push(`    ${JSON.stringify(sc.bodySchema, null, 2).split("\n").join("\n    ")}`);
            lines.push("    ```");
          }
        }
      }

      if (ep.dbInteractions?.length) {
        lines.push(`- **DB:** ${ep.dbInteractions.map((d: any) => `${d.operation} ${d.table}`).join(", ")}`);
      }

      if (ep.outboundCalls?.length) {
        lines.push(`- **Calls:** ${ep.outboundCalls.map((c: any) => `${c.method} ${c.targetUrl}`).join(", ")}`);
      }

      if (ep.dependsOn?.length) {
        lines.push(`- **Depends on:** ${ep.dependsOn.join(", ")}`);
      }

      lines.push(``);
    }
  }

  return lines.join("\n");
}
