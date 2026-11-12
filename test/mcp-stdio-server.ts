/**
 * A test stdio MCP server for the shared servers of the MCP gateway. Each
 * start appends the pid to the file in the first argument, so a test can
 * count the processes.
 *
 * - `pid`: the pid of the process.
 * - `env`: says if `TEST_TOKEN` is set, without its value.
 * - `slow`: answers `text` after `ms` milliseconds, with one progress notice.
 * - `roots`: sends `roots/list` to the client and returns the answer.
 * - `exit`: stops the process.
 */

import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const starts = process.argv[2];
if (starts) appendFileSync(starts, `${process.pid}\n`);

const tools = ["pid", "env", "slow", "roots", "exit"].map((name) => ({ name, inputSchema: { type: "object" as const } }));
const server = new Server({ name: "test-stdio", version: "1.0.0" }, { capabilities: { tools: {} } });
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

server.setRequestHandler("tools/list", async () => ({ tools }));
server.setRequestHandler("tools/call", async (request, ctx) => {
  const args = (request.params.arguments ?? {}) as { text?: string; ms?: number };
  switch (request.params.name) {
    case "pid":
      return text(String(process.pid));
    case "env":
      return text(process.env.TEST_TOKEN ? "TEST_TOKEN is set" : "TEST_TOKEN is not set");
    case "slow": {
      const token = request.params._meta?.progressToken;
      if (token !== undefined) await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
      await Bun.sleep(args.ms ?? 0);
      return text(String(args.text));
    }
    case "roots":
      try {
        return text(JSON.stringify(await ctx.mcpReq.send({ method: "roots/list" })));
      } catch (error) {
        return text(`roots/list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    case "exit":
      process.exit(1);
  }
  return { isError: true, ...text("unknown tool") };
});

await server.connect(new StdioServerTransport());
