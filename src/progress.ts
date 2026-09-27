/**
 * Progress shows the current step of a long command. The CLI selects one
 * reporter for each run: one live line and a summary table on a terminal,
 * one plain line for each step elsewhere, and none for `--json`. All progress
 * output goes to stderr.
 *
 * A step must end before the command writes its own lines or shows a prompt,
 * so the live line never mixes with them.
 */

export type Progress = {
  /** Declare the number of planned steps, for the `[n/N]` position. */
  plan(total: number): void;
  /** Start a step. */
  start(step: string): void;
  /** Show the position in a counted step, as `step (current/total)`. */
  count(current: number, total: number): void;
  /** End the current step with a done mark and an optional short detail. */
  done(detail?: string): void;
  /** End the current step with a failed mark and an optional short detail. */
  fail(detail?: string): void;
  /** Record a planned step that the command does not run. */
  skip(step: string, detail?: string): void;
  /**
   * Return a writer for the command's own output lines. The terminal reporter
   * holds the lines until `pause()` or `finish()`. The other reporters write them at once.
   */
  hold(writeLine: (line: string) => void): (line: string) => void;
  /** Clear the live line and write the held lines, before a prompt. */
  pause(): void;
  /** Clear the live line, print the summary table, then write the held lines. */
  finish(): void;
  /**
   * Return a reporter for one box whose steps run at the same time as the
   * steps of other boxes. Each step name starts with `[<name>] `. Its
   * `finish()` does nothing. Use `groupProgress`, which also works for a
   * reporter without this member.
   */
  group?(name: string): Progress;
};

export const noProgress: Progress = {
  plan() {},
  start() {},
  count() {},
  done() {},
  fail() {},
  skip() {},
  hold: (writeLine) => writeLine,
  pause() {},
  finish() {},
};

/**
 * A reporter for the steps of box `name`, which run at the same time as the
 * steps of other boxes. A reporter without `group` shows the steps one at a
 * time, with `[<name>] ` before each step name.
 */
export function groupProgress(progress: Progress, name: string): Progress {
  if (progress.group) return progress.group(name);
  return {
    ...progress,
    plan() {},
    start: (step) => progress.start(`[${name}] ${step}`),
    skip: (step, detail) => progress.skip(`[${name}] ${step}`, detail),
    finish() {},
  };
}

/** Write one line when a step starts or its count changes. It writes no control characters and no table. */
export function plainProgress(writeLine: (line: string) => void): Progress {
  const track = (prefix: string): Progress => {
    let step = "";
    return {
      ...noProgress,
      start(name) {
        step = `${prefix}${name}`;
        writeLine(`${step}...`);
      },
      count(current, total) {
        writeLine(`${counted(step, current, total)}...`);
      },
    };
  };
  return { ...track(""), group: (name) => track(`[${name}] `) };
}

export type TerminalWriter = {
  /** Write raw text, with control characters, to the terminal. */
  write(text: string): void;
  readonly columns: number;
  readonly color: boolean;
  /** The current time in milliseconds. */
  now(): number;
};

type Row = {
  readonly step: string;
  /** The step, with its count while it runs. */
  label: string;
  result: "done" | "failed" | "skipped" | "running";
  detail: string;
  readonly started: number;
  ended: number;
};

const FRAMES = ["◒", "◐", "◓", "◑"];
const FRAME_MS = 80;
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";

/**
 * Rewrite one line in place while a step runs, and print a summary table at
 * `finish()`. A finished step leaves no line behind. The cursor is hidden only
 * while the line is live. Ctrl-C clears the line, shows the cursor, and then
 * stops the process unless another SIGINT handler owns the interrupt.
 *
 * The steps of groups run at the same time. The live line shows each running
 * step, and the table keeps the rows of one group together, at the place of
 * its first step.
 */
export function lineProgress(terminal: TerminalWriter): Progress {
  /** A step outside a group has its own slot. A group has one slot for all its steps. */
  const slots: Row[][] = [];
  const held: Array<() => void> = [];
  let total = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const rows = () => slots.flat();
  const draw = () => {
    const current = rows().length;
    const position = total > 0 ? `[${current}/${Math.max(total, current)}] ` : "";
    const label = rows()
      .filter((row) => row.result === "running")
      .map((row) => row.label)
      .join(" · ");
    const text = fit(`${FRAMES[frame % FRAMES.length]} ${position}${label}`, terminal.columns - 1);
    terminal.write(`${CLEAR_LINE}${text}`);
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    process.off("SIGINT", interrupted);
    process.off("exit", stop);
    terminal.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
  };
  const interrupted = () => {
    stop();
    if (process.listenerCount("SIGINT") === 0) process.kill(process.pid, "SIGINT");
  };
  const live = () => {
    if (timer !== null) return;
    terminal.write(HIDE_CURSOR);
    process.on("SIGINT", interrupted);
    process.on("exit", stop);
    timer = setInterval(() => {
      frame += 1;
      draw();
    }, FRAME_MS);
    timer.unref?.();
  };
  const flush = () => {
    for (const write of held.splice(0)) write();
  };
  const hold = (writeLine: (line: string) => void) => (line: string) => {
    held.push(() => writeLine(line));
  };
  const pause = () => {
    stop();
    flush();
  };

  /** The step methods of the reporter, or of one group when `prefix` is set. */
  const track = (prefix: string) => {
    let row: Row | null = null;
    let slot: Row[] | null = null;
    const add = (added: Row) => {
      row = added;
      if (!prefix) {
        slots.push([added]);
      } else if (slot) {
        slot.push(added);
      } else {
        slot = [added];
        slots.push(slot);
      }
    };
    const end = (result: "done" | "failed", detail = "") => {
      if (row?.result === "running") {
        row.result = result;
        row.detail = detail;
        row.ended = terminal.now();
      }
      if (rows().some((other) => other.result === "running")) draw();
      else stop();
    };
    return {
      start(name: string) {
        const now = terminal.now();
        add({ step: `${prefix}${name}`, label: `${prefix}${name}`, result: "running", detail: "", started: now, ended: now });
        live();
        draw();
      },
      count(current: number, count: number) {
        if (row?.result !== "running") return;
        row.label = counted(row.step, current, count);
        live();
        draw();
      },
      done: (detail?: string) => end("done", detail),
      fail: (detail?: string) => end("failed", detail),
      skip(name: string, detail = "") {
        const now = terminal.now();
        add({ step: `${prefix}${name}`, label: `${prefix}${name}`, result: "skipped", detail, started: now, ended: now });
      },
    };
  };

  return {
    ...track(""),
    plan(planned) {
      total = planned;
    },
    hold,
    pause,
    finish() {
      stop();
      const all = rows();
      if (all.length > 0) terminal.write(`${summaryTable(all, terminal).join("\n")}\n`);
      slots.length = 0;
      flush();
    },
    group: (name) => ({ ...track(`[${name}] `), plan() {}, hold, pause, finish() {} }),
  };
}

/** One live line when stdout and stderr are terminals, else plain lines on stderr. */
export function terminalProgress(): Progress {
  return process.stdout.isTTY && process.stderr.isTTY
    ? lineProgress({
        write: (text) => process.stderr.write(text),
        columns: process.stderr.columns || 80,
        color: !process.env.NO_COLOR,
        now: () => performance.now(),
      })
    : plainProgress((line) => process.stderr.write(`${line}\n`));
}

/**
 * Run `work` as one step. A thrown error, or a result that `failed` accepts,
 * ends the step with a failed mark. `describe` gives the short detail for the
 * summary table. A thrown error gives its message.
 */
export async function step<T>(
  progress: Progress,
  name: string,
  work: () => T | Promise<T>,
  failed: (result: T) => boolean = () => false,
  describe: (result: T) => string | undefined = () => undefined,
): Promise<T> {
  progress.start(name);
  let result: T;
  try {
    result = await work();
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (failed(result)) progress.fail(describe(result));
  else progress.done(describe(result));
  return result;
}

/** A count with its noun, as `1 file` or `3 files`. */
export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

const MARKS = { done: "✔", failed: "✖", skipped: "–", running: "…" } as const;
const COLORS = { done: 32, failed: 31, skipped: 2, running: 2 } as const;
const RESULT_WIDTH = "– skipped".length;
const TIME_WIDTH = 6;
const GAP = "  ";

/**
 * Format the rows as a table that fits `columns`: step, result, detail, and
 * duration. The table truncates the step and the detail and never wraps.
 */
function summaryTable(rows: readonly Row[], terminal: Pick<TerminalWriter, "columns" | "color">): string[] {
  const space = Math.max(terminal.columns, 40) - 1 - RESULT_WIDTH - TIME_WIDTH - GAP.length * 3;
  const longestStep = Math.max("Step".length, ...rows.map((row) => row.step.length));
  const longestDetail = Math.max("Detail".length, ...rows.map((row) => row.detail.length));
  const detailWidth = Math.min(longestDetail, space - Math.min(longestStep, Math.ceil(space * 0.6)));
  const stepWidth = Math.min(longestStep, space - detailWidth);
  const paint = (code: number, text: string) => (terminal.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const header = ["Step".padEnd(stepWidth), "Result".padEnd(RESULT_WIDTH), "Detail".padEnd(detailWidth), "Time".padStart(TIME_WIDTH)];
  return [
    paint(2, header.join(GAP)),
    ...rows.map((row) =>
      [
        fit(row.step, stepWidth).padEnd(stepWidth),
        paint(COLORS[row.result], `${MARKS[row.result]} ${row.result}`.padEnd(RESULT_WIDTH)),
        fit(row.detail, detailWidth).padEnd(detailWidth),
        (row.result === "skipped" ? "" : duration(row.ended - row.started)).padStart(TIME_WIDTH),
      ]
        .join(GAP)
        .trimEnd(),
    ),
  ];
}

function duration(ms: number): string {
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Cut `text` to `width` characters, with an ellipsis when it is too long. */
function fit(text: string, width: number): string {
  const single = text.replace(/\s+/g, " ");
  return single.length <= width ? single : `${single.slice(0, Math.max(width - 1, 0)).trimEnd()}…`;
}

function counted(step: string, current: number, total: number): string {
  return `${step} (${current}/${total})`;
}
