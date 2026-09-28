export type SkillsAddInput = {
  /** Arguments for `npx skills add`, in the caller's order. */
  readonly args: readonly string[];
  /** Keep the install in the current project. Ferry then does not add `-g`. */
  readonly project: boolean;
};

/** Run a command with inherited stdio and return its exit code. */
export type RunProcess = (argv: readonly string[]) => Promise<number>;

export class SkillsAddError extends Error {
  constructor(readonly exitCode: number) {
    super(`npx skills add exited with code ${exitCode}.`);
    this.name = "SkillsAddError";
  }
}

/**
 * Build the `npx skills add` argv. Ferry adds `-g` and `--copy` unless the caller
 * passed them. The flags go before a `--`, so arguments after it stay unchanged.
 */
export function skillsAddArgv(args: readonly string[], options: { readonly project: boolean }): string[] {
  const end = args.indexOf("--");
  const at = end === -1 ? args.length : end;
  const flags = args.slice(0, at);
  const added: string[] = [];
  if (!options.project && !flags.includes("-g") && !flags.includes("--global")) added.push("-g");
  if (!flags.includes("--copy")) added.push("--copy");
  return ["npx", "skills", "add", ...flags, ...added, ...args.slice(at)];
}

/** Returns the argv that ran. */
export async function runSkillsAdd(
  input: SkillsAddInput,
  run: RunProcess = runInherited,
): Promise<string[]> {
  const argv = skillsAddArgv(input.args, input);
  const exitCode = await run(argv);
  if (exitCode !== 0) throw new SkillsAddError(exitCode);
  return argv;
}

async function runInherited(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}
