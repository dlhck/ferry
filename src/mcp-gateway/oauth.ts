import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { readTokenFile, updateTokenFile, type TokenFile } from "./store.ts";

/** Thrown when the gateway needs a new login: the refresh failed, or there is no token. */
export class LoginRequiredError extends Error {
  constructor(server: string) {
    super(`The login of ${server} on this box expired.`);
  }
}

/**
 * The OAuth client of the running gateway for one server, on the token file
 * of the server. Each call reads the file again, so the gateway uses a new
 * login with no restart. The gateway only refreshes: a request to start a
 * login throws `LoginRequiredError`.
 */
export class GatewayOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly home: string,
    private readonly server: string,
  ) {}

  /** The SDK takes a provider with a redirect for a user login. The gateway never opens it. */
  readonly redirectUrl = "http://127.0.0.1/callback";

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Ferry MCP gateway", redirect_uris: [this.redirectUrl] };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return readTokenFile(this.home, this.server)?.clientInformation;
  }

  tokens(): StoredOAuthTokens | undefined {
    return readTokenFile(this.home, this.server)?.tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    updateTokenFile(this.home, this.server, { tokens });
  }

  redirectToAuthorization(): never {
    throw new LoginRequiredError(this.server);
  }

  saveCodeVerifier(): void {}

  codeVerifier(): never {
    throw new LoginRequiredError(this.server);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readTokenFile(this.home, this.server)?.discoveryState;
  }
}

/**
 * The OAuth client of one `ferry mcp login`. It registers a new client for
 * the loopback redirect of this login, and keeps each value in memory. The
 * login writes the token file one time, at the end, so a login that stops
 * does not break the token of the running gateway.
 */
export class LoginOAuthProvider implements OAuthClientProvider {
  private information: StoredOAuthClientInformation | undefined;
  private saved: StoredOAuthTokens | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private verifier: string | undefined;

  constructor(
    readonly redirectUrl: string,
    private readonly loginState: string,
    private readonly open: (url: URL) => void,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Ferry MCP gateway",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.loginState;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.information;
  }

  saveClientInformation(information: StoredOAuthClientInformation): void {
    this.information = information;
  }

  /** None before the code exchange, so the login does not refresh an old token. */
  tokens(): StoredOAuthTokens | undefined {
    return this.saved;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.saved = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.open(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("The login has no PKCE code verifier.");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  /** The token file of the finished login. */
  result(): TokenFile {
    return { clientInformation: this.information, tokens: this.saved, discoveryState: this.discovery };
  }
}
