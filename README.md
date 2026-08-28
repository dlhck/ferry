# ferry

Ferry keeps a remote Linux agent box in the same shape as the machine you work on. Your machine is the source of truth. A private git repository holds the skills and the one global instruction file. Both machines clone that repository and point their harness directories at the clone with symlinks. Tailscale is the only path to the box.

Ferry never copies logins. OAuth sessions stay on the machine that created them. Ferry starts a vendor login on the box and you finish it in a browser here.

`PRD.md` holds the v1 specification.

## Status

Bootstrap. No commands work yet.

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
