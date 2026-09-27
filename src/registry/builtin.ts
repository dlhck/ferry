/**
 * The harnesses and vendor CLIs ferry knows out of the box.
 *
 * This file is the only place the official set is written down. Modules read
 * it through the registry they are given, so an operator entry and a builtin
 * entry travel the same path.
 */

import type { HarnessDescriptor, ToolDescriptor } from "./types.ts";

const USER_CODE_PATTERN = "\\b[A-Z0-9]{4}-[A-Z0-9]{4}\\b";

export const BUILTIN_HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: "agents",
    name: "Shared agents",
    skillRoot: ".agents/skills",
    instructionFile: "AGENTS.md",
  },
  {
    id: "claude",
    name: "Claude",
    skillRoot: ".claude/skills",
    instructionFile: ".claude/CLAUDE.md",
    // Subagents and custom commands are plain markdown files.
    extraRoots: [".claude/agents", ".claude/commands"],
    // The plugin declarations, permissions, and hooks. The box installs the
    // plugins. Keys such as env and apiKeyHelper can hold secrets, so they
    // stay on this machine.
    settings: {
      file: ".claude/settings.json",
      keys: ["enabledPlugins", "extraKnownMarketplaces", "permissions", "hooks"],
    },
  },
  {
    id: "codex",
    name: "Codex",
    skillRoot: ".codex/skills",
    ownSkills: false,
    instructionFile: ".codex/AGENTS.md",
  },
  {
    id: "pi",
    name: "Pi",
    // Pi keeps its skills and its instruction file under .pi/agent.
    skillRoot: ".pi/agent/skills",
    ownSkills: false,
    instructionFile: ".pi/agent/AGENTS.md",
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    skillRoot: ".cursor/skills",
    ownSkills: false,
  },
];

export const BUILTIN_TOOLS: readonly ToolDescriptor[] = [
  {
    id: "gh",
    install: {
      command:
        "(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\\n" +
        "&& sudo mkdir -p -m 755 /etc/apt/keyrings \\\n" +
        "&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\\n" +
        "&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\\n" +
        "&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n" +
        "&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \\\n" +
        '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\\n' +
        "&& sudo apt update \\\n" +
        "&& sudo apt install gh -y",
    },
    auth: {
      probe: "gh auth status --hostname github.com",
      login: "gh auth login --hostname github.com --git-protocol https --web",
      completion: {
        kind: "device-url",
        url: "https://github.com/login/device",
        codePattern: USER_CODE_PATTERN,
      },
    },
  },
  {
    id: "claude",
    install: { command: "curl -fsSL https://claude.ai/install.sh | bash" },
    auth: {
      probe: "claude auth status",
      login: "claude auth login",
      completion: { kind: "printed-url", allowedHosts: ["claude.ai", "anthropic.com"] },
    },
  },
  {
    id: "codex",
    install: { command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
    auth: {
      probe: "codex login status",
      login: "codex login --device-auth",
      completion: {
        kind: "device-url",
        url: "https://auth.openai.com/codex/device",
        codePattern: USER_CODE_PATTERN,
      },
      // Codex without device auth prints a URL and waits on a local callback.
      fallback: {
        login: "codex login",
        allowedHosts: ["openai.com"],
        forward: {
          localPort: 1455,
          remotePort: 1455,
          remoteHost: "127.0.0.1",
          timeoutMs: 120_000,
        },
      },
    },
  },
  {
    id: "pi",
    install: {
      command:
        "(command -v node >/dev/null \\\n" +
        "&& node -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null \\\n" +
        "&& command -v npm >/dev/null \\\n" +
        "|| (sudo apt update && sudo apt install nodejs npm -y)) \\\n" +
        "&& curl -fsSL https://pi.dev/install.sh | sh",
    },
    // Pi has no remote login ferry can drive, so it carries no probe or login.
    auth: {
      completion: {
        kind: "manual",
        command: "pi",
        instruction: "SSH to the box, run pi, then use /login in its interactive session.",
      },
    },
  },
  {
    id: "cursor",
    install: { command: "curl https://cursor.com/install -fsS | bash" },
    auth: {
      probe: "cursor-agent status",
      login: "cursor-agent login",
      completion: { kind: "printed-url", allowedHosts: ["cursor.com", "cursor.sh"] },
    },
  },
];
