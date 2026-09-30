import { describe, expect, test } from "bun:test";
import { hasNoBox, resolveBoxes, resolveTargetBox } from "../src/boxes.ts";
import { ConfigMissingError, type PartialOperatorConfig } from "../src/config.ts";

const HOST_CONFIG: PartialOperatorConfig = {
  version: 1,
  publisher: "operator",
  snapshotUrl: "snapshot.git",
  host: { tailscale: "box", sshUser: "ferry" },
  integrations: { paseo: true },
  tools: { gh: "latest" },
};

const BOXES_CONFIG: PartialOperatorConfig = {
  version: 1,
  publisher: "operator",
  snapshotUrl: "snapshot.git",
  integrations: { paseo: true },
  tools: {
    codex: "operator",
    gh: "latest",
    pnpm: { version: "10.2.0", local: "pnpm --version", install: "x" },
    node: { local: "node --version", install: "y" },
  },
  boxes: [
    { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
    {
      name: "b",
      host: { tailscale: "box-b", sshUser: "dev" },
      integrations: { paseo: false },
      tools: { codex: "latest", claude: "1.2.3", pnpm: "operator", node: "latest" },
    },
    { name: "c", host: { transport: "ssh", destination: "dev@box-c.example" } },
  ],
};

describe("resolveBoxes", () => {
  test("reads a [host] config as one box named default", () => {
    expect(resolveBoxes(HOST_CONFIG)).toEqual([
      {
        name: "default",
        host: { tailscale: "box", sshUser: "ferry" },
        gitAuth: "agent",
        integrations: { paseo: true },
        tools: { gh: "latest" },
      },
    ]);
    expect(resolveBoxes(HOST_CONFIG, ["default"]).map((box) => box.name)).toEqual(["default"]);
  });

  test("gives empty integrations and tools when the config has none", () => {
    const { integrations: _integrations, tools: _tools, ...config } = HOST_CONFIG;

    expect(resolveBoxes(config)).toEqual([{ name: "default", host: { tailscale: "box", sshUser: "ferry" }, gitAuth: "agent", integrations: {}, tools: {} }]);
  });

  test("gives each box its git_auth, and agent without the key", () => {
    const boxes = { ...BOXES_CONFIG, boxes: BOXES_CONFIG.boxes!.map((box) => (box.name === "c" ? { ...box, gitAuth: "box" as const } : box)) };

    expect(resolveBoxes(boxes).map((box) => [box.name, box.gitAuth])).toEqual([
      ["a", "agent"],
      ["b", "agent"],
      ["c", "box"],
    ]);
  });

  test("puts the box overrides on the global integrations and tool policies", () => {
    const [a, b] = resolveBoxes(BOXES_CONFIG);

    expect(a?.integrations).toEqual({ paseo: true });
    expect(a?.tools).toEqual(BOXES_CONFIG.tools!);
    expect(b?.integrations).toEqual({ paseo: false });
    expect(b?.tools).toEqual({
      codex: "latest",
      gh: "latest",
      claude: "1.2.3",
      pnpm: { version: "operator", local: "pnpm --version", install: "x" },
      node: { version: "latest", local: "node --version", install: "y" },
    });
  });

  test("selects all boxes in config order when the selection is empty", () => {
    expect(resolveBoxes(BOXES_CONFIG).map((box) => box.name)).toEqual(["a", "b", "c"]);
    expect(resolveBoxes(BOXES_CONFIG, []).map((box) => box.name)).toEqual(["a", "b", "c"]);
  });

  test("selects the named boxes in config order", () => {
    expect(resolveBoxes(BOXES_CONFIG, ["c", "a", "c"]).map((box) => box.name)).toEqual(["a", "c"]);
  });

  test("default_box does not narrow the selection of all boxes", () => {
    expect(resolveBoxes({ ...BOXES_CONFIG, defaultBox: "b" }).map((box) => box.name)).toEqual(["a", "b", "c"]);
  });

  test("refuses an unknown box and names the known boxes", () => {
    expect(() => resolveBoxes(BOXES_CONFIG, ["a", "d"])).toThrow("unknown box d. Known boxes: a, b, c.");
    expect(() => resolveBoxes(HOST_CONFIG, ["a"])).toThrow("unknown box a. Known boxes: default.");
  });

  test("refuses a config without a complete box", () => {
    expect(() => resolveBoxes({ version: 1, host: { tailscale: "box" } })).toThrow("Ferry config has no complete box. Run ferry init.");
    expect(() => resolveBoxes({})).toThrow("Ferry config has no complete box. Run ferry init.");
  });

  test("names ferry box add for a complete config without a box", () => {
    const config: PartialOperatorConfig = { version: 1, publisher: "operator", snapshotUrl: "snapshot.git", host: {}, integrations: { paseo: true } };

    expect(hasNoBox(config)).toBe(true);
    expect(hasNoBox(HOST_CONFIG)).toBe(false);
    expect(hasNoBox(BOXES_CONFIG)).toBe(false);
    expect(() => resolveBoxes(config)).toThrow(ConfigMissingError);
    expect(() => resolveBoxes(config)).toThrow("Ferry config has no box. Add a box with ferry box add <name>.");
    expect(() => resolveTargetBox(config, "a")).toThrow("Ferry config has no box. Add a box with ferry box add <name>.");
  });
});

describe("resolveTargetBox", () => {
  test("uses the only box when no box is named", () => {
    expect(resolveTargetBox(HOST_CONFIG).name).toBe("default");
    expect(resolveTargetBox({ ...BOXES_CONFIG, boxes: BOXES_CONFIG.boxes!.slice(1, 2) }).name).toBe("b");
  });

  test("uses the named box", () => {
    expect(resolveTargetBox(BOXES_CONFIG, "b")).toMatchObject({ name: "b", integrations: { paseo: false } });
  });

  test("uses default_box when no box is named", () => {
    expect(resolveTargetBox({ ...BOXES_CONFIG, defaultBox: "c" }).name).toBe("c");
    expect(resolveTargetBox({ ...BOXES_CONFIG, defaultBox: "c" }, "a").name).toBe("a");
  });

  test("asks for --box when there is more than one box and no default_box", () => {
    expect(() => resolveTargetBox(BOXES_CONFIG)).toThrow("More than one box is configured (a, b, c). Add --box <name>, or set default_box in the config.");
  });

  test("refuses an unknown box", () => {
    expect(() => resolveTargetBox(BOXES_CONFIG, "d")).toThrow("unknown box d. Known boxes: a, b, c.");
  });
});
