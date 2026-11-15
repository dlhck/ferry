/**
 * The GitHub device flow of the team's App (design section 3.5). The relay
 * runs it, so no GitHub token reaches the teammate's machine.
 *
 * On success the relay reads `GET /user` with the user-to-server token, keeps
 * only the numeric user id and the login, and drops the token and its refresh
 * token. They are never written to disk or returned.
 */

import { githubRequest, type Fetch } from "./app.ts";

export type DeviceFlowOptions = {
  readonly clientId: string;
  /** The origin of `/login/device/code` and `/login/oauth/access_token`: `https://github.com`. */
  readonly web: string;
  /** The origin of `GET /user`: `https://api.github.com`. */
  readonly api: string;
  readonly fetch: Fetch;
};

export type DeviceCode = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInS: number;
  readonly intervalS: number;
};

/** One variant for each state, so a check of `state` narrows the type. */
export type DevicePoll =
  | { readonly state: "pending" }
  | { readonly state: "slow-down" }
  | { readonly state: "expired" }
  | { readonly state: "denied" }
  | { readonly state: "complete"; readonly user: { readonly id: number; readonly login: string } };

/** The App has "Enable Device Flow" off in its settings. */
export class DeviceFlowDisabledError extends Error {
  constructor() {
    super('The GitHub App has the device flow off. Turn on "Enable Device Flow" in the App settings.');
    this.name = "DeviceFlowDisabledError";
  }
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** `POST /login/device/code`. Throws `DeviceFlowDisabledError`, or `GitHubUnavailableError`. */
export async function startDeviceFlow(options: DeviceFlowOptions): Promise<DeviceCode> {
  const response = await githubRequest(options.fetch, `${options.web}/login/device/code`, {
    method: "POST",
    form: { client_id: options.clientId },
  });
  const body = response.body as {
    error?: unknown;
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  } | null;
  if (body?.error === "device_flow_disabled") throw new DeviceFlowDisabledError();
  if (
    response.status !== 200 ||
    typeof body?.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string" ||
    typeof body.expires_in !== "number" ||
    typeof body.interval !== "number"
  ) {
    throw new Error(`GitHub refused the device flow: ${errorName(body?.error) ?? `HTTP ${response.status}`}.`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresInS: body.expires_in,
    intervalS: body.interval,
  };
}

/**
 * One poll of `POST /login/oauth/access_token`. On success it reads the user
 * and drops the token. Throws `DeviceFlowDisabledError`, `GitHubUnavailableError`,
 * or an error for a refusal that a poll cannot fix.
 */
export async function pollDeviceFlow(options: DeviceFlowOptions, deviceCode: string): Promise<DevicePoll> {
  const response = await githubRequest(options.fetch, `${options.web}/login/oauth/access_token`, {
    method: "POST",
    form: { client_id: options.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT },
  });
  const body = response.body as { error?: unknown; access_token?: unknown } | null;
  switch (body?.error) {
    case undefined:
      break;
    case "authorization_pending":
      return { state: "pending" };
    case "slow_down":
      return { state: "slow-down" };
    // An unknown device code cannot complete. To the relay it is the same as an expired one.
    // The GitHub docs also use the names `token_expired` and `bad_verification_code` for these cases.
    case "expired_token":
    case "token_expired":
    case "incorrect_device_code":
    case "bad_verification_code":
      return { state: "expired" };
    case "access_denied":
      return { state: "denied" };
    case "device_flow_disabled":
      throw new DeviceFlowDisabledError();
    default:
      throw new Error(`GitHub refused the device flow: ${errorName(body?.error) ?? "unknown error"}.`);
  }
  if (response.status !== 200 || typeof body?.access_token !== "string") {
    throw new Error(`GitHub answered the device flow poll with HTTP ${response.status} and no token.`);
  }
  return { state: "complete", user: await readUser(options, body.access_token) };
}

/** `GET /user` with the user token. The token is used for this one call only. */
async function readUser(options: DeviceFlowOptions, token: string): Promise<{ id: number; login: string }> {
  const response = await githubRequest(options.fetch, `${options.api}/user`, { bearer: token });
  const user = response.body as { id?: unknown; login?: unknown } | null;
  if (response.status !== 200 || !Number.isSafeInteger(user?.id) || typeof user?.login !== "string") {
    throw new Error(`GitHub answered GET /user with HTTP ${response.status} and no user.`);
  }
  return { id: user.id as number, login: user.login };
}

/** An OAuth error name is safe to print. Any other value is not printed. */
function errorName(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : null;
}
