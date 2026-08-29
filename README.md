# ferry

Ferry keeps a remote Linux agent box in the same shape as the machine you work on. Your machine is the source of truth. A private git repository holds the skills and the one global instruction file. Both machines clone that repository and point their harness directories at the clone with symlinks. Ferry uses Tailscale by default and also accepts an explicit OpenSSH destination for local machines and existing SSH configurations.

Ferry never copies logins. OAuth sessions stay on the machine that created them. Ferry starts a vendor login on the box and you finish it in a browser here.

`PRD.md` holds the v1 specification.

## Usage

Use a Tailscale peer:

```sh
ferry init \
  --host build-box \
  --ssh-user ferry \
  --snapshot-url git@github.com:you/ferry-snapshot.git
```

Or use an explicit OpenSSH destination. Ferry does not run Tailscale in this mode:

```sh
ferry init \
  --ssh-destination ubuntu@orb \
  --snapshot-url git@github.com:you/ferry-snapshot.git
```

Ferry never falls back from Tailscale to direct SSH. The selected transport is stored in `~/.ferry/config.toml`.

## Development

Ferry needs [bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run build
```

`bun run build` compiles a standalone executable to `dist/ferry` for the current platform.

## License

MIT. See `LICENSE`.
