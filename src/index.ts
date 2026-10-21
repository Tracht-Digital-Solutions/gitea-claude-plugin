import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { envValue, loadConfig } from './config/config.js';
import { GiteaMcpServer } from './server.js';
import { log } from './util/log.js';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  process.stderr.write(`[gitea-mcp] Node.js >= 22.19 is required (found ${process.versions.node}).\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  for (const w of config.warnings) log.warn(w);
  const cwd = envValue(process.env, 'GITEA_WORKDIR') ?? process.cwd();
  const server = new GiteaMcpServer(config, { cwd });
  const transport = new StdioServerTransport();
  await server.mcp.connect(transport);
  log.info(
    `started with ${server.tools.length} tools, ${config.profiles.size} profile(s), default=${config.defaultProfile ?? '-'}`,
  );
  const shutdown = () => {
    void server.mcp.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((err: unknown) => {
  log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
