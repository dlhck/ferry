import { expect, test } from "bun:test";
import { COMMANDS_PAGE, renderCommandsPage } from "../scripts/docs-commands.ts";

test("docs/commands.md is the output of scripts/docs-commands.ts", async () => {
  // When this fails, run: bun scripts/docs-commands.ts
  expect(await Bun.file(COMMANDS_PAGE).text()).toBe(renderCommandsPage());
});

test("the commands page has each command and no hidden command", () => {
  const page = renderCommandsPage();
  for (const heading of ["## ferry sync", "### ferry box remove", "### ferry sherlock add", "### ferry tunnel install"]) {
    expect(page).toContain(`\n${heading}\n`);
  }
  expect(page).not.toContain("## ferry scan");
  expect(page).not.toContain("## ferry redact");
});
