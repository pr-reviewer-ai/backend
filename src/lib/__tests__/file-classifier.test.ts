import { describe, it, expect } from "vitest";
import { classifyFile } from "../file-classifier.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function addedPatch(lines: string[]): string {
  return `@@ -1,1 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
}

function modifiedPatch(contextLines: string[], addedLines: string[]): string {
  // Simulates a file where the first N lines are context (unchanged) and the rest are added.
  // Context lines start at line 1 in both old and new file.
  const total = contextLines.length + addedLines.length;
  const header = `@@ -1,${contextLines.length} +1,${total} @@`;
  const ctx = contextLines.map(l => ` ${l}`).join("\n");
  const added = addedLines.map(l => `+${l}`).join("\n");
  return `${header}\n${ctx}\n${added}`;
}

// ─── path-based classification (deterministic, no content needed) ─────────────

describe("path-based classification", () => {
  it("classifies middleware.ts", () => {
    expect(classifyFile("middleware.ts", "")).toBe("middleware");
    expect(classifyFile("src/middleware.ts", "")).toBe("middleware");
  });

  it("classifies route handlers", () => {
    expect(classifyFile("app/api/users/route.ts", "")).toBe("route-handler");
    expect(classifyFile("src/app/api/posts/route.tsx", "")).toBe("route-handler");
    expect(classifyFile("pages/api/users.ts", "")).toBe("route-handler");
  });

  it("classifies next.config files", () => {
    expect(classifyFile("next.config.ts", "")).toBe("config");
    expect(classifyFile("next.config.js", "")).toBe("config");
  });

  it("classifies pages/ files", () => {
    expect(classifyFile("pages/index.tsx", "")).toBe("pages-component");
    expect(classifyFile("src/pages/about.tsx", "")).toBe("pages-component");
  });
});

// ─── content-based: rawContent takes priority over patch ─────────────────────

describe("rawContent-based classification (the false-positive fix)", () => {
  it("classifies as client-component when rawContent starts with 'use client'", () => {
    // This is the core bug scenario: "use client" was on line 1, diff starts at line 2.
    // Without rawContent, the classifier would see no "use client" in added lines → server-component.
    const patch = `@@ -2,5 +2,10 @@
 import { useState } from 'react'
+export default function Page() {
+  const [count, setCount] = useState(0)
+  return <div>{count}</div>
+}`;
    const rawContent = `'use client'\nimport { useState } from 'react'\nexport default function Page() {\n  const [count, setCount] = useState(0)\n  return <div>{count}</div>\n}\n`;

    // Without rawContent → wrongly server-component (the old bug)
    expect(classifyFile("app/dashboard/page.tsx", patch)).toBe("server-component");

    // With rawContent → correctly client-component
    expect(classifyFile("app/dashboard/page.tsx", patch, rawContent)).toBe("client-component");
  });

  it("classifies as client-component when rawContent uses double-quoted directive", () => {
    const patch = `@@ -3,2 +3,3 @@\n+const x = 1`;
    const rawContent = `"use client"\nimport React from 'react'\nconst x = 1\n`;
    expect(classifyFile("app/components/Button.tsx", patch, rawContent)).toBe("client-component");
  });

  it("classifies layout.tsx as client-component when rawContent has 'use client'", () => {
    // Reproduces the layout.tsx false positive from the PR
    const patch = `@@ -5,3 +5,6 @@\n+import { Puzzle } from 'lucide-react'\n+import { useState } from 'react'`;
    const rawContent = `'use client'\nimport { X as CloseIcon } from 'lucide-react'\nimport { Puzzle } from 'lucide-react'\nimport { useState } from 'react'\n`;
    expect(classifyFile("app/dashboard/layout.tsx", patch, rawContent)).toBe("client-component");
  });

  it("classifies as server-action-file when rawContent has 'use server'", () => {
    const patch = `@@ -2,3 +2,4 @@\n+export async function createPost() {}`;
    const rawContent = `'use server'\nimport { db } from '@/lib/db'\nexport async function createPost() {}\n`;
    expect(classifyFile("app/actions.ts", patch, rawContent)).toBe("server-action-file");
  });

  it("does not treat 'use server' in a page as server-action-file", () => {
    const rawContent = `'use server'\nexport default function Page() { return <div/> }\n`;
    const patch = addedPatch([`'use server'`, `export default function Page() { return <div/> }`]);
    // page.tsx with "use server" is a misuse → still server-component so the static rule fires
    expect(classifyFile("app/dashboard/page.tsx", patch, rawContent)).toBe("server-component");
  });

  it("falls back to patch-only when rawContent is undefined", () => {
    const patch = addedPatch([`'use client'`, `import { useState } from 'react'`]);
    expect(classifyFile("app/foo/page.tsx", patch, undefined)).toBe("client-component");
  });
});

// ─── patch-only fallback (backward compat) ───────────────────────────────────

describe("patch-only classification (no rawContent)", () => {
  it("detects 'use client' in added lines", () => {
    const patch = addedPatch([`'use client'`, `import { useState } from 'react'`, `export default function C() {}`]);
    expect(classifyFile("app/foo/page.tsx", patch)).toBe("client-component");
  });

  it("detects 'use server' in added lines for actions file", () => {
    const patch = addedPatch([`'use server'`, `export async function save() {}`]);
    expect(classifyFile("app/actions.ts", patch)).toBe("server-action-file");
  });

  it("defaults app/ files to server-component when no directive found", () => {
    const patch = addedPatch([`export default async function Page() { return <div/> }`]);
    expect(classifyFile("app/dashboard/page.tsx", patch)).toBe("server-component");
  });

  it("returns 'other' for non-app files with no directive", () => {
    const patch = addedPatch([`export const foo = 1`]);
    expect(classifyFile("lib/utils.ts", patch)).toBe("other");
  });
});
