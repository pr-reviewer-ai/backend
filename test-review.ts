/**
 * Manual smoke test for the AI review engine.
 * Run: npx tsx test-review.ts
 *
 * Each fixture is a real-world diff that should trigger at least one comment.
 * A passing run means: LLM responds, JSON parses, line numbers are valid integers.
 */

import "dotenv/config";
import { reviewPRFiles } from "./src/lib/ai-reviewer.js";
import type { FileDiff } from "./src/lib/pr-fetcher.js";

const provider = process.env.LLM_PROVIDER ?? "anthropic";
const model =
  provider === "openai"
    ? (process.env.OPENAI_MODEL ?? "gpt-4o")
    : provider === "gemini"
    ? (process.env.GEMINI_MODEL ?? "gemini-2.0-flash")
    : (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6");

console.log(`\nProvider : ${provider}`);
console.log(`Model    : ${model}`);
console.log("─".repeat(60));

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Each fixture intentionally contains at least one real issue so the model has
// something to find. A result with 0 comments is flagged as suspicious.

const fixtures: Array<{ label: string; file: FileDiff }> = [
  {
    label: "NEXT_PUBLIC_ secret + missing 'use client'",
    file: {
      filename: "app/dashboard/page.tsx",
      status: "modified",
      additions: 8,
      deletions: 1,
      patch: `@@ -1,5 +1,12 @@
 import React from 'react';
+import { useState, useEffect } from 'react';
+
+// stripe key exposed to the browser
+const stripeKey = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;
+
 export default function DashboardPage() {
+  const [data, setData] = useState(null);
+  useEffect(() => { fetch('/api/data').then(r => r.json()).then(setData); }, []);
   return <div>Dashboard</div>;
 }`,
    },
  },
  {
    label: "useEffect missing dependency + no cleanup",
    file: {
      filename: "components/UserCard.tsx",
      status: "added",
      additions: 18,
      deletions: 0,
      patch: `@@ -0,0 +1,18 @@
+import React, { useState, useEffect } from 'react';
+
+export function UserCard({ userId }: { userId: string }) {
+  const [user, setUser] = useState(null);
+
+  useEffect(() => {
+    const interval = setInterval(() => {
+      fetch(\`/api/users/\${userId}\`)
+        .then(r => r.json())
+        .then(setUser);
+    }, 3000);
+    // no clearInterval — memory leak
+  }, []); // userId missing from deps
+
+  if (!user) return null;
+  return <div>{(user as any).name}</div>;
+}`,
    },
  },
  {
    label: "Express async handler without try/catch + missing await",
    file: {
      filename: "src/routes/orders.ts",
      status: "added",
      additions: 14,
      deletions: 0,
      patch: `@@ -0,0 +1,14 @@
+import { Router } from 'express';
+import { db } from '../db/client.js';
+
+const router = Router();
+
+router.post('/', async (req, res) => {
+  const order = db.order.create({
+    data: { ...req.body, userId: req.user.id },
+  });
+  res.json(order);
+});
+
+export default router;`,
    },
  },
  {
    label: "TypeScript non-null assertion + JSON.parse any",
    file: {
      filename: "lib/config.ts",
      status: "modified",
      additions: 7,
      deletions: 2,
      patch: `@@ -1,6 +1,11 @@
 import fs from 'fs';

-export function loadConfig() {
-  return {};
+export function loadConfig() {
+  const raw = fs.readFileSync('./config.json', 'utf8');
+  const cfg = JSON.parse(raw);
+  const port = cfg.server!.port;
+  const secret = process.env.JWT_SECRET!;
+  return { port, secret };
 }`,
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

let totalComments = 0;
let passed = 0;
let suspicious = 0;

for (const { label, file } of fixtures) {
  process.stdout.write(`\n[${label}]\n`);

  const start = Date.now();
  try {
    const comments = await reviewPRFiles([file], "test PR", "owner/test-repo");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (comments.length === 0) {
      console.log(`  ⚠  No comments returned (${elapsed}s) — check system prompt or model`);
      suspicious++;
    } else {
      passed++;
      totalComments += comments.length;
      for (const c of comments) {
        console.log(`  L${c.line}  ${c.body.slice(0, 120)}${c.body.length > 120 ? "…" : ""}`);
      }
      console.log(`  ✓  ${comments.length} comment(s) in ${elapsed}s`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗  ERROR: ${msg}`);
    suspicious++;
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(60));
console.log(`Fixtures  : ${fixtures.length}`);
console.log(`With hits : ${passed}  (${suspicious} suspicious)`);
console.log(`Comments  : ${totalComments}`);

if (suspicious > 0) {
  console.log("\n⚠  Some fixtures returned no comments. Possible causes:");
  console.log("   • Wrong/missing API key for the active provider");
  console.log("   • Model hallucinated non-JSON output (check raw response)");
  console.log("   • Model disagreed — try a different fixture or a stricter prompt\n");
  process.exit(1);
} else {
  console.log("\n✓  All fixtures produced at least one comment\n");
}
