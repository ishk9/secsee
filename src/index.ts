import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server/mcp-server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SecSee MCP Server running on stdio");
}

process.on("SIGINT", () => {
  console.error("SecSee shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("SecSee shutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
