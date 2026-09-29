#!/usr/bin/env node
// Usage: node npm/stage.mjs <version> <dist-dir> <out-dir>
//
// Copies the npm package templates to <out-dir>, sets <version> in every package,
// copies the binaries dist/ferry-<os>-<arch> into the platform packages, and
// copies the Ferry skill into the main package.
// Publish the platform packages in <out-dir> first, then <out-dir>/ferry.

import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
// Semantic Versioning 2.0.0, without a leading "v".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const [version, dist, out] = process.argv.slice(2);
if (!version || !dist || !out) {
  console.error("Usage: node npm/stage.mjs <version> <dist-dir> <out-dir>");
  process.exit(1);
}
if (!SEMVER.test(version)) {
  console.error(`${version} is not a semantic version.`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function stage(name, update) {
  const target = join(out, name);
  cpSync(join(here, name), target, { recursive: true });
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  update?.(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(root, "LICENSE"), join(target, "LICENSE"));
  return target;
}

for (const platform of PLATFORMS) {
  const target = stage(`ferry-${platform}`);
  mkdirSync(join(target, "bin"), { recursive: true });
  copyFileSync(join(dist, `ferry-${platform}`), join(target, "bin", "ferry"));
  chmodSync(join(target, "bin", "ferry"), 0o755);
}

const main = stage("ferry", (manifest) => {
  for (const name of Object.keys(manifest.optionalDependencies)) {
    manifest.optionalDependencies[name] = version;
  }
});
copyFileSync(join(root, "README.md"), join(main, "README.md"));
// The binary embeds the Ferry skill. The package also has it as a file.
mkdirSync(join(main, "skills", "ferry"), { recursive: true });
copyFileSync(join(root, "skills", "ferry", "SKILL.md"), join(main, "skills", "ferry", "SKILL.md"));
