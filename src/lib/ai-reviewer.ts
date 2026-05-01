import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { FileDiff } from "./pr-fetcher.js";
import { classifyFile } from "./file-classifier.js";
import { runNextJsRules } from "./nextjs-rules.js";

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

// ─── Provider selection ───────────────────────────────────────────────────────
// Set LLM_PROVIDER=anthropic|openai|gemini  (default: anthropic)
// Set the matching API key and optionally override the model:
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL  (default: claude-sonnet-4-6)
//   OPENAI_API_KEY    / OPENAI_MODEL     (default: gpt-4o)
//   GEMINI_API_KEY    / GEMINI_MODEL     (default: gemini-2.0-flash)

type Provider = "anthropic" | "openai" | "gemini";

function activeProvider(): Provider {
  const p = process.env.LLM_PROVIDER?.toLowerCase();
  if (p === "openai" || p === "gemini") return p;
  return "anthropic";
}

// Lazy-initialized clients — only the active provider's client is ever created,
// so unused API keys don't need to be present in the environment.
let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
let _gemini: GoogleGenerativeAI | null = null;

function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
function getGemini(): GoogleGenerativeAI {
  if (!_gemini) _gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _gemini;
}

// Single entry point for all providers
async function callLLM(system: string, user: string): Promise<string> {
  switch (activeProvider()) {
    case "openai":    return callOpenAI(system, user);
    case "gemini":    return callGemini(system, user);
    default:          return callAnthropic(system, user);
  }
}

// Anthropic — prompt caching on the system block (ephemeral TTL)
// The system prompt exceeds Sonnet 4.6's 2048-token cache minimum, so the
// cache_control breakpoint is effective and saves ~90% on repeated reviews.
async function callAnthropic(system: string, user: string): Promise<string> {
  const response = await getAnthropic().messages.create({
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const block = response.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}

// OpenAI — prompt caching is automatic for prompts >1024 tokens on gpt-4o / gpt-4o-mini.
// Cache key is the exact prefix, so the stable system prompt must come first (it does).
// The per-file user message goes last — it changes every call and is never cached.
// Cached tokens are billed at 50% of the input token price.
async function callOpenAI(system: string, user: string): Promise<string> {
  const response = await getOpenAI().chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    max_completion_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const total  = response.usage?.prompt_tokens ?? 0;
  if (total > 0) {
    console.log(`[ai-reviewer] OpenAI cache: ${cached}/${total} prompt tokens cached (${Math.round(cached / total * 100)}%)`);
  }

  return response.choices[0]?.message?.content ?? "";
}

// Gemini — system instruction passed via model config
async function callGemini(system: string, user: string): Promise<string> {
  const model = getGemini().getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    systemInstruction: system,
  });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 1024 },
  });
  return result.response.text();
}

// ~2500 tokens — must exceed Sonnet 4.6's 2048-token cache minimum
const SYSTEM_PROMPT = `You are an expert Next.js code reviewer for Next.js 15/16 App Router projects. A per-file API reference is provided in each review request — use it to produce precise code suggestions with correct types and signatures, not generic advice.

Only flag issues in these categories — skip style preferences, formatting, and nitpicks:
- Bugs that cause incorrect behavior or runtime crashes
- Security vulnerabilities
- Performance issues that cause noticeable user-facing degradation
- Type safety violations that hide real runtime errors
- Next.js / React framework misuse that breaks expected behavior

Static analysis has already flagged deterministic violations listed in the prompt. DO NOT duplicate those.

---

## Next.js 15/16 Breaking Changes (apply to all file types)

- \`params\` and \`searchParams\` in pages/layouts/route handlers/OG images are now **Promises** — the TypeScript type is \`Promise<{ key: string }>\`, and you must \`const { key } = await params\` before accessing properties.
- \`cookies()\` and \`headers()\` from \`next/headers\` are now **async** — \`const cookieStore = await cookies()\`.
- \`fetch()\` default caching changed: v13/14 default was \`force-cache\`; **v15+ default is \`auto no cache\`** (fetches every request unless you add explicit options).
- Route Handler GET caching changed from static to dynamic by default in v15.
- \`middleware.ts\` / \`middleware\` function is deprecated in v16 — renamed to \`proxy.ts\` / \`proxy\`. Codemod: \`npx @next/codemod@canary middleware-to-proxy .\`
- \`<Image priority>\` deprecated in v16 → use \`preload\` prop instead.

---

## Server Components

ALWAYS flag:
- React hooks (\`useState\`, \`useEffect\`, \`useRef\`, \`useReducer\`, \`useContext\`, \`useCallback\`, \`useMemo\`) — Server Components have no client runtime; this is a build error.
- \`"use client"\` after import statements — Next.js silently ignores it; the file stays a Server Component and hooks will crash.
- \`cookies()\`/\`headers()\` without \`await\` — returns a Promise object, not the value.
- \`params.X\` or \`searchParams.X\` without prior \`await params\`/\`await searchParams\` — returns a Promise object.
- \`fetch()\` without \`{ cache: 'force-cache' }\` or \`{ next: { revalidate: N } }\` when data is static — in v15 the default is no-store; static data will be re-fetched on every request.
- Conflicting \`{ revalidate: N, cache: 'no-store' }\` on the same fetch — both options are silently ignored and a warning is logged; use one or the other.
- Missing \`<Suspense>\` boundary around an async Server Component doing data fetching — the entire page blocks until the slowest fetch completes.
- Non-serializable values (functions, class instances, Dates) passed as props to Client Components — only plain JSON-serializable values can cross the server/client boundary.
- \`router.push()\` for navigation that belongs in a Server Component — use \`redirect()\` from \`next/navigation\` instead.
- Server code that should be isolated imported without \`import 'server-only'\` — any accidental client import silently exposes it; use the \`server-only\` package as a build-time guard.

## Client Components

ALWAYS flag:
- Database calls or \`fetch\` with auth headers/secrets — these run in the browser; move to a Server Component or Route Handler.
- \`export const metadata\` — silently ignored; Next.js only reads metadata from Server Components.
- Inline \`"use server"\` directive — declaring a Server Action inside a Client Component file leaks the module graph. Put Server Actions in a dedicated \`actions.ts\` with \`'use server'\` at the top.
- \`useState\` initialized from a prop without a sync mechanism — if the prop changes the state stays at its initial value (derived-state anti-pattern).
- \`useEffect\` missing a dependency that the effect reads — stale closure; the effect captures the old value and never re-runs when it changes.
- Missing \`useEffect\` cleanup for subscriptions, event listeners, timers, or WebSockets — fires after unmount causing memory leaks.
- Hooks called conditionally or after an early \`return\` — violates Rules of Hooks; causes "Rendered more hooks than previous render" crashes.
- \`useMemo\`/\`useCallback\` with \`[]\` dependencies that close over changing values — permanently stale memoization.

## Route Handlers

ALWAYS flag:
- \`"use client"\` — has no effect in Route Handlers; they always run on the server.
- \`cookies()\`/\`headers()\` without \`await\` — they are async in v15+.
- \`context.params\` accessed without \`await\` — \`params\` is a Promise in v15+.
- Reading query string via \`req.url\` parsing instead of \`request.nextUrl.searchParams.get('key')\`.
- Returning full database records with sensitive fields — always \`select\` explicit fields.
- Missing \`null\` check after \`findUnique()\`/\`findFirst()\` before accessing properties — throws when record doesn't exist.
- \`cors({ origin: '*' })\` on authenticated routes — allows any origin to make credentialed requests.
- String-interpolated SQL — SQL injection; use parameterized queries.
- Setting response headers via mutating \`headers()\` result — it's read-only. Pass headers to \`new Response(..., { headers: {} })\` or \`NextResponse.next({ request: { headers: requestHeaders } })\`.

## Server Actions

ALWAYS flag:
- \`redirect()\` called before \`revalidatePath()\`/\`revalidateTag()\` — \`redirect()\` throws a control-flow exception; any code after it (including revalidation) never runs. Call revalidation first.
- Database mutations without \`revalidatePath()\`/\`revalidateTag()\` — Next.js cache serves stale data after the mutation.
- No authentication/authorization check at the top of the action — Server Actions are reachable via direct POST requests; middleware alone does not protect them.
- \`FormData\` or arguments spread directly into a database write without validation — mass assignment. Use \`zod\` to parse inputs first.
- Secrets or internal data returned from the action — actions are invoked from the client; return only what the UI needs.

## Middleware / Proxy

ALWAYS flag:
- Matcher that matches \`/_next/static\`, \`/_next/image\`, or \`favicon.ico\` — runs on every static asset, degrades performance. Use a negative lookahead: \`/((?!_next/static|_next/image|favicon.ico).*)\`.
- Missing \`export const config = { matcher: [...] }\` — middleware/proxy runs on every request including static assets.
- Passing headers to the response via \`NextResponse.next({ headers: requestHeaders })\` — this sends headers to the client, not upstream. Use \`NextResponse.next({ request: { headers: requestHeaders } })\` to forward to the origin.
- Still using \`middleware.ts\` / \`export function middleware\` in a v16 project — the correct file is \`proxy.ts\` with \`export function proxy\`.

## React Hooks

ALWAYS flag (when not already caught by static analysis):
- \`useMemo\` or \`useCallback\` dependency array is \`[]\` but the callback references a value that changes — permanently stale, produces wrong results.
- \`useEffect\` used to sync state B whenever state A changes — almost always means state B is derived state that should be computed during render, not stored separately.
- Array index used as \`key\` in \`Array.map()\` when items can be reordered, filtered, or deleted — React reuses the wrong DOM nodes and corrupts component state.

## TypeScript Safety

ALWAYS flag:
- \`as any\` or \`as unknown as T\` to suppress a real type error.
- Non-null assertion \`!\` on a value that can be \`null\`/\`undefined\` at runtime.
- \`JSON.parse()\` result used without \`zod\`/\`superstruct\` parsing or manual type narrowing — returns \`any\`.
- \`catch (e)\` accessing \`e.message\` without \`if (e instanceof Error)\` — caught values are \`unknown\` in strict mode.
- \`req.body as SomeType\` — type assertion with no runtime validation.

## Security (all file types)

ALWAYS flag:
- \`dangerouslySetInnerHTML={{ __html: userContent }}\` without sanitization — XSS.
- \`eval()\` or \`new Function()\` with user-controlled input — RCE.
- Auth tokens / JWTs in \`localStorage\`/\`sessionStorage\` — accessible to any XSS. Use \`HttpOnly\` cookies.
- \`path.join(baseDir, req.query.file)\` without checking the result starts with \`baseDir\` — path traversal.
- Secrets compared with \`===\` — timing side-channel. Use \`crypto.timingSafeEqual()\`.
- \`child_process.exec()\`/\`execSync()\` with user-controlled input — command injection.
- \`NEXT_PUBLIC_\` env vars containing secrets — inlined into the client bundle at build time.

## Next.js Image Component

ALWAYS flag:
- \`<Image>\` without \`alt\` — required; breaks accessibility and Next.js lint rules.
- \`<Image>\` without \`width\`+\`height\` AND without \`fill\` — required for layout shift prevention; throws at runtime.
- \`<Image fill>\` inside a parent that lacks \`position: relative/absolute/fixed\` — image will not display.
- \`<Image>\` without \`sizes\` when using \`fill\` or responsive layouts — browser assumes \`100vw\` and downloads unnecessarily large images.
- \`<img>\` in \`app/\` files — use \`<Image>\` from \`next/image\` for automatic optimization.
- \`priority\` prop on \`<Image>\` in a v16 project — deprecated; use \`preload\` instead.
- Remote image \`src\` without a matching entry in \`next.config.js\` \`images.remotePatterns\` — Next.js blocks unregistered external domains.

---

## Pages Router APIs (forbidden in App Router)

ALWAYS flag when found in \`app/\` files:
- \`import { useRouter } from 'next/router'\` — Pages Router only; throws at runtime in App Router. Use \`useRouter\` / \`usePathname\` / \`useSearchParams\` / \`useParams\` from \`next/navigation\`.
- \`import Head from 'next/head'\` — Pages Router only; silently ignored in \`app/\`. Export \`metadata\` or \`generateMetadata()\` from the nearest Server Component (page or layout).
- \`export function getServerSideProps\` / \`getStaticProps\` / \`getStaticPaths\` — silently ignored in App Router; the export compiles but is never called. Fetch data directly in an \`async\` Server Component.
- \`<a href="/...">\` for internal paths — causes a full page reload. Use \`<Link href="...">\` from \`next/link\` for client-side transitions, prefetching, and scroll restoration.

---

## Output Format

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences outside the JSON.

Each element:
{
  "line": <integer — the exact line number in the NEW version of the file>,
  "body": "<[ERROR] or [WARNING] prefix — ERROR for bugs/crashes/security, WARNING for performance/best-practice. Then one sentence stating what is wrong and why it breaks. Then a fenced diff block showing exactly what to change — use - for lines to remove and + for lines to add, using actual variable names from the code and exact API signatures from the reference provided.>"
}

Example body:
"[ERROR] \`useRouter\` is imported from \`next/router\` which is the Pages Router API and throws in App Router.\\n\`\`\`diff\\n- import { useRouter } from 'next/router'\\n+ import { useRouter } from 'next/navigation'\\n\`\`\`"

Rules:
- Only cite addition lines (prefixed \`+\`) or context lines. Never cite deleted lines (\`-\`).
- Return \`[]\` when there are no real issues.
- Maximum 5 comments per file — prioritize highest severity.
- Do not invent issues. Only flag what is clearly visible in the diff.
- Do not duplicate any issue under "Already flagged by static analysis".`;

// Returns a concise API reference for the specific file type being reviewed.
// Injected into the user message (not the system prompt) so it's targeted and doesn't
// bloat the cached system prompt with context irrelevant to the current file.
function getFileTypeContext(fileType: import("./file-classifier.js").NextFileType): string {
  switch (fileType) {
    case "server-component":
      return `## Server Component API Reference (Next.js 15+)

Async page/layout with params (params is a Promise):
\`\`\`tsx
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string }>
}) {
  const { slug } = await params
  const { q } = await searchParams
  const data = await fetch(\`/api/posts/\${slug}\`, {
    next: { revalidate: 60 },   // ISR — revalidate every 60s
    // OR: cache: 'force-cache'  // static
    // OR: cache: 'no-store'     // always dynamic
  })
  return <Suspense fallback={<Loading />}><PostView data={data} /></Suspense>
}
\`\`\`

cookies / headers (must await):
\`\`\`ts
import { cookies, headers } from 'next/headers'
const cookieStore = await cookies()
const token = cookieStore.get('token')?.value
const headersList = await headers()
const auth = headersList.get('authorization')
\`\`\`

Prevent server code from reaching client bundle:
\`\`\`ts
import 'server-only'  // build error if this file is imported in a Client Component
\`\`\`

fetch() caching (v15 default is no-store — be explicit):
\`\`\`ts
// Static (cached indefinitely):
fetch(url, { cache: 'force-cache' })
// ISR:
fetch(url, { next: { revalidate: 3600 } })
// Tagged for on-demand revalidation:
fetch(url, { next: { tags: ['posts'] } })
// Always dynamic:
fetch(url, { cache: 'no-store' })
// WRONG — conflicting options are silently ignored:
fetch(url, { cache: 'no-store', next: { revalidate: 60 } })
\`\`\``;

    case "client-component":
      return `## Client Component API Reference

'use client' placement — must be above ALL imports:
\`\`\`tsx
'use client'           // ← FIRST line
import { useState } from 'react'
\`\`\`

Correct useEffect with cleanup:
\`\`\`tsx
useEffect(() => {
  const handler = () => { /* ... */ }
  window.addEventListener('resize', handler)
  return () => window.removeEventListener('resize', handler)  // cleanup required
}, [dependency])  // every value read inside must be listed
\`\`\`

Server Actions in Client Components — import, never define inline:
\`\`\`tsx
// WRONG — inline "use server" in a client file leaks module graph:
async function save() { 'use server'; /* ... */ }

// CORRECT — import from a dedicated file:
import { savePost } from '@/app/actions'
\`\`\`

useActionState for Server Action feedback:
\`\`\`tsx
import { useActionState, startTransition } from 'react'
const [state, action, pending] = useActionState(savePost, null)
\`\`\`

Derived state — compute during render, don't sync with useEffect:
\`\`\`tsx
// WRONG:
const [uppercased, setUppercased] = useState(text.toUpperCase())
useEffect(() => setUppercased(text.toUpperCase()), [text])
// CORRECT:
const uppercased = text.toUpperCase()  // computed, not stored
\`\`\``;

    case "route-handler":
      return `## Route Handler API Reference (Next.js 15+)

Supported exports: GET POST PUT PATCH DELETE HEAD OPTIONS
params is a Promise in v15+:
\`\`\`ts
import { NextRequest, NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params                          // must await
  const query = request.nextUrl.searchParams.get('q') // query string
  const cookieStore = await cookies()                 // must await
  const auth = (await headers()).get('authorization') // must await
  return NextResponse.json({ id })
}
\`\`\`

Segment config:
\`\`\`ts
export const dynamic = 'force-dynamic'  // or 'force-static' | 'auto'
export const revalidate = 60            // seconds
export const runtime = 'nodejs'        // or 'edge'
\`\`\`

Setting cookies on the response (headers are read-only — cannot .set() them):
\`\`\`ts
// CORRECT:
return new Response(body, { headers: { 'Set-Cookie': 'token=abc; HttpOnly' } })

// WRONG — headers() result is read-only:
const h = await headers(); h.set('x-foo', 'bar')
\`\`\`

Forwarding modified request headers upstream (not to client):
\`\`\`ts
// CORRECT:
return NextResponse.next({ request: { headers: modifiedHeaders } })
// WRONG — this sends headers to the client response:
return NextResponse.next({ headers: modifiedHeaders })
\`\`\``;

    case "server-action-file":
      return `## Server Action API Reference (Next.js 15+)

File-level directive — all exports become Server Actions:
\`\`\`ts
'use server'
import { revalidatePath, revalidateTag } from 'next/cache'
import { redirect } from 'next/navigation'
\`\`\`

Mutation + revalidation — revalidate BEFORE redirect (redirect() throws):
\`\`\`ts
export async function createPost(formData: FormData) {
  // 1. Validate input first
  const title = formData.get('title')
  if (!title) return { error: 'Title required' }

  // 2. Check auth — middleware does NOT protect Server Actions
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')

  // 3. Mutate
  await db.post.create({ data: { title: String(title) } })

  // 4. Revalidate BEFORE redirect (redirect throws; code after it never runs)
  revalidatePath('/posts')
  redirect('/posts')   // ← must be last
}
\`\`\`

On-demand cache invalidation by tag:
\`\`\`ts
revalidateTag('posts')  // invalidates all fetch() calls tagged with 'posts'
\`\`\`

useActionState pattern (Client Component side):
\`\`\`tsx
'use client'
import { useActionState } from 'react'
import { createPost } from './actions'
const [state, action, pending] = useActionState(createPost, null)
\`\`\``;

    case "middleware":
      return `## Middleware / Proxy API Reference

v16 breaking change: rename middleware.ts → proxy.ts, function middleware → proxy:
\`\`\`ts
// proxy.ts  (was middleware.ts in v15)
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  return NextResponse.redirect(new URL('/home', request.url))
}
\`\`\`

Matcher — exclude static assets with negative lookahead:
\`\`\`ts
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',  // correct
    // WRONG — matches everything including static assets:
    // '/(.*)'
  ],
}
\`\`\`

Matcher values must be string constants (statically analyzed — no variables).

Reading / writing cookies:
\`\`\`ts
// Read from request:
const token = request.cookies.get('token')?.value
// Write to response:
const response = NextResponse.next()
response.cookies.set({ name: 'session', value: 'abc', httpOnly: true, path: '/' })
\`\`\`

Forward modified request headers UPSTREAM (not to client):
\`\`\`ts
const requestHeaders = new Headers(request.headers)
requestHeaders.set('x-user-id', userId)
return NextResponse.next({ request: { headers: requestHeaders } })  // upstream
// NOT: NextResponse.next({ headers: requestHeaders })              // goes to client
\`\`\`

Execution order: next.config.js headers → next.config.js redirects → proxy → filesystem routes.`;

    default:
      return "";
  }
}

export async function reviewPRFiles(
  files: FileDiff[],
  prTitle: string,
  repoName: string
): Promise<ReviewComment[]> {
  if (files.length === 0) return [];

  const allComments: ReviewComment[] = [];
  for (const file of files) {
    try {
      const comments = await reviewSingleFile(file, prTitle, repoName);
      allComments.push(...comments);
    } catch (err) {
      console.error(`[ai-reviewer] Failed to review ${file.filename}:`, err);
    }
  }
  return allComments;
}

async function reviewSingleFile(
  file: FileDiff,
  prTitle: string,
  repoName: string
): Promise<ReviewComment[]> {
  const fileType = classifyFile(file.filename, file.patch);
  const violations = runNextJsRules(file.filename, fileType, file.patch);

  const deterministicComments: ReviewComment[] = violations.map(v => ({
    path: file.filename,
    line: v.line,
    body: `**[${v.severity.toUpperCase()}]** ${v.body}`,
  }));

  const annotated = annotatePatchWithLineNumbers(file.patch);

  const staticAnalysisNote = violations.length > 0
    ? `\nAlready flagged by static analysis (DO NOT duplicate):\n${violations.map(v => `- Line ${v.line}: ${v.body}`).join("\n")}\n`
    : "";

  const fileTypeContext = getFileTypeContext(fileType);

  const userMessage = `Repository: ${repoName}
PR title: ${prTitle}

File: ${file.filename}
File type: ${fileType}
${staticAnalysisNote}
${fileTypeContext ? `${fileTypeContext}\n` : ""}Review the following diff for bugs, security issues, and Next.js framework misuse specific to a ${fileType}. Use the API reference above for precise code suggestions.

\`\`\`diff
${annotated}
\`\`\`

Return ONLY a JSON array. Use the [L<number>] annotations for line numbers.`;

  const text = await callLLM(SYSTEM_PROMPT, userMessage);
  const llmFindings = parseComments(file.filename, text);

  // Drop LLM findings that land on a line already covered by a deterministic violation
  const llmComments = llmFindings.filter(
    c => !violations.some(v => Math.abs(v.line - c.line) <= 1)
  );

  return [...deterministicComments, ...llmComments];
}

// Prefixes each diff line with its new-file line number for the model to reference
function annotatePatchWithLineNumbers(patch: string): string {
  const out: string[] = [];
  let newLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1]) - 1;
      out.push(line);
    } else if (line.startsWith("+")) {
      newLine++;
      out.push(`[L${newLine}]${line}`); // e.g. [L42]+  const foo = bar;
    } else if (line.startsWith("-")) {
      out.push(line); // deleted lines have no new-file line number
    } else {
      newLine++;
      out.push(`[L${newLine}] ${line.slice(1)}`); // context line
    }
  }

  return out.join("\n");
}

function parseComments(filename: string, text: string): ReviewComment[] {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const raw: Array<{ line: unknown; body: unknown }> = JSON.parse(match[0]);
    return raw
      .filter(
        (c) =>
          typeof c.line === "number" &&
          c.line > 0 &&
          typeof c.body === "string" &&
          c.body.trim().length > 0
      )
      .map((c) => ({
        path: filename,
        line: c.line as number,
        body: c.body as string,
      }));
  } catch {
    return [];
  }
}
