/**
 * Progress shows the current step of a long command. The CLI selects one
 * reporter for each run: a spinner on a terminal, one plain line for each
 * step elsewhere, and none for `--json`. All output goes to stderr.
 *
 * A step must end before the command writes its own lines, so the spinner
 * never mixes with them.
 */

import * as prompts from "@clack/prompts";

export type Progress = {
  /** Start a step. */
  start(step: string): void;
  /** Show the position in a counted step, as `step (current/total)`. */
  count(current: number, total: number): void;
  /** End the current step with a done mark. */
  done(): void;
  /** End the current step with a failed mark. */
  fail(): void;
};

export const noProgress: Progress = {
  start() {},
  count() {},
  done() {},
  fail() {},
};

/** Write one line when a step starts or its count changes. It writes no control characters. */
export function plainProgress(writeLine: (line: string) => void): Progress {
  let step = "";
  return {
    start(name) {
      step = name;
      writeLine(`${name}...`);
    },
    count(current, total) {
      writeLine(`${counted(step, current, total)}...`);
    },
    done() {},
    fail() {},
  };
}

/** Show a clack spinner on stderr with the current step. */
export function spinnerProgress(): Progress {
  let spinner: ReturnType<typeof prompts.spinner> | null = null;
  let label = "";
  return {
    start(name) {
      label = name;
      spinner = prompts.spinner({ output: process.stderr });
      spinner.start(label);
    },
    count(current, total) {
      spinner?.message(counted(label, current, total));
    },
    done() {
      spinner?.stop(label);
      spinner = null;
    },
    fail() {
      spinner?.error(`${label} failed`);
      spinner = null;
    },
  };
}

/** A spinner when stdout and stderr are terminals, else plain lines on stderr. */
export function terminalProgress(): Progress {
  return process.stdout.isTTY && process.stderr.isTTY
    ? spinnerProgress()
    : plainProgress((line) => process.stderr.write(`${line}\n`));
}

/**
 * Run `work` as one step. A thrown error, or a result that `failed` accepts,
 * ends the step with a failed mark.
 */
export async function step<T>(
  progress: Progress,
  name: string,
  work: () => T | Promise<T>,
  failed: (result: T) => boolean = () => false,
): Promise<T> {
  progress.start(name);
  let result: T;
  try {
    result = await work();
  } catch (error) {
    progress.fail();
    throw error;
  }
  if (failed(result)) progress.fail();
  else progress.done();
  return result;
}

function counted(step: string, current: number, total: number): string {
  return `${step} (${current}/${total})`;
}
