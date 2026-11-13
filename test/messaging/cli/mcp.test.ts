import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { LocalResponse } from "../../../src/messaging/hook.ts";
import { createMessagingMcpServer, MESSAGING_TOOLS } from "../../../src/messaging/mcp.ts";

type Call = { socket: string; op: string; params: Record<string, unknown>; timeout: number };

async function connect(answer: (call: Call) => LocalResponse) {
  const calls: Call[] = [];
  let callers = 0;
  const server = createMessagingMcpServer({
    home: "/home/user",
    caller: () => (callers++, { ancestors: [{ pid: 42, startTime: "boot:7" }] }),
    call: async (socket, op, params, timeout) => {
      const call = { socket, op, params, timeout };
      calls.push(call);
      return answer(call);
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, calls, callers: () => callers };
}

const text = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

describe("the ferry-messaging MCP server", () => {
  test("lists the tools of section 8.4 with their exact names", async () => {
    const { client } = await connect(() => ({ v: 1, id: "1", ok: true, result: {} }));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "ferry_whoami",
      "ferry_conversations",
      "ferry_create_conversation",
      "ferry_membership",
      "ferry_peers",
      "ferry_send",
      "ferry_ack",
      "ferry_requests",
      "ferry_request_action",
      "ferry_history",
      "ferry_constraint",
      "ferry_receipts",
    ]);
    for (const tool of MESSAGING_TOOLS) expect((tool.inputSchema as { additionalProperties: unknown }).additionalProperties).toBe(false);
    expect(client.getInstructions()).toContain("/home/user/.agents/skills/ferry-messaging/SKILL.md");
    expect(client.getInstructions()).toContain("never grant approval");
  });

  test("forwards a tool call to the worker with the caller, and reads the caller once", async () => {
    const { client, calls, callers } = await connect(() => ({ v: 1, id: "1", ok: true, result: { ok: true, address: "@user/claude-abc123" } }));

    const first = await client.callTool({ name: "ferry_whoami", arguments: { task: "Fix the login" } });
    await client.callTool({ name: "ferry_peers", arguments: {} });

    expect(text(first)).toEqual({ ok: true, address: "@user/claude-abc123" });
    expect(first.isError).toBeUndefined();
    expect(calls[0]).toEqual({
      socket: "/home/user/.ferry/messaging/worker.sock",
      op: "tool.call",
      params: { tool: "ferry_whoami", arguments: { task: "Fix the login" }, caller: { ancestors: [{ pid: 42, startTime: "boot:7" }] } },
      timeout: 15_000,
    });
    expect(callers()).toBe(1);
  });

  test("a result with ok false is an error result", async () => {
    const { client } = await connect(() => ({ v: 1, id: "1", ok: true, result: { ok: false, error: { code: "not-participating" } } }));
    expect((await client.callTool({ name: "ferry_conversations", arguments: {} })).isError).toBe(true);
  });

  test("an offline worker gives worker-offline with guidance", async () => {
    const { client } = await connect(() => ({ v: 1, id: "1", ok: false, error: { code: "worker-offline", message: "no worker" } }));
    const result = await client.callTool({ name: "ferry_send", arguments: { conversation: "deploys", kind: "update", body: "Done." } });
    expect(result.isError).toBe(true);
    expect(text(result)).toEqual({
      ok: false,
      error: { code: "worker-offline", message: "no worker" },
      guidance: "Ferry messaging is offline on this host. Continue your own work without messaging, and try again later.",
    });
  });

  test("an unknown tool gives unknown-tool, and the worker gets no call", async () => {
    const { client, calls } = await connect(() => ({ v: 1, id: "1", ok: true, result: {} }));
    const result = await client.callTool({ name: "ferry_bogus", arguments: {} });
    expect(text(result).error.code).toBe("unknown-tool");
    expect(calls).toEqual([]);
  });
});
