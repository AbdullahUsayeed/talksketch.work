/**
 * Diagnostic: proves the Excalidraw MCP server is reachable and lists the tools
 * the agent will get. Run with `npm run board:check`.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { MCPServerStdio } from '@openai/agents';
import { createLogger } from './logger.js';

const logger = createLogger('info');

function resolveEntry(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('mcp-excalidraw-server/package.json');
  return join(dirname(pkg), 'dist', 'index.js');
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') env[key] = value;
}
env.EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL ?? 'http://127.0.0.1:3000';

const server = new MCPServerStdio({
  name: 'excalidraw',
  command: process.execPath,
  args: [resolveEntry(), '--stdio'],
  env,
});

try {
  await server.connect();
  const tools = await server.listTools();
  logger.info('excalidraw MCP ok', { canvas: env.EXPRESS_SERVER_URL, tools: tools.length });
  console.log(tools.map((tool) => tool.name).join(', '));
} finally {
  await server.close();
}
