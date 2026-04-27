import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { FileDiff } from "./pr-fetcher.js";

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

// OpenAI — GPT-4o automatically caches system prompts >1024 tokens (no explicit opt-in needed)
async function callOpenAI(system: string, user: string): Promise<string> {
  const response = await getOpenAI().chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
    max_completion_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
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
const SYSTEM_PROMPT = `You are an expert code reviewer specializing in React, Next.js 13+ App Router, TypeScript, and Node.js/Express. You review pull request diffs and identify genuine bugs, security vulnerabilities, and significant code quality issues.

Only flag issues in these categories — skip style preferences, formatting, and nitpicks:
- Bugs that cause incorrect behavior or runtime crashes
- Security vulnerabilities
- Performance issues that cause noticeable user-facing degradation
- Type safety violations that hide real runtime errors
- Framework misuse that breaks expected behavior or causes subtle bugs

## Next.js App Router

ALWAYS flag:
- \`useState\`, \`useEffect\`, \`useRef\`, \`useContext\`, or any other React hook used inside a Server Component (a file in \`app/\` without \`"use client"\` at the top). This causes a build error.
- \`"use client"\` directive placed after import statements. It must be the very first line of the file (before any imports) or Next.js ignores it and the component silently becomes a Server Component.
- Accessing \`cookies()\`, \`headers()\`, \`searchParams\`, or dynamic route \`params\` synchronously in Next.js 15+. These are now async — must \`await cookies()\`, \`await headers()\`, \`const { id } = await params\`, etc. Calling them without \`await\` returns a Promise, not the value.
- Any env var using the \`NEXT_PUBLIC_\` prefix that contains a secret (API keys, database URLs, service passwords, signing secrets). \`NEXT_PUBLIC_\` vars are inlined into the client bundle at build time and visible to every browser. Secrets must use server-only env vars (no prefix) and only be accessed in Server Components, Route Handlers, or Server Actions.
- Data fetching (e.g. database calls, \`fetch\` with auth headers) done inside a Client Component (\`"use client"\`) that could safely be done in a Server Component. This exposes credentials to the client bundle and creates unnecessary round trips.
- Missing \`loading.tsx\` or \`<Suspense>\` boundary around an async Server Component that does data fetching. Without it, the entire page blocks on the slowest data fetch.
- Server Action (\`"use server"\`) declared inside a Client Component file instead of a separate server-only file. This leaks the module graph and can expose server-only code paths.
- Using \`router.push()\` for redirects that should use \`redirect()\` from \`next/navigation\` in Server Components or Route Handlers. \`router.push\` requires a client context; misuse causes "invariant: attempted to hard navigate to the same URL" errors.
- \`fetch()\` calls inside Server Components that cache indefinitely when the data is dynamic — should use \`{ cache: "no-store" }\` or \`{ next: { revalidate: N } }\`.
- Passing non-serializable values (functions, class instances, Date objects) as props from a Server Component to a Client Component. Only plain JSON-serializable values can cross the server/client boundary.

## React Hooks

ALWAYS flag:
- Hook called inside a conditional, loop, nested function, or after an early \`return\`. This violates the Rules of Hooks and causes "Rendered more hooks than previous render" crashes.
- \`useEffect\` with a missing dependency — a value used inside the effect that isn't in the dependency array. This creates a stale closure: the effect captures an old value and never re-runs when it changes, causing subtle bugs.
- \`useEffect\` that calls \`setState\` unconditionally without a guard condition or with an empty dependency array (\`[]\`) but depends on a value that changes (triggers an infinite re-render loop or a React warning).
- Missing cleanup in \`useEffect\` for subscriptions, event listeners, timers, or WebSocket connections. Without cleanup, the handler fires after the component unmounts, causing "Can't perform a React state update on an unmounted component" errors and memory leaks.
- \`useState\` initialized with a prop value that the component doesn't synchronize on prop change (derived state anti-pattern). \`const [name, setName] = useState(props.name)\` — if \`props.name\` changes, \`name\` doesn't update.
- Missing \`key\` prop in \`Array.map()\` rendering JSX, or using array index as \`key\` when items can be reordered, filtered, or deleted. Index keys cause React to reuse the wrong DOM nodes and corrupt component state.
- \`useMemo\` or \`useCallback\` with \`[]\` as dependencies but referencing values that change — the memoized value becomes permanently stale.
- \`useEffect\` used to sync two pieces of state (e.g. setting state B whenever state A changes). Almost always a sign the component has derived state that should be computed during render.

## TypeScript Safety

ALWAYS flag:
- \`as any\` or \`as unknown as T\` used to silence a type error that is a real bug — bypasses the type checker for the rest of the expression chain.
- Non-null assertion \`!\` on a value that can legitimately be \`null\` or \`undefined\` at runtime (e.g. \`document.getElementById("foo")!\`, \`user.profile!.avatar\` where profile is optional). Crashes with "Cannot read properties of undefined".
- \`JSON.parse()\` result used directly without type narrowing or a \`zod\`/\`superstruct\` parse — returns \`any\` and hides schema mismatches at runtime.
- \`catch (e)\` block accessing \`e.message\` or \`e.stack\` without first narrowing: \`if (e instanceof Error)\`. In TypeScript's \`useUnknownInCatchVariables\` mode (enabled by \`strict\`) the caught value is \`unknown\`, not \`Error\`.
- \`async\` function return type annotated as \`Promise<void>\` when callers discard the promise — unhandled rejection silently swallows errors. Flag \`const result = someAsyncFn()\` without \`await\` or \`.catch()\`.
- Spreading \`...req.body\` directly into a database write (e.g. \`db.user.update({ data: { ...req.body } })\`) — mass assignment vulnerability. Explicit allow-lists should be used.
- Type assertion on parsed user input: \`req.body as UserSchema\` — doesn't validate, only lies to the compiler.

## Node.js / Express

ALWAYS flag:
- \`async\` route handler without a \`try/catch\` block and no global async error middleware. In Express 4.x, an unhandled rejection in an async handler crashes the process. Even in Express 5, the error boundary should be explicit.
- Missing \`await\` on a Prisma call, database query, or file write inside a route handler. The operation runs but the handler returns before it completes — writes may be lost, reads return stale data.
- Sequential \`await\` calls that are independent and could run in parallel with \`Promise.all()\`. This adds latency equal to the sum of all calls instead of the slowest one.
- String-interpolated SQL: \`db.query(\`SELECT * FROM users WHERE id = \${req.params.id}\`)\` — SQL injection. Always use parameterized queries or an ORM's safe query builder.
- Synchronous file I/O (\`fs.readFileSync\`, \`JSON.parse(fs.readFileSync(...))\`) inside a request handler — blocks the Node.js event loop and stalls all other in-flight requests.
- \`process.env.SOME_VAR\` used without a null check or startup validation. If the env var is missing in production the server silently uses \`undefined\`, causing cryptic downstream errors.
- Returning full database records including sensitive fields (passwords, tokens, internal IDs) in API responses. Always select or exclude specific fields.
- Prisma \`findUnique()\` or \`findFirst()\` result used without a \`null\` check before accessing properties — throws "Cannot read properties of null" when the record doesn't exist.
- \`res.json()\` called after \`res.json()\` or \`res.send()\` in the same request — "Cannot set headers after they are sent to the client" error. Usually from missing \`return\` before early responses.

## Security

ALWAYS flag:
- \`dangerouslySetInnerHTML={{ __html: userContent }}\` where \`userContent\` comes from user input or an external source without sanitization (e.g. DOMPurify). Direct XSS vector.
- Template literals building HTML strings with user input: \`\`<div>\${userInput}</div>\`\` injected into the DOM — XSS.
- \`eval(userInput)\` or \`new Function(userInput)\` — remote code execution.
- Storing auth tokens, JWTs, or API keys in \`localStorage\` or \`sessionStorage\` — accessible to any XSS attack. Use \`HttpOnly\` cookies instead.
- \`cors({ origin: "*" })\` on routes that check authentication or authorization — allows any site to make credentialed cross-origin requests, defeating CORS protection.
- Path traversal: \`path.join(baseDir, req.query.file)\` or similar without validating the resolved path starts with \`baseDir\`. Attacker can escape to \`../../etc/passwd\`.
- Comparing user-supplied secrets with \`===\` — timing side-channel. Use \`crypto.timingSafeEqual()\`.
- Rate-limiting or authentication skipped on password reset, OTP, or login endpoints — brute-force vector.
- \`child_process.exec()\` or \`execSync()\` with any user-controlled input — command injection.

## Output Format

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences outside the JSON.

Each element:
{
  "line": <integer — the exact line number in the NEW version of the file where the issue appears>,
  "body": "<one-sentence description of the bug/issue, one sentence explaining why it matters, and a concrete fix or code snippet>"
}

Rules:
- Only cite lines that appear as additions (prefixed with \`+\`) or context lines in the diff. Never cite a deleted line (prefixed with \`-\`).
- If a file has no real issues, return \`[]\` for it.
- Maximum 5 comments per file — prioritize the highest-severity issues.
- Do not invent issues. Only flag what is clearly present in the diff.`;

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
  const annotated = annotatePatchWithLineNumbers(file.patch);

  const userMessage = `Repository: ${repoName}
PR title: ${prTitle}

Review the following changed file for bugs, security issues, and framework misuse. Only flag issues on lines present in this diff.

File: ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})

\`\`\`diff
${annotated}
\`\`\`

Respond ONLY with a JSON array in the format specified. Use the [L<number>] annotations to find the correct line numbers for the new file. If no issues, respond with: []`;

  const text = await callLLM(SYSTEM_PROMPT, userMessage);
  return parseComments(file.filename, text);
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
