/**
 * Separate `HOME` directories for the identities of one test (design 15.4).
 *
 * Each home is one device of one owner: its own `~/.ferry/messaging`, its own
 * runtime homes, and its own fake GitHub user. The test enrolls each home against
 * the same relay, so one host covers two identities and the cross-owner rules.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TestIdentity = {
  /** The GitHub login, also the directory name. */
  readonly login: string;
  /** The numeric GitHub user id of the fake GitHub user. */
  readonly githubUserId: number;
  /** The device name that the enrollment sends. */
  readonly deviceName: string;
};

export type TestHome = TestIdentity & {
  readonly home: string;
  /** `<home>/.ferry/messaging`, mode 0700. The worker state of this device. */
  readonly messagingDir: string;
  /** `<home>/.ferry/relay`. Only the home that runs the relay uses it. */
  readonly relayDir: string;
  readonly claudeDir: string;
  readonly codexHome: string;
  /** The environment for a process of this identity: `HOME`, `CODEX_HOME`, and Git without user config. */
  readonly env: Readonly<Record<string, string>>;
};

/** Two owners with example names. Their ids are the ids of the fake GitHub users. */
export const ALICE: TestIdentity = { login: "alice", githubUserId: 1001, deviceName: "alice-box" };
export const BOB: TestIdentity = { login: "bob", githubUserId: 1002, deviceName: "bob-box" };

export type TestHomes = {
  readonly root: string;
  readonly homes: readonly TestHome[];
  /** The home of a login. Throws for an unknown login. */
  get(login: string): TestHome;
  cleanup(): void;
};

/** Makes one home for each identity under a new temporary directory. */
export function createHomes(identities: readonly TestIdentity[] = [ALICE, BOB]): TestHomes {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-messaging-homes-")));
  const homes = identities.map((identity) => createHome(root, identity));
  return {
    root,
    homes,
    get(login) {
      const home = homes.find((candidate) => candidate.login === login);
      if (home === undefined) throw new Error(`no test home for ${login}`);
      return home;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createHome(root: string, identity: TestIdentity): TestHome {
  const home = join(root, identity.login);
  const messagingDir = join(home, ".ferry", "messaging");
  const relayDir = join(home, ".ferry", "relay");
  const claudeDir = join(home, ".claude");
  const codexHome = join(home, ".codex");
  mkdirSync(messagingDir, { recursive: true, mode: 0o700 });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const env = {
    ...stringEnv(process.env),
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  return { ...identity, home, messagingDir, relayDir, claudeDir, codexHome, env };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}
