/** Bun imports SQL files as text with `with { type: "text" }`, and `bun build --compile` embeds them. */
declare module "*.sql" {
  const text: string;
  export default text;
}
