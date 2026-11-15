/**
 * `ferry relay setup github-app`, `ferry relay import-github-app`, and
 * `ferry relay owners` (design section 3.3).
 *
 * Setup creates the team's GitHub App with the manifest flow:
 *
 * 1. A loopback server on `127.0.0.1` with a random port and a random `state`.
 * 2. Its `/start` page posts the manifest to the "new App" page of the org, or
 *    of the personal account without `--org`.
 * 3. GitHub redirects to `/created?code=<code>&state=<state>`. The command
 *    converts the code with `POST /app-manifests/<code>/conversions`.
 * 4. The operator turns on "Enable Device Flow" in the App settings. The
 *    command polls `POST /login/device/code` until GitHub stops refusing it.
 * 5. The command writes `config.json` and `github-app.pem` on the relay host.
 *
 * The client secret and the webhook secret of the conversion are dropped. The
 * key never appears in a command line, a log, or the result. With `--box`, the
 * files go to the box on the standard input of the SSH command, so the key
 * never touches the disk of this machine.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Link } from "../../link.ts";
import {
  ACCOUNT_NAME,
  appJwt,
  checkAppKey,
  GITHUB_ENDPOINTS,
  githubRequest,
  parseRelayConfig,
  readRelayConfig,
  systemClock,
  writeAppKey,
  writeRelayConfig,
  type Clock,
  type Fetch,
  type GitHubEndpoints,
  type RelayConfig,
} from "./app.ts";
import { DeviceFlowDisabledError, startDeviceFlow } from "./device-flow.ts";

/** Where the relay files go: this machine or a box. */
export type RelayHostFiles = {
  /** For messages: "this machine" or "box <name>". */
  readonly where: string;
  readConfig(): Promise<RelayConfig | null>;
  write(config: RelayConfig, pem: string): Promise<void>;
};

export function localRelayHost(home: string): RelayHostFiles {
  return {
    where: "this machine",
    readConfig: async () => readRelayConfig(home),
    async write(config, pem) {
      writeAppKey(home, pem);
      writeRelayConfig(home, config);
    },
  };
}

/** The script on the box. Line 1 of its input is `config.json`, the rest is the key. */
export const BOX_WRITE_SCRIPT = [
  "set -e; set +x; umask 077",
  'dir="$HOME/.ferry/relay"; mkdir -p "$dir"; chmod 700 "$dir"',
  'tmp_config="$dir/.config.json.$$"; tmp_key="$dir/.github-app.pem.$$"',
  'trap \'rm -f "$tmp_config" "$tmp_key"\' EXIT',
  'IFS= read -r config',
  'printf \'%s\\n\' "$config" > "$tmp_config"',
  'cat > "$tmp_key"',
  'chmod 600 "$tmp_config" "$tmp_key"',
  'mv -f "$tmp_key" "$dir/github-app.pem"',
  'mv -f "$tmp_config" "$dir/config.json"',
  "echo written",
].join("\n");

const BOX_READ_SCRIPT = 'if [ -f "$HOME/.ferry/relay/config.json" ]; then cat "$HOME/.ferry/relay/config.json"; else echo absent; fi';

export function boxRelayHost(link: Pick<Link, "run">, box: string): RelayHostFiles {
  const where = `box ${box}`;
  return {
    where,
    async readConfig() {
      const result = await link.run(BOX_READ_SCRIPT);
      if (!result.ok) throw new Error(`Ferry could not read the relay config on ${where}.`);
      return result.stdout.trim() === "absent" ? null : parseRelayConfig(result.stdout);
    },
    async write(config, pem) {
      checkAppKey(pem);
      // The output of a failed command is not reported, because a shell error can echo its input.
      const result = await link.run(BOX_WRITE_SCRIPT, { input: Buffer.from(`${JSON.stringify(config)}\n${pem.endsWith("\n") ? pem : `${pem}\n`}`) });
      if (!result.ok || result.stdout.trim() !== "written") throw new Error(`Ferry could not write the relay files on ${where}. No key was reported.`);
    },
  };
}

/** The relay host of a command: this machine, or the box of `--box`. */
export async function openRelayHost(input: { readonly home: string; readonly box?: string }): Promise<RelayHostFiles> {
  if (input.box === undefined) return localRelayHost(input.home);
  const [{ readConfig, resolveLinkOptions }, { resolveTargetBox }, { Link }] = await Promise.all([
    import("../../config.ts"),
    import("../../boxes.ts"),
    import("../../link.ts"),
  ]);
  const config = readConfig(input.home);
  if (!config) throw new Error("Ferry has no config. Run ferry init first.");
  const box = resolveTargetBox(config, input.box);
  return boxRelayHost(new Link(resolveLinkOptions(box.host)), box.name);
}

export type SetupInput = {
  readonly org?: string;
  readonly public?: boolean;
  readonly name?: string;
  readonly relayHost: RelayHostFiles;
  readonly print: (line: string) => void;
  /** Opens a URL in the browser. The URL is printed too, for a machine without a browser. */
  readonly openUrl: (url: string) => void;
  readonly endpoints?: GitHubEndpoints;
  readonly fetch?: Fetch;
  /** The wait for the browser part of the manifest flow. Default: 10 minutes. */
  readonly createTimeoutMs?: number;
  /** The wait for "Enable Device Flow". Default: 10 minutes. */
  readonly deviceFlowTimeoutMs?: number;
  /** The pause between two device flow checks. Default: 5 seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type GitHubAppResult = {
  readonly appId: number;
  readonly slug: string;
  readonly clientId: string;
  readonly installUrl: string;
  readonly allowedOwners: readonly string[];
};

const WAIT_MS = 10 * 60_000;
const DEVICE_FLOW_CHECK_MS = 5_000;

export async function setupGitHubApp(input: SetupInput): Promise<GitHubAppResult> {
  if (input.org !== undefined && !ACCOUNT_NAME.test(input.org)) throw new Error(`${input.org} is not a GitHub organization name.`);
  const endpoints = input.endpoints ?? GITHUB_ENDPOINTS;
  const fetcher = input.fetch ?? ((url, init) => fetch(url, init));
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const state = randomBytes(16).toString("hex");
  let answer: (code: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const created = new Promise<string>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  created.catch(() => {});

  const appsPage = input.org === undefined ? `${endpoints.web}/settings/apps` : `${endpoints.web}/organizations/${input.org}/settings/apps`;
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/start") {
        const manifest = {
          name: input.name ?? (input.org === undefined ? "Ferry relay" : `${input.org} Ferry relay`),
          url: "https://github.com/dlhck/ferry",
          hook_attributes: { url: "https://example.invalid/ferry-relay", active: false },
          redirect_url: `http://${url.host}/created`,
          public: input.public === true,
          default_permissions: { metadata: "read" },
          default_events: [],
        };
        return new Response(startPage(`${appsPage}/new?state=${state}`, JSON.stringify(manifest)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname !== "/created") return new Response("Not found.", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("The state does not match. Run ferry relay setup github-app again.", { status: 400 });
      const code = url.searchParams.get("code");
      if (!code) return new Response("GitHub sent no code.", { status: 400 });
      answer(code);
      return new Response("Ferry has the new GitHub App. Go back to the terminal.");
    },
  });
  const timer = setTimeout(() => fail(new Error("The GitHub App was not created in time. Run ferry relay setup github-app again.")), input.createTimeoutMs ?? WAIT_MS);
  let code: string;
  try {
    const start = `http://127.0.0.1:${http.port}/start`;
    input.print(`Open this URL to create the GitHub App: ${start}`);
    input.openUrl(start);
    code = await created;
  } finally {
    clearTimeout(timer);
    // Not forced, so the browser gets the answer of `/created`.
    await http.stop();
  }

  const conversion = await githubRequest(fetcher, `${endpoints.api}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
  const app = conversion.body as { id?: unknown; slug?: unknown; client_id?: unknown; pem?: unknown; owner?: { login?: unknown } } | null;
  if (
    conversion.status !== 201 ||
    !Number.isSafeInteger(app?.id) ||
    typeof app?.slug !== "string" ||
    typeof app.client_id !== "string" ||
    typeof app.pem !== "string" ||
    typeof app.owner?.login !== "string"
  ) {
    throw new Error(`GitHub did not convert the App manifest (HTTP ${conversion.status}). Run ferry relay setup github-app again.`);
  }
  const github = { appId: app.id as number, slug: app.slug, clientId: app.client_id };

  input.print(`GitHub created the App ${github.slug}. Turn on "Enable Device Flow" in its settings: ${appsPage}/${github.slug}`);
  input.openUrl(`${appsPage}/${github.slug}`);
  await waitForDeviceFlow({ clientId: github.clientId, web: endpoints.web, api: endpoints.api, fetch: fetcher }, sleep, input.deviceFlowTimeoutMs ?? WAIT_MS);
  input.print("The device flow is on.");

  return storeApp(input.relayHost, github, app.pem, (input.org ?? app.owner.login).toLowerCase(), endpoints, input.print);
}

/** Poll `POST /login/device/code` until GitHub stops answering `device_flow_disabled`. */
async function waitForDeviceFlow(
  options: Parameters<typeof startDeviceFlow>[0],
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  for (let waited = 0; ; waited += DEVICE_FLOW_CHECK_MS) {
    try {
      await startDeviceFlow(options);
      return;
    } catch (error) {
      if (!(error instanceof DeviceFlowDisabledError)) throw error;
    }
    if (waited >= timeoutMs) throw new Error('The device flow of the GitHub App is still off. Turn on "Enable Device Flow" in the App settings, then run ferry relay import-github-app.');
    await sleep(DEVICE_FLOW_CHECK_MS);
  }
}

export type ImportInput = {
  readonly appId: number;
  readonly clientId: string;
  readonly slug: string;
  readonly keyFile: string;
  readonly relayHost: RelayHostFiles;
  readonly print: (line: string) => void;
  readonly endpoints?: GitHubEndpoints;
  readonly fetch?: Fetch;
  readonly clock?: Clock;
};

/** The manual fallback: check the key with `GET /app`, then write the two files. */
export async function importGitHubApp(input: ImportInput): Promise<GitHubAppResult> {
  const endpoints = input.endpoints ?? GITHUB_ENDPOINTS;
  const fetcher = input.fetch ?? ((url, init) => fetch(url, init));
  let pem: string;
  try {
    pem = readFileSync(input.keyFile, "utf8");
  } catch {
    throw new Error(`Ferry cannot read the key file ${input.keyFile}.`);
  }
  checkAppKey(pem);
  const response = await githubRequest(fetcher, `${endpoints.api}/app`, { bearer: appJwt(input.appId, pem, (input.clock ?? systemClock).now()) });
  if (response.status === 401) throw new Error(`GitHub refused the key for App ${input.appId}. Check the App id and the key file.`);
  const app = response.body as { id?: unknown; slug?: unknown; client_id?: unknown; owner?: { login?: unknown } } | null;
  if (response.status !== 200 || typeof app?.owner?.login !== "string") throw new Error(`GitHub answered GET /app with HTTP ${response.status}.`);
  if (app.id !== input.appId || app.slug !== input.slug || app.client_id !== input.clientId) {
    throw new Error(`The key belongs to the App ${String(app.slug)} (id ${String(app.id)}, client ID ${String(app.client_id)}). Check --app-id, --slug, and --client-id.`);
  }
  const result = await storeApp(
    input.relayHost,
    { appId: input.appId, slug: input.slug, clientId: input.clientId },
    pem,
    app.owner.login.toLowerCase(),
    endpoints,
    input.print,
  );
  input.print(`Delete the downloaded key file ${input.keyFile}. The relay has its own copy.`);
  return result;
}

async function storeApp(
  relayHost: RelayHostFiles,
  github: RelayConfig["github"],
  pem: string,
  owner: string,
  endpoints: GitHubEndpoints,
  print: (line: string) => void,
): Promise<GitHubAppResult> {
  const previous = await relayHost.readConfig();
  const allowedOwners = [...new Set([...(previous?.allowedOwners ?? []), owner])];
  await relayHost.write({ schemaVersion: 1, github, allowedOwners }, pem);
  const installUrl = `${endpoints.web}/apps/${github.slug}/installations/new`;
  print(`Ferry wrote the App config and key on ${relayHost.where}.`);
  print(`Install the App on each account that owns the team's repositories: ${installUrl}`);
  print(`Allowed owners: ${allowedOwners.join(", ")}. Add another with ferry relay owners add <owner>.`);
  return { ...github, installUrl, allowedOwners };
}

/** `ferry relay owners add|remove <owner>` on the relay host. */
export function changeAllowedOwners(home: string, action: "add" | "remove", owner: string): RelayConfig {
  if (!ACCOUNT_NAME.test(owner)) throw new Error(`${owner} is not a GitHub account name.`);
  const config = readRelayConfig(home);
  if (!config) throw new Error("The relay has no GitHub App. Run ferry relay setup github-app.");
  const name = owner.toLowerCase();
  const others = config.allowedOwners.filter((candidate) => candidate !== name);
  const next: RelayConfig = { ...config, allowedOwners: action === "add" ? [...others, name] : others };
  writeRelayConfig(home, next);
  return next;
}

/** A page that posts the manifest to GitHub at once. */
function startPage(action: string, manifest: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create the Ferry relay App</title></head>
<body>
<form id="manifest" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<button type="submit">Create the GitHub App</button>
</form>
<script>document.getElementById("manifest").submit();</script>
</body></html>
`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
