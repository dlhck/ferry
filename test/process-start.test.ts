import { expect, test } from "bun:test";
import { processStart } from "../src/process-start.ts";

test("processStart gives a stable start for a live process, and null for a pid that does not exist", () => {
  const start = processStart(process.pid);
  expect(start).not.toBeNull();
  expect(processStart(process.pid)).toBe(start);
  if (process.platform === "linux") expect(start).toMatch(/^[0-9a-f-]{36}:\d+$/);
  expect(processStart(2 ** 22 + 1)).toBeNull();
});
