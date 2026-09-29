/**
 * The harnesses and tools ferry knows out of the box.
 *
 * This file is the only place the official set is written down. Modules read
 * it through the registry they are given, so an operator entry and a builtin
 * entry travel the same path.
 */

import { quoteShell } from "../box-settings.ts";
import type { HarnessDescriptor, ToolDescriptor } from "./types.ts";

const USER_CODE_PATTERN = "\\b[A-Z0-9]{4}-[A-Z0-9]{4}\\b";
/** The Codex device code has more characters after the hyphen than the gh code. */
const CODEX_CODE_PATTERN = "\\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\\b";

/** Create the box SSH key for GitHub. An existing key is never replaced. */
const GH_SSH_KEY = [
  '[ -e "$HOME/.ssh/id_ed25519" ] && exit 0',
  'mkdir -p -m 700 "$HOME/.ssh"',
  'ssh-keygen -q -t ed25519 -N "" -C "$(id -un)@$(hostname) ferry" -f "$HOME/.ssh/id_ed25519"',
].join("\n");

/**
 * Give GitHub the box SSH key, trust the github.com host key, and make git use
 * SSH. The host key must match the fingerprint that the GitHub meta API
 * publishes. Each step prints one line, and a failed step stops the setup.
 */
const GH_SSH_SETUP = [
  'pub="$HOME/.ssh/id_ed25519.pub"',
  'key=$(cut -d" " -f2 "$pub" 2>/dev/null)',
  '[ -n "$key" ] || { echo "SSH key: $pub is missing"; exit 0; }',
  'keys=$(gh ssh-key list 2>/dev/null) || { echo "SSH key: gh ssh-key list failed. The gh login needs the admin:public_key scope."; exit 0; }',
  'case "$keys" in',
  '  *"$key"*) echo "SSH key: already on GitHub" ;;',
  '  *) gh ssh-key add "$pub" --title "$(hostname) (ferry)" >/dev/null 2>&1 || { echo "SSH key: gh ssh-key add failed"; exit 0; }',
  '     echo "SSH key: added to GitHub as $(hostname) (ferry)" ;;',
  "esac",
  'if ! ssh-keygen -F github.com >/dev/null 2>&1; then',
  '  want=$(gh api meta --jq .ssh_key_fingerprints.SHA256_ED25519 2>/dev/null)',
  '  line=$(ssh-keyscan -t ed25519 github.com 2>/dev/null)',
  '  got=$(printf "%s\\n" "$line" | ssh-keygen -lf - 2>/dev/null | cut -d" " -f2)',
  '  [ -n "$want" ] && [ "$got" = "$want" ] || { echo "known_hosts: the github.com host key does not match the GitHub fingerprint"; exit 0; }',
  '  printf "%s\\n" "$line" >> "$HOME/.ssh/known_hosts"',
  '  echo "known_hosts: added github.com"',
  "fi",
  'gh config set -h github.com git_protocol ssh >/dev/null 2>&1 || { echo "git protocol: gh config set failed"; exit 0; }',
  'echo "git protocol: ssh"',
  'case "$(ssh -T -o BatchMode=yes git@github.com 2>&1)" in',
  '  *"successfully authenticated"*) echo "ssh -T git@github.com: authenticated" ;;',
  '  *) echo "ssh -T git@github.com: not authenticated"; exit 0 ;;',
  "esac",
  "echo ferry-setup-ok",
].join("\n");

/** Add the GitHub CLI apt repository and its key, then read the package lists. */
const GH_APT_SOURCE =
  "(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\\n" +
  "&& sudo mkdir -p -m 755 /etc/apt/keyrings \\\n" +
  "&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\\n" +
  "&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\\n" +
  "&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n" +
  "&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \\\n" +
  '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\\n' +
  "&& sudo apt update";

/**
 * Install gh at `version` from the GitHub apt repository. When the repository
 * does not have that version, print a warning and install the latest gh.
 * An older version replaces a newer one.
 */
function ghVersion(version: string): string {
  const quoted = quoteShell(version);
  return (
    `if apt-cache madison gh | cut -d "|" -f 2 | tr -d " " | grep -qxF -- ${quoted}; then\n` +
    `  sudo apt install gh=${quoted} -y --allow-downgrades\n` +
    "else\n" +
    `  echo ${quoteShell(`Warning: the GitHub apt repository has no gh ${version}. Ferry installs the latest gh.`)}\n` +
    "  sudo apt install gh -y\n" +
    "fi"
  );
}

/**
 * Install Node and npm from apt when the box has no Node of version
 * `major.minor` or later, or no npm. The Pi recipe and the Paseo integration use it.
 */
export function nodeBootstrap(major: number, minor: number): string {
  return (
    "(command -v node >/dev/null \\\n" +
    `&& node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > ${major} || (major === ${major} && minor >= ${minor}) ? 0 : 1)' >/dev/null \\\n` +
    "&& command -v npm >/dev/null \\\n" +
    "|| (sudo apt update && sudo apt install nodejs npm -y))"
  );
}

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
    // The plugin declarations, permissions, hooks, commit attribution, and
    // model preferences. The box installs the plugins. Keys such as env and
    // apiKeyHelper can hold secrets, so they stay on this machine.
    settings: {
      file: ".claude/settings.json",
      format: "json",
      keys: [
        "enabledPlugins",
        "extraKnownMarketplaces",
        "permissions",
        "hooks",
        "attribution",
        // The earlier form of attribution. Carry it, so the box loses it when the operator does.
        "includeCoAuthoredBy",
        "model",
        "alwaysThinkingEnabled",
      ],
    },
    // The same file holds account and OAuth state. Only mcpServers is read.
    mcp: { file: ".claude.json", format: "json", key: "mcpServers" },
  },
  {
    id: "codex",
    name: "Codex",
    skillRoot: ".codex/skills",
    ownSkills: false,
    instructionFile: ".codex/AGENTS.md",
    // The model preferences and feature flags. Providers, profiles, notify,
    // and project trust can hold headers, commands, or local paths, so they
    // stay on this machine.
    settings: {
      file: ".codex/config.toml",
      format: "toml",
      keys: [
        "model",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "model_verbosity",
        "features",
        "web_search",
      ],
    },
    mcp: { file: ".codex/config.toml", format: "toml", key: "mcp_servers" },
  },
  {
    id: "pi",
    name: "Pi",
    // Pi keeps its skills and its instruction file under .pi/agent.
    skillRoot: ".pi/agent/skills",
    ownSkills: false,
    instructionFile: ".pi/agent/AGENTS.md",
    // The model preferences and the skill command flag. Packages, resource
    // paths, the shell path, and the npm and shell commands can hold URLs,
    // commands, or local paths, so they stay on this machine.
    settings: {
      file: ".pi/agent/settings.json",
      format: "json",
      keys: [
        "defaultProvider",
        "defaultModel",
        "defaultThinkingLevel",
        "enabledModels",
        "thinkingBudgets",
        "enableSkillCommands",
      ],
    },
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    skillRoot: ".cursor/skills",
    ownSkills: false,
    // The model preferences and the commit and PR attribution flags. The
    // permissions, the status line, and the login state can hold commands,
    // local paths, or account data, so they stay on this machine.
    settings: {
      file: ".cursor/cli-config.json",
      format: "json",
      keys: ["model", "maxMode", "hasChangedDefaultModel", "attribution"],
    },
    mcp: { file: ".cursor/mcp.json", format: "json", key: "mcpServers" },
  },
];

/**
 * gh and the vendor agent CLIs. `ferry auth gh` and the GitHub SSH setup need
 * gh. The operator defines every other tool in a `[tools.<id>]` table of the
 * config. `ferry install`, `ferry update`, and `ferry tools` read this list
 * through the registry.
 */
export const BUILTIN_TOOLS: readonly ToolDescriptor[] = [
  {
    id: "gh",
    kind: "tool",
    name: "GitHub CLI",
    binary: "gh",
    localVersion: "gh --version",
    boxVersion: "gh --version",
    install: { command: `${GH_APT_SOURCE} \\\n&& sudo apt install gh -y` },
    // gh has no own update command. The install added the apt source, so apt
    // upgrades it on the box. The operator machine can use another package
    // manager, so ferry does not update gh there.
    update: { command: "sudo apt update && sudo apt install gh -y" },
    recipe: {
      install: (version) => `${GH_APT_SOURCE} \\\n&& ${ghVersion(version)}`,
      update: (version) => `sudo apt update \\\n&& ${ghVersion(version)}`,
    },
    auth: {
      probe: "gh auth status --hostname github.com",
      // Without a terminal, gh prints the code, asks no questions, and skips its own SSH key upload.
      login:
        "gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key --scopes admin:public_key --web",
      completion: {
        kind: "device-url",
        url: "https://github.com/login/device",
        codePattern: USER_CODE_PATTERN,
      },
      prepare: GH_SSH_KEY,
      setup: GH_SSH_SETUP,
    },
  },
  {
    id: "jq",
    kind: "tool",
    name: "jq",
    // Ferry merges the box MCP entries with jq on the box, so each box gets it.
    defaults: { mode: "always", policy: "latest" },
    binary: "jq",
    localVersion: "jq --version",
    boxVersion: "jq --version",
    install: { command: "sudo apt update && sudo apt install jq -y" },
    // An apt command works only on the box, so ferry does not update jq on the operator machine.
    update: { command: "sudo apt update && sudo apt install jq -y" },
  },
  {
    id: "claude",
    kind: "agent",
    name: "Claude Code",
    binary: "claude",
    localVersion: "claude --version",
    boxVersion: "claude --version",
    pathDirs: [".local/bin"],
    install: { command: "curl -fsSL https://claude.ai/install.sh | bash" },
    update: { command: "claude update", binary: "claude" },
    auth: {
      probe: "claude auth status",
      login: "claude auth login",
      // The browser shows a code after the login, and the login on the box reads it from its input.
      completion: {
        kind: "printed-url",
        allowedHosts: ["claude.com", "claude.ai", "anthropic.com"],
        pastedCode: "^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$",
      },
    },
    mcp: {
      register: {
        get: "claude mcp get {name}",
        remove: "claude mcp remove --scope user {name}",
        add: "claude mcp add --transport {type} --scope user {name} {url}",
        // Claude rewrites ~/.claude.json while it runs, so stdio servers go through the CLI too.
        addJson: "claude mcp add-json --scope user {name} {json}",
      },
      list: "claude mcp list",
      loginRequired: "^(.+): \\S+ \\(\\w+\\) - ! Needs authentication$",
      // Without a terminal the login stops at once, so ferry runs it under script.
      login: "claude mcp login {name} --no-browser",
    },
  },
  {
    id: "codex",
    kind: "agent",
    name: "Codex",
    binary: "codex",
    localVersion: "codex --version",
    boxVersion: "codex --version",
    pathDirs: [".local/bin"],
    install: { command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
    update: {
      command: "codex update",
      binary: "codex",
      operatorSkip: { pathIncludes: ".app/Contents/Resources/", reason: "bundled with the Codex app" },
    },
    auth: {
      probe: "codex login status",
      login: "codex login --device-auth",
      completion: {
        kind: "device-url",
        url: "https://auth.openai.com/codex/device",
        codePattern: CODEX_CODE_PATTERN,
      },
      // Codex without device auth prints a URL and waits on a local callback.
      // Ferry uses it when the device login prints no code.
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
    mcp: {
      register: {
        get: "codex mcp get {name}",
        remove: "codex mcp remove {name}",
        // Add writes the config, then starts a login that waits for a callback.
        add: "timeout 20 codex mcp add {name} --url {url}",
      },
      list: "codex mcp list",
      loginRequired: "^(\\S+)\\s+https://\\S+\\s.*\\bNot logged in\\s*$",
      login: "codex mcp login {name} --no-browser",
    },
  },
  {
    id: "pi",
    kind: "agent",
    name: "Pi",
    binary: "pi",
    localVersion: "pi --version",
    boxVersion: "pi --version",
    pathDirs: [".pi/agent/bin"],
    install: {
      command: `${nodeBootstrap(22, 19)} \\\n&& curl -fsSL https://pi.dev/install.sh | sh`,
    },
    // Without a target, pi update updates pi only, not its packages.
    update: { command: "pi update", binary: "pi" },
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
    kind: "agent",
    name: "Cursor Agent",
    binary: "cursor-agent",
    localVersion: "cursor-agent --version",
    boxVersion: "cursor-agent --version",
    pathDirs: [".local/bin"],
    install: { command: "curl https://cursor.com/install -fsS | bash" },
    update: { command: "cursor-agent update", binary: "cursor-agent" },
    auth: {
      probe: "cursor-agent status",
      login: "cursor-agent login",
      completion: { kind: "printed-url", allowedHosts: ["cursor.com", "cursor.sh"] },
    },
    // Cursor Agent has no add command, so ferry merges servers into ~/.cursor/mcp.json.
    mcp: {
      list: "cursor-agent mcp list",
      loginRequired: "^(\\S+): requires_authentication$",
      login: "cursor-agent mcp login {name}",
    },
  },
];
