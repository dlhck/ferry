/** The Ferry version of this build. */

// The release build sets FERRY_VERSION with `bun build --define`. A run from source does not.
declare const FERRY_VERSION: string | undefined;

/** The version of a run from source or of a local build. It has no release. */
export const DEV_VERSION = "0.0.0-dev";

export const VERSION = typeof FERRY_VERSION === "string" ? FERRY_VERSION : DEV_VERSION;

/** True when a GitHub release `v<version>` can exist for the version. A development build has none. */
export function isReleaseVersion(version: string): boolean {
  return version !== DEV_VERSION && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version);
}
