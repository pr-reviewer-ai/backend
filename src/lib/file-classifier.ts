export type NextFileType =
  | "server-component"
  | "client-component"
  | "route-handler"
  | "server-action-file"
  | "middleware"
  | "pages-component"
  | "config"
  | "other";

export function classifyFile(filename: string, patch: string, rawContent?: string): NextFileType {
  // Path-based (deterministic)
  if (/(?:^|\/)middleware\.[jt]sx?$/.test(filename)) return "middleware";
  if (/^(?:src\/)?app\/.*\/route\.[jt]sx?$/.test(filename)) return "route-handler";
  if (/^next\.config\./.test(filename)) return "config";
  if (/^(?:src\/)?pages\//.test(filename) && !/\/api\//.test(filename)) return "pages-component";
  if (/^(?:src\/)?pages\/api\//.test(filename)) return "route-handler";

  // Content-based: prefer the full file so we detect directives on lines not in the diff.
  // Falling back to added-lines-only is a last resort that can produce false positives when
  // "use client" / "use server" was already present but untouched in this PR.
  const content = rawContent ?? patch.split("\n").filter(l => l.startsWith("+")).map(l => l.slice(1)).join("\n");

  if (/^\s*["']use client["']/m.test(content)) return "client-component";
  // "use server" in a page/layout is a misuse — treat as server-component so all
  // server-component rules still fire; a separate static rule flags the directive itself.
  const isPageOrLayout = /\/(page|layout)\.[jt]sx?$/.test(filename);
  if (/^\s*["']use server["']/m.test(content) && !isPageOrLayout) return "server-action-file";
  if (/^(?:src\/)?app\//.test(filename)) return "server-component";

  return "other";
}
