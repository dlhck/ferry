/**
 * Layer 2 (design 15.2): the relay process behind the fault proxy, with the device
 * flow enrollment of two homes. It needs only the relay. The suites that also need
 * the worker start this stack too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../harness/clock.ts";
import { ACME_APP, relaySession, startRelayStack, type RelayStack } from "../harness/system.ts";
import { RelayHttp } from "../harness/wire.ts";

const TIMEOUT = 30_000;

describe("relay stack", () => {
  let stack: RelayStack;

  beforeEach(async () => {
    stack = await startRelayStack({ clock: new FakeClock() });
  });

  afterEach(async () => {
    try {
      stack.expectCheckoutsUnchanged();
    } finally {
      await stack.stop();
    }
  });

  test(
    "each home enrolls through the device flow and gets its own owner and device",
    async () => {
      const owners = new Set<string>();
      for (const login of ["alice", "bob"]) {
        const p = stack.participant(login);
        const me = await p.http.get<{ owner: { id: string; login: string }; device: { id: string; name: string } }>("/v1/me");
        expect(me.status).toBe(200);
        expect(me.body.owner.login).toBe(login);
        expect(me.body.device).toMatchObject({ id: p.deviceId, name: p.home.deviceName });
        owners.add(me.body.owner.id);

        const credentialFile = join(p.home.messagingDir, "credential");
        expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
        expect(readFileSync(credentialFile, "utf8").trim()).toBe(p.credential);
        const client = JSON.parse(readFileSync(join(p.home.messagingDir, "client.json"), "utf8")) as Record<string, unknown>;
        expect(client).toEqual({ schemaVersion: 1, relayUrl: stack.proxy.url, deviceId: p.deviceId, ownerLogin: login });
      }
      expect(owners.size).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "the project resolves by the key of the checkout, and has no sessions yet",
    async () => {
      const p = stack.participant("alice");
      const project = await p.http.get<{ project: { id: string; key: string; repoId: number; access: string } }>(
        `/v1/projects?key=${encodeURIComponent(p.checkout.key)}`,
      );
      expect(project.status).toBe(200);
      expect(project.body.project).toMatchObject({ key: "github.com/acme/app", repoId: ACME_APP.id, access: "granted" });
      expect(await relaySession(p.http, p.checkout.key, "@alice/claude-abc123")).toBeNull();

      const other = await p.http.get(`/v1/projects?key=${encodeURIComponent("github.com/other/app")}`);
      expect(other.status).toBeGreaterThanOrEqual(400);
    },
    TIMEOUT,
  );

  test(
    "the relay starts again on the same port and store, and the credentials stay valid",
    async () => {
      const p = stack.participant("bob");
      const viaProxy = new RelayHttp(stack.proxy.url, p.credential);
      expect((await viaProxy.get("/v1/me")).status).toBe(200);

      await stack.stopRelay();
      await expect(viaProxy.get("/v1/me")).rejects.toThrow();

      await stack.startRelay();
      const me = await viaProxy.get<{ device: { id: string } }>("/v1/me");
      expect(me.status).toBe(200);
      expect(me.body.device.id).toBe(p.deviceId);
    },
    TIMEOUT,
  );

  test(
    "the relay log has events, and no credential",
    async () => {
      for (const login of ["alice", "bob"]) await stack.participant(login).http.get("/v1/me");
      const events = stack.logs().map((line) => JSON.parse(line) as { event: string });
      expect(events.map((entry) => entry.event)).toContain("relay.enroll-complete");
      expect(events.map((entry) => entry.event)).toContain("relay.request");

      const log = stack.logs().join("\n");
      for (const login of ["alice", "bob"]) expect(log).not.toContain(stack.participant(login).credential);
      expect(log).not.toMatch(/fmr_[A-Za-z0-9_-]{20,}/);
      expect(log).not.toContain("device-code-");
    },
    TIMEOUT,
  );
});
