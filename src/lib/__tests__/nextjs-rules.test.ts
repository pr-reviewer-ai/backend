import { describe, it, expect } from "vitest";
import { runNextJsRules } from "../nextjs-rules.js";
import type { NextFileType } from "../file-classifier.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePatch(addedLines: string[], startLine = 1): string {
  return `@@ -1,0 +${startLine},${addedLines.length} @@\n${addedLines.map(l => `+${l}`).join("\n")}`;
}

function violationBodies(filename: string, type: NextFileType, patch: string): string[] {
  return runNextJsRules(filename, type, patch).map(v => v.body);
}

function severities(filename: string, type: NextFileType, patch: string) {
  return runNextJsRules(filename, type, patch).map(v => v.severity);
}

// ─── hooks-in-server-component ───────────────────────────────────────────────

describe("hooks/in-server-component", () => {
  it("fires for useState import in a server-component", () => {
    const patch = makePatch([`import { useState } from 'react'`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs).toHaveLength(1);
    expect(vs[0].severity).toBe("error");
    expect(vs[0].body).toContain("useState");
  });

  it("does NOT fire for useState in a client-component", () => {
    const patch = makePatch([`'use client'`, `import { useState } from 'react'`]);
    const vs = runNextJsRules("app/page.tsx", "client-component", patch);
    const hookViolations = vs.filter(v => v.body.includes("useState") && v.body.includes("Server Component"));
    expect(hookViolations).toHaveLength(0);
  });

  it("fires only once per file even when multiple hooks are imported", () => {
    // The rule should flag the first hook it finds, not one per hook
    const patch = makePatch([
      `import { useState, useEffect, useCallback } from 'react'`,
    ]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    // Only one violation for the hooks-in-server-component rule
    const hookViolations = vs.filter(v => v.body.includes("Server Component") || v.body.includes("build error"));
    expect(hookViolations).toHaveLength(1);
  });

  it("fires for useEffect import", () => {
    const patch = makePatch([`import { useEffect } from 'react'`]);
    const vs = runNextJsRules("app/layout.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("useEffect"))).toBe(true);
  });
});

// ─── use-client after imports ─────────────────────────────────────────────────

describe("use-client/after-imports", () => {
  it("flags 'use client' placed after an import statement", () => {
    const patch = makePatch([
      `import { useState } from 'react'`,
      `'use client'`,
    ]);
    const vs = runNextJsRules("app/foo.tsx", "other", patch);
    expect(vs.some(v => v.body.includes("use client") && v.body.includes("first line"))).toBe(true);
  });

  it("does not flag 'use client' as the first added line", () => {
    const patch = makePatch([`'use client'`, `import { useState } from 'react'`]);
    const vs = runNextJsRules("app/foo.tsx", "client-component", patch);
    const afterImportViolations = vs.filter(v => v.body.includes("first line"));
    expect(afterImportViolations).toHaveLength(0);
  });
});

// ─── use-server in page/layout ────────────────────────────────────────────────

describe("use-server/in-page-or-layout", () => {
  it("flags 'use server' at the top of a page", () => {
    const patch = makePatch([`'use server'`, `export default function Page() {}`]);
    const vs = runNextJsRules("app/dashboard/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("use server") && v.body.includes("page or layout"))).toBe(true);
    expect(vs[0].severity).toBe("error");
  });

  it("flags 'use server' at the top of a layout", () => {
    const patch = makePatch([`'use server'`, `export default function Layout({ children }) {}`]);
    const vs = runNextJsRules("app/dashboard/layout.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("use server"))).toBe(true);
  });
});

// ─── async cookies/headers ────────────────────────────────────────────────────

describe("async-params/sync-cookies", () => {
  it("flags synchronous cookies()", () => {
    const patch = makePatch([`const store = cookies()`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("cookies()") && v.body.includes("await"))).toBe(true);
    expect(vs[0].severity).toBe("error");
  });

  it("does not flag await cookies()", () => {
    const patch = makePatch([`const store = await cookies()`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.filter(v => v.body.includes("cookies()"))).toHaveLength(0);
  });

  it("flags synchronous headers()", () => {
    const patch = makePatch([`const h = headers()`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("headers()"))).toBe(true);
  });
});

// ─── sync params access ───────────────────────────────────────────────────────

describe("async-params/sync-params", () => {
  it("flags synchronous params destructuring", () => {
    const patch = makePatch([`const { id } = params`]);
    const vs = runNextJsRules("app/[id]/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("params") && v.body.includes("await"))).toBe(true);
  });

  it("does not flag when params is awaited elsewhere in the diff", () => {
    const patch = makePatch([`const { id } = await params`, `console.log(id)`]);
    const vs = runNextJsRules("app/[id]/page.tsx", "server-component", patch);
    expect(vs.filter(v => v.body.includes("params") && v.body.includes("await"))).toHaveLength(0);
  });
});

// ─── fetch without cache options ─────────────────────────────────────────────

describe("cache/fetch-no-options", () => {
  it("flags fetch() without cache options in server-component", () => {
    const patch = makePatch([`const res = await fetch('/api/data')`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("fetch()") && v.body.includes("no-store"))).toBe(true);
    expect(vs[0].severity).toBe("warning");
  });

  it("does not flag fetch with cache: force-cache", () => {
    const patch = makePatch([`const res = await fetch('/api/data', { cache: 'force-cache' })`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.filter(v => v.body.includes("fetch()"))).toHaveLength(0);
  });

  it("does not flag fetch() in a client-component", () => {
    const patch = makePatch([`const res = await fetch('/api/data')`]);
    const vs = runNextJsRules("app/page.tsx", "client-component", patch);
    expect(vs.filter(v => v.body.includes("no-store"))).toHaveLength(0);
  });
});

// ─── NEXT_PUBLIC_ secrets ─────────────────────────────────────────────────────

describe("secrets/next-public", () => {
  it("flags NEXT_PUBLIC_ prefixed secret env vars", () => {
    const patch = makePatch([`const key = process.env.NEXT_PUBLIC_SECRET_KEY`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("NEXT_PUBLIC_") && v.body.includes("client bundle"))).toBe(true);
    expect(vs[0].severity).toBe("error");
  });

  it("flags NEXT_PUBLIC_TOKEN", () => {
    const patch = makePatch([`NEXT_PUBLIC_API_TOKEN=abc`]);
    const vs = runNextJsRules(".env.local", "other", patch);
    expect(vs.some(v => v.body.includes("NEXT_PUBLIC_"))).toBe(true);
  });
});

// ─── next/router in app/ ─────────────────────────────────────────────────────

describe("pages-router/wrong-router-import", () => {
  it("flags next/router import in app/ directory", () => {
    const patch = makePatch([`import { useRouter } from 'next/router'`]);
    const vs = runNextJsRules("app/dashboard/page.tsx", "client-component", patch);
    expect(vs.some(v => v.body.includes("next/router") && v.body.includes("next/navigation"))).toBe(true);
    expect(vs[0].severity).toBe("error");
  });

  it("does not flag next/router in pages/ directory", () => {
    const patch = makePatch([`import { useRouter } from 'next/router'`]);
    const vs = runNextJsRules("pages/index.tsx", "pages-component", patch);
    expect(vs.filter(v => v.body.includes("next/router"))).toHaveLength(0);
  });
});

// ─── inline "use server" in client component ─────────────────────────────────

describe("server-actions/inline-in-client", () => {
  it("flags inline 'use server' in a client component file", () => {
    const patch = makePatch([`async function save() { 'use server' }`]);
    const vs = runNextJsRules("app/form.tsx", "client-component", patch);
    expect(vs.some(v => v.body.includes("use server") && v.body.includes("module graph"))).toBe(true);
    expect(vs[0].severity).toBe("error");
  });
});

// ─── next/image ───────────────────────────────────────────────────────────────

describe("image/missing-alt", () => {
  it("flags <Image> without alt", () => {
    const patch = makePatch([`<Image src="/hero.png" width={800} height={400} />`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("alt"))).toBe(true);
  });

  it("does not flag <Image> with alt", () => {
    const patch = makePatch([`<Image src="/hero.png" width={800} height={400} alt="Hero" />`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.filter(v => v.body.includes("alt"))).toHaveLength(0);
  });
});

describe("image/missing-dimensions", () => {
  it("flags <Image> without width and without fill", () => {
    const patch = makePatch([`<Image src="/hero.png" alt="Hero" />`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("width") && v.body.includes("fill"))).toBe(true);
  });

  it("does not flag <Image fill>", () => {
    const patch = makePatch([`<Image src="/hero.png" fill alt="Hero" />`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.filter(v => v.body.includes("width") && v.body.includes("fill"))).toHaveLength(0);
  });
});

describe("image/raw-img-tag", () => {
  it("flags raw <img> in app/ files", () => {
    const patch = makePatch([`<img src="/hero.png" alt="Hero" />`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.some(v => v.body.includes("<img>") || v.body.includes("<Image>"))).toBe(true);
  });

  it("does not flag <img> outside app/", () => {
    const patch = makePatch([`<img src="/hero.png" alt="Hero" />`]);
    const vs = runNextJsRules("components/legacy.tsx", "other", patch);
    expect(vs.filter(v => v.body.includes("<img>"))).toHaveLength(0);
  });
});

// ─── server-actions/no-revalidation ──────────────────────────────────────────

describe("server-actions/no-revalidation", () => {
  it("flags mutation without revalidatePath/revalidateTag", () => {
    const patch = makePatch([`await db.post.create({ data: { title } })`]);
    const vs = runNextJsRules("app/actions.ts", "server-action-file", patch);
    expect(vs.some(v => v.body.includes("revalidatePath") || v.body.includes("revalidateTag"))).toBe(true);
    expect(vs[0].severity).toBe("warning");
  });

  it("does not flag mutation when revalidatePath is present", () => {
    const patch = makePatch([
      `await db.post.create({ data: { title } })`,
      `revalidatePath('/posts')`,
    ]);
    const vs = runNextJsRules("app/actions.ts", "server-action-file", patch);
    expect(vs.filter(v => v.body.includes("revalidatePath"))).toHaveLength(0);
  });
});

// ─── middleware/broad-matcher ─────────────────────────────────────────────────

describe("middleware/broad-matcher", () => {
  it("flags middleware missing config export", () => {
    const patch = makePatch([
      `import { NextResponse } from 'next/server'`,
      `export function middleware(req) { return NextResponse.next() }`,
    ]);
    const vs = runNextJsRules("middleware.ts", "middleware", patch);
    expect(vs.some(v => v.body.includes("matcher"))).toBe(true);
  });
});

// ─── metadata in client component ────────────────────────────────────────────

describe("metadata/in-client-component", () => {
  it("flags export const metadata in a client component", () => {
    const patch = makePatch([`export const metadata = { title: 'My Page' }`]);
    const vs = runNextJsRules("app/page.tsx", "client-component", patch);
    expect(vs.some(v => v.body.includes("metadata") && v.body.includes("ignored"))).toBe(true);
    expect(vs[0].severity).toBe("warning");
  });

  it("does not flag metadata in a server-component", () => {
    const patch = makePatch([`export const metadata = { title: 'My Page' }`]);
    const vs = runNextJsRules("app/page.tsx", "server-component", patch);
    expect(vs.filter(v => v.body.includes("metadata") && v.body.includes("ignored"))).toHaveLength(0);
  });
});
