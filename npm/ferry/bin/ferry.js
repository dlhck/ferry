#!/usr/bin/env node
"use strict";

// Runs the Ferry binary from the platform package that npm installed as an optional dependency.

const { spawn } = require("node:child_process");

const SUPPORTED = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const platform = `${process.platform}-${process.arch}`;

if (!SUPPORTED.includes(platform)) {
  console.error(`Ferry has no binary for ${platform}.`);
  console.error(`Supported platforms: ${SUPPORTED.join(", ")}.`);
  process.exit(1);
}

const packageName = `@dlhck/ferry-${platform}`;
let binary;
try {
  binary = require.resolve(`${packageName}/bin/ferry`);
} catch {
  console.error(`Ferry cannot find the package ${packageName}.`);
  console.error("npm did not install it. Optional dependencies may be turned off (--omit=optional).");
  console.error("Install Ferry again with: npm i -g @dlhck/ferry");
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
const forward = (signal) => child.kill(signal);
for (const signal of signals) process.on(signal, forward);

child.on("error", (error) => {
  console.error(`Ferry cannot start ${binary}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // End this process with the same signal, so the caller sees what the binary saw.
    for (const name of signals) process.removeListener(name, forward);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
