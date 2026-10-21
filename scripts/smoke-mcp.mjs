// Starts the bundled MCP server over stdio and verifies the protocol handshake, the tool list and
// a structured error for an unconfigured server. With GITEA_URL/GITEA_TOKEN set it also runs
// connection_test against that server. Used in CI and before releases.
// Usage: node scripts/smoke-mcp.mjs [path/to/server.mjs]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = { ...process.env, GITEA_LOG_LEVEL: 'warn' };
const configured = Boolean(env.GITEA_URL && env.GITEA_TOKEN);
if (!configured) {
  delete env.GITEA_URL;
  delete env.GITEA_TOKEN;
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.argv[2] ?? 'plugin/dist/server.mjs'],
  env,
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);
const info = client.getServerVersion();
const { tools } = await client.listTools();
console.log(`server ${info?.name} ${info?.version}: ${tools.length} tools`);
if (tools.length < 40) throw new Error(`expected at least 40 tools, got ${tools.length}`);
for (const t of tools) {
  if (!t.description || t.inputSchema?.type !== 'object')
    throw new Error(`tool ${t.name} lacks description/schema`);
}
const result = await client.callTool({ name: 'connection_test', arguments: {} });
const text = result.content?.[0]?.text ?? '';
if (configured) {
  const parsed = JSON.parse(text);
  if (result.isError || !parsed.ok) throw new Error(`connection_test failed: ${text}`);
  console.log(`connected to Gitea ${parsed.gitea_version} as ${parsed.authenticated_as?.login}`);
} else {
  if (!result.isError || !text.includes('NOT_CONFIGURED'))
    throw new Error(`expected NOT_CONFIGURED, got: ${text}`);
  console.log('unconfigured server returns NOT_CONFIGURED as expected');
}
await client.close();
console.log('smoke test passed');
