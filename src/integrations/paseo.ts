/** The Paseo integration. The Paseo daemon runs on the box, and Paseo Desktop connects to it over SSH. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BunHostAdapter, type HostAdapter } from "../link.ts";
import type { Integration, LocalVersion } from "./types.ts";

export type PaseoOptions = {
  readonly platform?: NodeJS.Platform;
  /** The macOS app bundle. */
  readonly macApp?: string;
  /** The install directory of the Linux `.deb` and `.rpm` packages. */
  readonly linuxInstallDir?: string;
  readonly host?: HostAdapter;
};

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

export function createPaseo(options: PaseoOptions = {}): Integration {
  const platform = options.platform ?? process.platform;
  const macApp = options.macApp ?? "/Applications/Paseo.app";
  const linuxInstallDir = options.linuxInstallDir ?? "/opt/Paseo";
  const host = options.host ?? new BunHostAdapter();

  return {
    id: "paseo",
    name: "Paseo",
    description: "Paseo daemon on the box",
    async localVersion(): Promise<LocalVersion> {
      if (platform === "darwin") {
        const cli = join(macApp, "Contents/Resources/bin/paseo");
        const fromCli = await cliVersion(host, cli);
        if (fromCli) return { version: fromCli, source: cli };
        const plist = join(macApp, "Contents/Info.plist");
        const fromPlist = plistVersion(plist);
        if (fromPlist) return { version: fromPlist, source: plist };
      } else if (platform === "linux") {
        const cli = join(linuxInstallDir, "resources/bin/paseo");
        const fromCli = await cliVersion(host, cli);
        if (fromCli) return { version: fromCli, source: cli };
      }
      return { version: null, source: null };
    },
    plan: notImplemented("plan"),
    enable: notImplemented("enable"),
    disable: notImplemented("disable"),
    update: notImplemented("update"),
    health: notImplemented("health"),
    onProjectMoved: notImplemented("onProjectMoved"),
    connectSteps(destination: string): readonly string[] {
      // Paseo Desktop keeps its hosts in app storage and has no command to add one.
      return [
        "Open Paseo Desktop.",
        "Open Settings → Add host → Remote SSH.",
        `Enter ssh://${destination}.`,
      ];
    },
  };
}

export const paseo = createPaseo();

async function cliVersion(host: HostAdapter, cli: string): Promise<string | null> {
  if (!existsSync(cli)) return null;
  try {
    const result = await host.run({ argv: [cli, "--version"], timeoutMs: 10_000 });
    if (result.timedOut || result.exitCode !== 0) return null;
    return VERSION_PATTERN.exec(result.stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

function plistVersion(plist: string): string | null {
  if (!existsSync(plist)) return null;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
    readFileSync(plist, "utf8"),
  );
  return match?.[1] ? (VERSION_PATTERN.exec(match[1])?.[0] ?? null) : null;
}

/** Lanes B and C of issue #99 add the box steps. No command calls these methods before then. */
function notImplemented(method: string): () => Promise<never> {
  return async () => {
    throw new Error(`Paseo ${method} is not implemented in this release`);
  };
}
