/** POSIX-safe single-quoted shell argument for use inside `bash -lc`. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}
