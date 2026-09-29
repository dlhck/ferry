/** Bun imports these files as text with `with { type: "text" }`, and `bun build --compile` embeds them. */
declare module "*.md" {
  const text: string;
  export default text;
}
