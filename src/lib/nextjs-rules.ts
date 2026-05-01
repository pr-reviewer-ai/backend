import type { NextFileType } from "./file-classifier.js";

export interface Violation {
  line: number;
  severity: "error" | "warning";
  body: string;
}

export function runNextJsRules(
  filename: string,
  fileType: NextFileType,
  patch: string,
): Violation[] {
  const violations: Violation[] = [];
  const lines = patch.split("\n");

  // Added lines with their new-file line numbers (mirrors annotatePatchWithLineNumbers logic)
  const addedLines: Array<{ lineNo: number; text: string }> = [];
  let newLine = 0;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1]) - 1;
    } else if (raw.startsWith("+")) {
      newLine++;
      addedLines.push({ lineNo: newLine, text: raw.slice(1) });
    } else if (!raw.startsWith("-")) {
      newLine++;
    }
  }

  const addedText = addedLines.map(l => l.text).join("\n");

  // ── use-server/in-page-or-layout ─────────────────────────────────────────
  if (/\/(page|layout)\.[jt]sx?$/.test(filename)) {
    const hit = addedLines.find(l => /^\s*["']use server["']/.test(l.text));
    if (hit) {
      violations.push({
        line: hit.lineNo,
        severity: "error",
        body: `\`"use server"\` at the top of a page or layout turns every export into a Server Action — the \`default\` export (the page component) becomes unreachable as a route. Remove the directive; pages and layouts are already Server Components by default.\n\`\`\`diff\n- "use server"\n\`\`\``,
      });
    }
  }

  // ── use-client/after-imports ──────────────────────────────────────────────
  {
    const useClientIdx = addedLines.findIndex(l => /^\s*["']use client["']/.test(l.text));
    if (useClientIdx !== -1) {
      const importBeforeIdx = addedLines.findIndex(l => /^\s*import\s/.test(l.text));
      if (importBeforeIdx !== -1 && importBeforeIdx < useClientIdx) {
        violations.push({
          line: addedLines[useClientIdx].lineNo,
          severity: "error",
          body: `\`"use client"\` must be the very first line — Next.js silently ignores it when it appears after imports, turning the file into a Server Component and crashing any hooks or browser APIs used inside.\n\`\`\`diff\n- import { useState } from 'react'\n- "use client"\n+ "use client"\n+ import { useState } from 'react'\n\`\`\``,
        });
      }
    }
  }

  // ── use-client/in-route-handler ───────────────────────────────────────────
  if (fileType === "route-handler") {
    const hit = addedLines.find(l => /["']use client["']/.test(l.text));
    if (hit) {
      violations.push({
        line: hit.lineNo,
        severity: "warning",
        body: `\`"use client"\` has no effect in a Route Handler — Route Handlers always run on the server; remove this directive.\n\`\`\`diff\n- "use client"\n\`\`\``,
      });
    }
  }

  // ── hooks/in-server-component ─────────────────────────────────────────────
  if (fileType === "server-component") {
    const hookImport = addedLines.find(l =>
      /\b(useState|useEffect|useRef|useReducer|useContext|useCallback|useMemo)\b/.test(l.text)
    );
    if (hookImport) {
      const hook = hookImport.text.match(/\b(useState|useEffect|useRef|useReducer|useContext|useCallback|useMemo)\b/)?.[1] ?? "useState";
      violations.push({
        line: hookImport.lineNo,
        severity: "error",
        body: `\`${hook}\` cannot be used in a Server Component — hooks require a client runtime and will cause a build error. Add \`"use client"\` at the top of this file, or extract the stateful part into a separate Client Component.\n\`\`\`diff\n+ "use client"\n  import { ${hook} } from 'react'\n\`\`\``,
      });
    }
  }

  // ── async-params/sync-cookies ─────────────────────────────────────────────
  for (const { lineNo, text } of addedLines) {
    if (/\b(cookies|headers)\(\)/.test(text) && !/await\s+(cookies|headers)\(\)/.test(text)) {
      const fn = text.match(/\b(cookies|headers)\(\)/)?.[1] ?? "cookies";
      const varName = text.match(/const\s+(\w+)\s*=/)?.[1] ?? (fn === "cookies" ? "cookieStore" : "headerStore");
      violations.push({
        line: lineNo,
        severity: "error",
        body: `\`${fn}()\` must be \`await\`ed in Next.js 15+ — calling it synchronously returns a Promise instead of the value, causing silent runtime bugs.\n\`\`\`diff\n- const ${varName} = ${fn}()\n+ const ${varName} = await ${fn}()\n\`\`\``,
      });
    }
  }

  // ── async-params/sync-params ──────────────────────────────────────────────
  {
    const hasAwaitParams = /await\s+params\b/.test(addedText);
    const hasAwaitSearchParams = /await\s+searchParams\b/.test(addedText);

    for (const { lineNo, text } of addedLines) {
      const accessesParams = /\bparams\.[a-zA-Z]/.test(text) || /\}\s*=\s*params\b/.test(text);
      const accessesSearchParams = /\bsearchParams\.[a-zA-Z]/.test(text) || /\}\s*=\s*searchParams\b/.test(text);

      if (!hasAwaitParams && accessesParams) {
        const keys = text.match(/\{\s*([^}]+)\}/)?.[1]?.trim() ?? "id";
        violations.push({
          line: lineNo,
          severity: "error",
          body: `\`params\` must be \`await\`ed before destructuring in Next.js 15+ — reading it synchronously returns a Promise object, not the route segment values.\n\`\`\`diff\n- const { ${keys} } = params\n+ const { ${keys} } = await params\n\`\`\``,
        });
        break;
      }
      if (!hasAwaitSearchParams && accessesSearchParams) {
        const keys = text.match(/\{\s*([^}]+)\}/)?.[1]?.trim() ?? "q";
        violations.push({
          line: lineNo,
          severity: "error",
          body: `\`searchParams\` must be \`await\`ed before destructuring in Next.js 15+ — reading it synchronously returns a Promise object, not the query string values.\n\`\`\`diff\n- const { ${keys} } = searchParams\n+ const { ${keys} } = await searchParams\n\`\`\``,
        });
        break;
      }
    }
  }

  // ── server-actions/inline-in-client ───────────────────────────────────────
  if (fileType === "client-component") {
    for (const { lineNo, text } of addedLines) {
      if (/["']use server["']/.test(text)) {
        violations.push({
          line: lineNo,
          severity: "error",
          body: `Inline \`"use server"\` inside a Client Component file leaks the module graph and can expose server-only imports to the browser bundle. Move Server Actions to a dedicated \`actions.ts\` file.\n\`\`\`diff\n- async function save() { 'use server'; /* ... */ }\n+ // actions.ts\n+ 'use server'\n+ export async function save() { /* ... */ }\n\`\`\``,
        });
      }
    }
  }

  // ── server-actions/no-revalidation ────────────────────────────────────────
  if (fileType === "server-action-file") {
    const hasMutation = /\.(create|update|delete|insert)\(/.test(addedText);
    const hasRevalidation = /\b(revalidatePath|revalidateTag|redirect)\(/.test(addedText);
    if (hasMutation && !hasRevalidation) {
      const hit = addedLines.find(l => /\.(create|update|delete|insert)\(/.test(l.text));
      if (hit) {
        violations.push({
          line: hit.lineNo,
          severity: "warning",
          body: `This Server Action mutates data but never calls \`revalidatePath()\` or \`revalidateTag()\` — the Next.js cache will serve stale data until the next full reload.\n\`\`\`diff\n  await db.post.create({ ... })\n+ revalidatePath('/posts')\n\`\`\``,
        });
      }
    }
  }

  // ── metadata/in-client-component ─────────────────────────────────────────
  if (fileType === "client-component") {
    const hit = addedLines.find(l => /export\s+const\s+metadata\b/.test(l.text));
    if (hit) {
      violations.push({
        line: hit.lineNo,
        severity: "warning",
        body: `\`export const metadata\` is silently ignored in Client Components — Next.js only reads it from Server Components. Move this export to the nearest \`page.tsx\` or \`layout.tsx\`.\n\`\`\`diff\n- // client-component.tsx\n- export const metadata = { title: 'My Page' }\n+ // page.tsx  ← Server Component\n+ export const metadata = { title: 'My Page' }\n\`\`\``,
      });
    }
  }

  // ── metadata/viewport-in-metadata ────────────────────────────────────────
  {
    const hit = addedLines.find(l => /\bviewport\s*:/.test(l.text));
    if (hit && /metadata/i.test(addedText)) {
      violations.push({
        line: hit.lineNo,
        severity: "warning",
        body: `The \`viewport\` key inside \`metadata\` was deprecated in Next.js 14 and is silently ignored — export it as a separate \`viewport\` object instead.\n\`\`\`diff\n- export const metadata = { title: '...', viewport: { width: 'device-width' } }\n+ export const metadata = { title: '...' }\n+ export const viewport = { width: 'device-width' }\n\`\`\``,
      });
    }
  }

  // ── image/missing-alt ─────────────────────────────────────────────────────
  for (const { lineNo, text } of addedLines) {
    if (/<Image\b[^>]*>?/.test(text) && !/\balt=/.test(text)) {
      violations.push({
        line: lineNo,
        severity: "error",
        body: `\`<Image>\` is missing an \`alt\` attribute — this breaks accessibility (WCAG 1.1.1) and fails Next.js's built-in lint rules.\n\`\`\`diff\n- <Image src="..." width={800} height={400} />\n+ <Image src="..." width={800} height={400} alt="description of image" />\n\`\`\``,
      });
    }
  }

  // ── image/missing-dimensions ──────────────────────────────────────────────
  for (const { lineNo, text } of addedLines) {
    if (/<Image\b[^>]*>?/.test(text) && !/\bwidth=/.test(text) && !/\bfill\b/.test(text)) {
      violations.push({
        line: lineNo,
        severity: "error",
        body: `\`<Image>\` requires either \`width\` + \`height\` props or the \`fill\` prop — without them Next.js cannot prevent layout shift (CLS) and will throw at runtime.\n\`\`\`diff\n- <Image src="..." alt="..." />\n+ <Image src="..." width={800} height={400} alt="..." />\n+ {/* or for responsive/fill layouts: */}\n+ <Image src="..." fill sizes="100vw" alt="..." />\n\`\`\``,
      });
    }
  }

  // ── image/raw-img-tag ─────────────────────────────────────────────────────
  if (/^(?:src\/)?app\//.test(filename)) {
    for (const { lineNo, text } of addedLines) {
      if (/<img\s/.test(text)) {
        violations.push({
          line: lineNo,
          severity: "warning",
          body: `Raw \`<img>\` loses Next.js automatic optimisation, lazy loading, and layout-shift prevention — use \`<Image>\` from \`next/image\` instead.\n\`\`\`diff\n+ import Image from 'next/image'\n- <img src="/hero.png" width={800} height={400} alt="Hero" />\n+ <Image src="/hero.png" width={800} height={400} alt="Hero" />\n\`\`\``,
        });
      }
    }
  }

  // ── middleware/broad-matcher ──────────────────────────────────────────────
  if (fileType === "middleware") {
    const hit = addedLines.find(l =>
      /matcher.*["'](\/\(.*\)|\/\(\.\*\)|^\/$)/.test(l.text) && !/_next/.test(l.text)
    );
    if (hit) {
      violations.push({
        line: hit.lineNo,
        severity: "error",
        body: `The matcher is too broad and will intercept \`/_next/static\`, \`/_next/image\`, and \`favicon.ico\` on every request, degrading performance. Add a negative lookahead to exclude Next.js internals.\n\`\`\`diff\n- matcher: ['/(.*)']\n+ matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']\n\`\`\``,
      });
    }
  }

  // ── middleware/missing-matcher ────────────────────────────────────────────
  if (fileType === "middleware") {
    const hasConfig = /export\s+const\s+config\b/.test(addedText);
    if (!hasConfig) {
      violations.push({
        line: addedLines[0]?.lineNo ?? 1,
        severity: "warning",
        body: `No \`export const config\` matcher — the middleware runs on every request including static assets, which degrades performance.\n\`\`\`diff\n+ export const config = {\n+   matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],\n+ }\n\`\`\``,
      });
    }
  }

  // ── cache/fetch-no-options ────────────────────────────────────────────────
  if (fileType === "server-component") {
    for (const { lineNo, text } of addedLines) {
      if (/\bfetch\(/.test(text) && !/cache:|revalidate:/.test(text)) {
        violations.push({
          line: lineNo,
          severity: "warning",
          body: `\`fetch()\` has no explicit caching option — in Next.js 15 the default changed from \`force-cache\` to \`no-store\`, so this re-fetches on every request. Make the intent explicit.\n\`\`\`diff\n- const res = await fetch('/api/data')\n+ const res = await fetch('/api/data', { cache: 'force-cache' })     // static\n+ // or: { next: { revalidate: 60 } }                                // ISR\n+ // or: { cache: 'no-store' }                                       // always dynamic\n\`\`\``,
        });
      }
    }
  }

  // ── secrets/next-public ───────────────────────────────────────────────────
  for (const { lineNo, text } of addedLines) {
    if (/NEXT_PUBLIC_\w*(SECRET|KEY|TOKEN|PASSWORD|PRIVATE)\w*/i.test(text)) {
      const varName = text.match(/NEXT_PUBLIC_\w*(SECRET|KEY|TOKEN|PASSWORD|PRIVATE)\w*/i)?.[0] ?? "NEXT_PUBLIC_SECRET";
      const serverName = varName.replace(/^NEXT_PUBLIC_/, "");
      violations.push({
        line: lineNo,
        severity: "error",
        body: `\`NEXT_PUBLIC_\` variables are inlined into the client bundle at build time and visible to every browser — never use this prefix for secrets.\n\`\`\`diff\n- ${varName}=your-secret\n+ ${serverName}=your-secret\n\`\`\``,
      });
    }
  }

  // ── pages-router/wrong-router-import ──────────────────────────────────────
  if (/^(?:src\/)?app\//.test(filename)) {
    const hit = addedLines.find(l => /from\s+["']next\/router["']/.test(l.text));
    if (hit) {
      violations.push({
        line: hit.lineNo,
        severity: "error",
        body: `\`next/router\` is the Pages Router API and does not exist in App Router — it will throw at runtime. Use \`next/navigation\` instead.\n\`\`\`diff\n- import { useRouter } from 'next/router'\n+ import { useRouter } from 'next/navigation'\n\`\`\``,
      });
    }
  }

  // ── pages-router/head-import ──────────────────────────────────────────────
  if (/^(?:src\/)?app\//.test(filename)) {
    const hit = addedLines.find(l => /import\s+Head\s+from\s+["']next\/head["']/.test(l.text));
    if (hit) {
      violations.push({
        line: hit.lineNo,
        severity: "error",
        body: `\`next/head\` and \`<Head>\` are Pages Router only and are silently ignored in \`app/\`. Export a \`metadata\` object from a Server Component instead.\n\`\`\`diff\n- import Head from 'next/head'\n- // ...\n- <Head><title>My Page</title></Head>\n+ // page.tsx or layout.tsx (Server Component)\n+ export const metadata = { title: 'My Page', description: '...' }\n\`\`\``,
      });
    }
  }

  // ── pages-router/data-fetching-exports ────────────────────────────────────
  if (/^(?:src\/)?app\//.test(filename)) {
    const hit = addedLines.find(l =>
      /export\s+(async\s+)?function\s+(getServerSideProps|getStaticProps|getStaticPaths)\b/.test(l.text)
    );
    if (hit) {
      const fnName = hit.text.match(/(getServerSideProps|getStaticProps|getStaticPaths)/)?.[1] ?? "getServerSideProps";
      violations.push({
        line: hit.lineNo,
        severity: "error",
        body: `\`${fnName}\` is a Pages Router convention — it is silently ignored in App Router and never called. Fetch data directly inside an \`async\` Server Component.\n\`\`\`diff\n- export async function ${fnName}() {\n-   const data = await fetch('/api/data').then(r => r.json())\n-   return { props: { data } }\n- }\n+ export default async function Page() {\n+   const data = await fetch('/api/data', { cache: 'force-cache' }).then(r => r.json())\n+   return <div>{/* use data */}</div>\n+ }\n\`\`\``,
      });
    }
  }

  // ── navigation/raw-anchor-tag ─────────────────────────────────────────────
  if (/^(?:src\/)?app\//.test(filename)) {
    for (const { lineNo, text } of addedLines) {
      if (/<a\s[^>]*href=["']\/?[^"'#http]/.test(text)) {
        const href = text.match(/href=["']([^"']+)["']/)?.[1] ?? "/path";
        const label = text.match(/>([^<]+)<\/a>/)?.[1]?.trim() ?? "Link text";
        violations.push({
          line: lineNo,
          severity: "warning",
          body: `Raw \`<a>\` for internal navigation causes a full page reload and loses client-side transitions, prefetching, and scroll restoration — use \`<Link>\` from \`next/link\`.\n\`\`\`diff\n+ import Link from 'next/link'\n- <a href="${href}">${label}</a>\n+ <Link href="${href}">${label}</Link>\n\`\`\``,
        });
      }
    }
  }

  return violations;
}
