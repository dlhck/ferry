import { once } from "node:events";

/** Wait for a slow reader before the next write or the end of the command. */
export async function writeStdout(text: string): Promise<void> {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}
