/**
 * Soak test of agent messaging (design 15.6). Scripted traffic between four sessions
 * for a set time, with fake runtimes by default and real ones with `--real`.
 *
 * Checks, at the end and as it runs:
 * - The resident memory of the process (relay and workers in fake mode) grows by no
 *   more than `--max-growth-mib` after the warm-up.
 * - No duplicate acknowledged handling: in fake mode, at most one `acknowledged`
 *   ack for each message and generation. In real mode, at most one answer for each request.
 * - No receipt stays `stored` without a hold for more than 5 minutes while its
 *   session is live.
 * - At most 20 wakes for each recipient session in any rolling 60 minutes.
 *
 * Run it on a box with a memory cap, from the repository root:
 *
 *   systemd-run --user --scope -p MemoryMax=2G -- bun scripts/messaging-soak.ts --hours 4
 *
 * Options: --hours <n> (default 1), --interval <seconds between sends> (default 20),
 * --max-growth-mib <n> (default 128), --real (real claude and codex, uses model
 * tokens), --out <dir> (default ~/.cache/ferry-messaging-soak/<time>).
 * The report goes to <out>/report.json. The exit code is 1 when a check failed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    hours: { type: "string", default: "1" },
    interval: { type: "string", default: "20" },
    "max-growth-mib": { type: "string", default: "128" },
    real: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const hours = Number(values.hours);
const intervalMs = Number(values.interval) * 1_000;
const maxGrowth = Number(values["max-growth-mib"]) * 1024 * 1024;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const out = values.out ?? join(homedir(), ".cache", "ferry-messaging-soak", stamp);
mkdirSync(join(out, "tmp"), { recursive: true });
// The homes, checkouts, and stores go under the output directory, not /tmp.
process.env.TMPDIR = join(out, "tmp");

const STORED_LIMIT_MS = 5 * 60_000;
const WAKE_LIMIT = 20;
const HOUR_MS = 60 * 60_000;
const WARM_UP_MS = Math.min(10 * 60_000, (hours * HOUR_MS) / 4);

/** One participant of the traffic, in either mode. */
type Peer = {
  readonly login: string;
  readonly address: string;
  readonly id: string;
  tool(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, any>; error?: { code: string } }>;
  /** Fake mode only: the envelopes that reached the runtime. */
  envelopes?(): { id: string; kind: string; generation: number | null }[];
};

type Sent = { readonly id: string; readonly kind: string; readonly sender: Peer; readonly at: number };

const failures: string[] = [];
const sent: Sent[] = [];
const acknowledged = new Map<string, number>();
const memory: { at: number; rss: number }[] = [];

function fail(message: string): void {
  if (!failures.includes(message)) failures.push(message);
  console.error(`soak: ${message}`);
}

async function main(): Promise<void> {
  const { peers, http, stop } = values.real ? await realPeers() : await fakePeers();
  const created = await peers[0]!.tool("ferry_create_conversation", { name: `Soak ${stamp}`, purpose: "Scripted soak traffic.", force: true });
  if (!created.ok) throw new Error(`ferry_create_conversation failed: ${created.error?.code}`);
  const conversation = created.result!.conversation.slug as string;
  for (const peer of peers.slice(1)) await peer.tool("ferry_membership", { conversation, action: "join" });

  const started = Date.now();
  const deadline = started + hours * HOUR_MS;
  let nextSend = started;
  let nextCheck = started;
  console.log(`soak: ${peers.length} sessions, ${hours} h, a send every ${intervalMs / 1_000} s, output in ${out}`);

  while (Date.now() < deadline) {
    const now = Date.now();
    if (now >= nextSend) {
      nextSend = now + intervalMs;
      await sendOne(peers, conversation);
    }
    if (!values.real) await actAsAgents(peers, conversation);
    if (now >= nextCheck) {
      nextCheck = now + 60_000;
      memory.push({ at: now - started, rss: process.memoryUsage().rss });
      await checkReceipts(http);
    }
    await Bun.sleep(1_000);
  }

  await checkReceipts(http);
  checkMemory();
  await stop();
  const report = { hours, intervalMs, real: values.real, sent: sent.length, failures, memory };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(failures.length === 0 ? `soak: passed, ${sent.length} sends` : `soak: ${failures.length} checks failed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

async function sendOne(peers: readonly Peer[], conversation: string): Promise<void> {
  const sender = peers[Math.floor(Math.random() * peers.length)]!;
  const others = peers.filter((peer) => peer !== sender);
  const recipient = others[Math.floor(Math.random() * others.length)]!;
  const kind = Math.random() < 0.5 ? "update" : "request";
  const body =
    kind === "request"
      ? `Soak request ${sent.length}: what is the state of your task? Answer through Ferry in one sentence.`
      : `Soak update ${sent.length}.`;
  const result = await sender.tool("ferry_send", { conversation, kind, body, ...(kind === "request" ? { to: recipient.address } : {}) });
  if (!result.ok) {
    // A full send rate is a refusal, not a failure of the system.
    if (result.error?.code !== "rate-limited") fail(`ferry_send failed with ${result.error?.code}`);
    return;
  }
  if (result.result?.message?.id !== undefined) sent.push({ id: result.result.message.id, kind, sender, at: Date.now() });
}

/** Fake mode: each session acks each envelope that it sees, and answers most requests. */
async function actAsAgents(peers: readonly Peer[], conversation: string): Promise<void> {
  for (const peer of peers) {
    for (const envelope of peer.envelopes?.() ?? []) {
      const key = `${peer.id} ${envelope.id} ${envelope.generation ?? 0}`;
      if (acknowledged.has(`seen ${key}`)) continue;
      acknowledged.set(`seen ${key}`, 1);
      const ack = await peer.tool("ferry_ack", { items: [{ id: envelope.id, ...(envelope.generation === null ? {} : { generation: envelope.generation }) }] });
      if (ack.result?.items?.[0]?.result !== "acknowledged") continue;
      const count = (acknowledged.get(key) ?? 0) + 1;
      acknowledged.set(key, count);
      if (count > 1) fail(`duplicate acknowledged handling of ${envelope.id} by ${peer.address}`);
      if (envelope.kind === "request" && Math.random() < 0.7) {
        await peer.tool("ferry_send", { conversation, kind: "answer", answers: envelope.id, generation: envelope.generation, body: "Soak answer." });
      }
    }
  }
}

type Receipt = { state: string; hold: string | null; recipient: { id: string; address: string }; recipientState: string; evidence: { kind: string; at: string }[] };

async function checkReceipts(http: (sender: Peer, id: string) => Promise<{ message: Record<string, any>; receipts: Receipt[] } | null>): Promise<void> {
  const wakes = new Map<string, number[]>();
  const answersPerRequest = new Map<string, number>();
  for (const message of sent) {
    const found = await http(message.sender, message.id);
    if (found === null) continue;
    if (message.kind === "request" && found.message.request?.answer) answersPerRequest.set(message.id, (answersPerRequest.get(message.id) ?? 0) + 1);
    for (const receipt of found.receipts) {
      const age = Date.now() - Date.parse(found.message.createdAt);
      if (receipt.state === "stored" && receipt.hold === null && receipt.recipientState === "live" && age > STORED_LIMIT_MS) {
        fail(`receipt of ${message.id} for ${receipt.recipient.address} is stored without a hold for ${Math.round(age / 60_000)} minutes`);
      }
      if (message.kind !== "update") {
        // A wake shows as delivery evidence from the runtime. A context digest is not a wake.
        for (const evidence of receipt.evidence.filter((entry) => entry.kind === "transcript" || entry.kind === "codex-queue-consumed")) {
          wakes.set(receipt.recipient.id, [...(wakes.get(receipt.recipient.id) ?? []), Date.parse(evidence.at)]);
        }
      }
    }
  }
  for (const [session, times] of wakes) {
    const sorted = times.sort((a, b) => a - b);
    for (let index = 0; index + WAKE_LIMIT < sorted.length; index++) {
      if (sorted[index + WAKE_LIMIT]! - sorted[index]! < HOUR_MS) fail(`session ${session} got more than ${WAKE_LIMIT} wakes in 60 minutes`);
    }
  }
  for (const [id, count] of answersPerRequest) if (count > 1) fail(`request ${id} has ${count} answers`);
}

function checkMemory(): void {
  const base = memory.find((sample) => sample.at >= WARM_UP_MS) ?? memory[0];
  const last = memory.at(-1);
  if (base === undefined || last === undefined) return;
  if (last.rss - base.rss > maxGrowth) {
    fail(`memory grew by ${Math.round((last.rss - base.rss) / 1048576)} MiB after the warm-up (limit ${maxGrowth / 1048576} MiB)`);
  }
}

async function fakePeers() {
  const { startSystem } = await import("../test/messaging/harness/system.ts");
  const system = await startSystem();
  // The fake clock follows the real clock, so the limits run in real time.
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    system.clock.advance(now - last);
    last = now;
  }, 250);
  const sessions = [
    await system.startSession("alice", "claude"),
    await system.startSession("alice", "codex", { where: "linked" }),
    await system.startSession("bob", "claude"),
    await system.startSession("bob", "codex", { where: "linked" }),
  ];
  const peers: Peer[] = sessions;
  return {
    peers,
    http: async (sender: Peer, id: string) => {
      const response = await system.participant(sender.login).http.get<{ message: Record<string, any>; receipts: Receipt[] }>(`/v1/messages/${id}?sessionId=${sender.id}`);
      return response.status === 200 ? response.body : null;
    },
    async stop() {
      clearInterval(timer);
      system.expectCheckoutsUnchanged();
      await system.stop();
    },
  };
}

async function realPeers() {
  process.env.FERRY_E2E_RUNTIMES_DIR = out;
  const { startE2E } = await import("../test/e2e-runtimes/harness.ts");
  const e2e = await startE2E();
  const peers: Peer[] = [
    await e2e.launch("alice", "claude"),
    await e2e.launch("alice", "codex", { where: "linked" }),
    await e2e.launch("bob", "claude"),
    await e2e.launch("bob", "codex", { where: "linked" }),
  ];
  return {
    peers,
    http: async (sender: Peer, id: string) => {
      const response = await e2e.stack.participant(sender.login).http.get<{ message: Record<string, any>; receipts: Receipt[] }>(`/v1/messages/${id}?sessionId=${sender.id}`);
      return response.status === 200 ? response.body : null;
    },
    async stop() {
      e2e.stack.expectCheckoutsUnchanged();
      await e2e.stop();
    },
  };
}

await main();
