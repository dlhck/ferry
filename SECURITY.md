# Security policy

## Report a vulnerability

Do not open a public issue for a security problem.

Report it privately with GitHub private vulnerability reporting: open the [Security tab](https://github.com/dlhck/ferry/security) of this repository and click **Report a vulnerability**. Include the Ferry version or commit, the operating system of the operator machine and the box, the steps to reproduce, and the effect.

Remove real tokens, host names, IP addresses, and user names from logs before you send them.

The maintainer aims to reply within 7 days, and publishes the advisory after a release with the fix is available.

## Supported versions

Only the latest release and the `main` branch get security fixes.

## Scope

Ferry connects to a remote box with SSH, runs commands there, and starts vendor logins. These problems are in scope:

- Ferry carries a credential, token, private key, session, or secret settings key to the snapshot or the box.
- A deny rule fails to stop the sync for a secret that it must detect.
- Ferry reads or sends a credential file of the operator machine.
- Command injection: a skill name, path, settings value, MCP server entry, or config value causes Ferry to run an unintended command on the operator machine or the box.
- Ferry turns off SSH host-key checks, trusts a host key without approval, or falls back from Tailscale to direct SSH.
- The SSH agent forward stays open or is used for more than the snapshot update.
- `ferry auth gh` adds a GitHub host key without a fingerprint match, or replaces an existing SSH key on the box.
- A symlink or path problem that lets sync or uninstall write or delete files outside the managed paths.

These problems are out of scope:

- The security of the vendor CLIs (`gh`, Claude Code, Codex, Pi, Cursor Agent) and their install scripts.
- The security of the box itself, its SSH server, or Tailscale.
- An attacker who already controls the operator machine or the SSH user on the box. The rule "no credential leaves the machine that has it" holds for a box that runs an honest Ferry. For `ferry move --from-box` and `ferry adopt --from-box`, the Ferry on the box checks each file and sends only the bytes that pass. This protects against mistakes and against files that change during the command. It does not protect against a box account that an attacker controls: that Ferry can give any answer and any bytes. The operator machine applies its own deny rules to the bytes that arrive, before it writes them to the destination or sends them to another box.
- Content that you put into your own snapshot repository on purpose.
