/** Ollama treats "llama3" and "llama3:latest" as the same model. */
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (s: string) => s.replace(/:latest$/, "");
  return strip(a) === strip(b);
}
