import { describe, expect, test } from "bun:test";
import { CommanderError } from "commander";
import { BoxRequiredError, UnknownBoxError } from "../src/boxes.ts";
import { BoxSettingsError } from "../src/box-settings.ts";
import { ConfigError, ConfigMissingError } from "../src/config.ts";
import { InitRefusal } from "../src/init.ts";
import { InstallAuthCommandError } from "../src/install-auth.ts";
import { confirmationRequired, denyRuleCause, linkFailure } from "../src/errors.ts";
import { errorEvent, errorInfo, failureEnvelope, successEnvelope } from "../src/output.ts";
import { MoveError } from "../src/move.ts";
import { SkillsAddError } from "../src/skills-add.ts";
import { BoxesSyncError, SyncError } from "../src/sync.ts";
import { UpdateError } from "../src/update.ts";

describe("the envelope", () => {
  test("a success has the result, the warnings, and no error", () => {
    expect(successEnvelope("box list", { boxes: [] }, ["Warning: x"])).toEqual({
      schemaVersion: 1,
      command: "box list",
      ok: true,
      result: { boxes: [] },
      warnings: ["Warning: x"],
      error: null,
    });
    expect(successEnvelope("uninstall", undefined, []).result).toBeNull();
  });

  test("a failure has no result and the code, message, and hint of the error", () => {
    expect(failureEnvelope("install", confirmationRequired("Run these commands on the box?"), [])).toEqual({
      schemaVersion: 1,
      command: "install",
      ok: false,
      result: null,
      warnings: [],
      error: {
        code: "confirmation-required",
        message: "Run these commands on the box? Ferry does not ask with --json.",
        hint: "Add --yes to confirm.",
      },
    });
  });

  test("an error event has the type, its fields, and the code, message, and hint", () => {
    expect(errorEvent("sync-failed", new UpdateError("2 of 3 updates failed"), { box: "a" })).toEqual({
      type: "sync-failed",
      box: "a",
      code: "update-failed",
      message: "2 of 3 updates failed",
      hint: null,
    });
  });
});

describe("error codes", () => {
  const code = (error: unknown) => errorInfo(error).code;

  test("box selection errors", () => {
    expect(code(new UnknownBoxError("unknown box c. Known boxes: a, b."))).toBe("unknown-box");
    expect(code(new BoxRequiredError("More than one box is configured (a, b)."))).toBe("box-required");
    expect(code(new ConfigError("unknown key x in [box.a] of config.toml"))).toBe("config-invalid");
    expect(code(new ConfigMissingError("Ferry config is not complete. Run ferry init."))).toBe("config-missing");
  });

  test("the code comes from the class or the code property, never from the message", () => {
    expect(code(new ConfigError("Ferry config is not complete. Run ferry init."))).toBe("config-invalid");
    expect(code(new Error("network/host-offline: the box is offline"))).toBe("failed");
    expect(code(new SyncError("link-failure", "box", "failed to resolve home on box: network/ssh-failed: no route"))).toBe("sync-failed");
  });

  test("a cause with its own code gives the code of the error that wraps it", () => {
    expect(code(new SyncError("invalid-config", "operator", "could not read Ferry config", { cause: new UnknownBoxError("unknown box c") }))).toBe(
      "unknown-box",
    );
    expect(code(new SyncError("invalid-config", "operator", "Ferry config is incomplete.", { cause: new ConfigMissingError("x") }))).toBe(
      "config-missing",
    );
  });

  test("usage errors", () => {
    expect(code(new CommanderError(1, "commander.unknownOption", "error: unknown option '--x'"))).toBe("usage");
    expect(code(new InitRefusal("invalid-values", "--ssh-destination cannot be combined with --host or --ssh-user"))).toBe("usage");
    expect(code(new InstallAuthCommandError("operator/invalid-provider: Unknown auth provider: x.", "operator/invalid-provider"))).toBe("usage");
  });

  test("Link errors, from the code property or a cause", () => {
    expect(code(new InstallAuthCommandError("network/host-offline: Install stopped.", "network/host-offline"))).toBe("box-offline");
    const ssh = linkFailure({ code: "ssh-failed", origin: "network", message: "no route" });
    expect(code(new SyncError("link-failure", "box", "failed to resolve home on box", { cause: ssh }))).toBe("box-offline");
    const denied = new BoxSettingsError("box/command-failed: denied", {
      cause: linkFailure({ code: "command-failed", origin: "box", message: "denied" }),
    });
    expect(code(new SyncError("apply-failure", "box", "could not apply the carried settings keys", { cause: denied }))).toBe(
      "box-command-failed",
    );
    const probe = linkFailure({ code: "host-offline", origin: "network", message: "Tailscale host box is offline" });
    expect(code(new InitRefusal("link-refusal", "network: Tailscale host box is offline", { cause: probe }))).toBe("box-offline");
    expect(code(linkFailure({ code: "forward-timeout", origin: "operator", message: "timeout" }))).toBe("forward-failed");
  });

  test("a deny rule match, and a Manifest clash without one", () => {
    const denied = denyRuleCause([{ path: "/home/me/.agents/skills/x/.env", reason: "environment file" }]);
    expect(code(new SyncError("manifest-refusal", "operator", "Manifest refused publisher me: environment file: .env", denied))).toBe(
      "deny-rule-match",
    );
    expect(code(new InitRefusal("manifest-refusal", "Manifest refused the source: environment file: .env", denied))).toBe(
      "deny-rule-match",
    );
    expect(denyRuleCause([])).toBeUndefined();
    expect(code(new SyncError("manifest-refusal", "operator", "Manifest refused publisher me: clash tdd: a, b"))).toBe("refused");
  });

  test("sync, update, init, auth, and child command failures", () => {
    expect(code(new BoxesSyncError([{ name: "a", plan: {} as never, failure: { step: "Connecting", error: new Error("x") } }], true))).toBe(
      "sync-failed",
    );
    expect(code(new SyncError("concurrent-sync", "operator", "another sync is active for box"))).toBe("sync-busy");
    expect(code(new SyncError("wrong-publisher", "operator", "this machine is not the publisher"))).toBe("config-invalid");
    expect(code(new InitRefusal("missing-values", "missing init values: host"))).toBe("missing-values");
    expect(code(new InitRefusal("host-key-refusal", "operator did not trust the SSH host keys"))).toBe("refused");
    expect(code(new InstallAuthCommandError("box/login-unfinished: the login did not finish", "box/login-unfinished"))).toBe(
      "login-failed",
    );
    expect(code(new SkillsAddError(7))).toBe("command-failed");
    expect(code(new MoveError("~/app does not exist on the box."))).toBe("refused");
    expect(code(new Error("something else"))).toBe("failed");
  });
});
