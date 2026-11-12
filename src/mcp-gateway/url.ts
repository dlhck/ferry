/**
 * The address of the MCP gateway on a box. This module has no imports, so
 * that Manifest can use it without a cycle.
 */

/** The port of the gateway when `ferry mcp serve` gets no `--port`. The unit uses it. */
export const DEFAULT_GATEWAY_PORT = 47820;

/** The URL of each harness entry that points at the gateway starts with this prefix. */
export const GATEWAY_URL_PREFIX = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/mcp/`;

/** The URL of one server on the gateway. */
export function gatewayUrl(server: string): string {
  return `${GATEWAY_URL_PREFIX}${server}`;
}
