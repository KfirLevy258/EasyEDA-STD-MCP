// End-to-end MCP client: launches the server over stdio and exercises its tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = '/Users/KfirLevy/Projects/easyeda_std_mcp';

const transport = new StdioClientTransport({
  command: 'node',
  args: [ROOT + '/dist/src/server/index.js'],
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-test', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

// The editor-side bridge reconnects with backoff (up to 5s). When testing against a
// live editor, give it time to find the newly-bound port before calling tools.
const waitMs = Number(process.env.WAIT_MS ?? 0);
if (waitMs > 0) {
  console.log(`waiting ${waitMs}ms for the editor to reconnect...`);
  await new Promise((r) => setTimeout(r, waitMs));
}

for (const name of process.argv.slice(2)) {
  const [tool, argJson] = name.split('::');
  console.log('\n===== ' + tool + ' =====');
  const res = await client.callTool({ name: tool, arguments: argJson ? JSON.parse(argJson) : {} });
  console.log(res.content.map((c) => c.text).join('\n'));
}

await client.close();
process.exit(0);
