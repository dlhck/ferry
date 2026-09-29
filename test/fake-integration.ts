import type { IntegrationHealth, IntegrationId, OperatorIntegration } from "../src/integrations/types.ts";

/** The id of the fake. Only built-in ids are valid, so the test casts it. */
export const EXAMPLE_ID = "example" as IntegrationId;

/**
 * An integration with only an operator part. It adds the command
 * `ferry example`, which records each run in `runs`, and a status check.
 */
export function operatorIntegration(
  options: { readonly available?: boolean; readonly health?: IntegrationHealth; readonly runs?: string[] } = {},
): OperatorIntegration {
  return {
    id: EXAMPLE_ID,
    name: "Example",
    description: "Example checks on this machine",
    operator: {
      available: () => options.available ?? true,
      registerCommands(program) {
        program
          .command("example")
          .description("Run the example integration")
          .action(() => {
            options.runs?.push("example");
          });
      },
      health: async () => options.health ?? { lines: ["Example: ready"], warnings: [], json: { ready: true } },
    },
  };
}
