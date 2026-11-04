// The file's display name: the last path segment, Windows backslashes and
// POSIX slashes both terminating (issue #1485 status lines name the file,
// never the full path).
export function fileBasename(p: string): string {
  return p.split(/[\\/]+/).pop() ?? p;
}
