import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "../db/client.js";
import { fetchPRDiff } from "../lib/pr-fetcher.js";
import { reviewPRFiles } from "../lib/ai-reviewer.js";
import { postPRReview } from "../lib/review-poster.js";

const router = Router();

const PR_LIMITS: Record<string, number> = {
  free: 5,
  founding_solo: 30,
  solo: 30,
  duo: 80,
  small_team: 200,
  studio: 600,
};

function verifySignature(secret: string, payload: Buffer, sig: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

router.post("/", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const sig = req.headers["x-hub-signature-256"] as string;
  const event = req.headers["x-github-event"] as string;

  if (!sig || !event) { res.status(400).json({ error: "Missing headers" }); return; }

  const rawBody: Buffer = (req as any).rawBody;
  if (!verifySignature(process.env.GITHUB_WEBHOOK_SECRET!, rawBody, sig)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body;

  try {
    switch (event) {
      case "installation": await handleInstallation(payload); break;
      case "installation_repositories": await handleInstallationRepos(payload); break;
      case "pull_request": await handlePullRequest(payload); break;
    }
  } catch (err) {
    console.error(`Webhook error [${event}]:`, err);
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.json({ ok: true });
});

async function handleInstallation(payload: any) {
  const { action, installation } = payload;
  if (action === "deleted") {
    await db.installation.delete({ where: { id: installation.id } }).catch(() => null);
  } else if (action === "suspend" || action === "unsuspend") {
    await db.installation.update({
      where: { id: installation.id },
      data: { suspended: action === "suspend" },
    }).catch(() => null);
  }
}

async function handleInstallationRepos(payload: any) {
  const { action, installation, repositories_added, repositories_removed } = payload;

  const exists = await db.installation.findUnique({ where: { id: installation.id }, select: { id: true } });
  if (!exists) return;

  if (action === "added" && repositories_added) {
    for (const repo of repositories_added) {
      await db.repository.upsert({
        where: { id: repo.id },
        create: { id: repo.id, installationId: installation.id, fullName: repo.full_name, private: repo.private, active: true },
        update: { active: true, fullName: repo.full_name },
      });
    }
  }

  if (action === "removed" && repositories_removed) {
    for (const repo of repositories_removed) {
      await db.repository.update({
        where: { id: repo.id },
        data: { active: false },
      }).catch(() => null);
    }
  }
}

async function handlePullRequest(payload: any) {
  const { action, pull_request, repository, installation } = payload;
  if (action !== "opened" && action !== "synchronize" && action !== "reopened") return;

  const prNumber: number = pull_request.number;
  const repoId: number = repository.id;
  const commitSha: string = pull_request.head.sha;
  const [owner, repo] = (repository.full_name as string).split("/");

  console.log(`[webhook] PR #${prNumber} ${action} on ${repository.full_name} @ ${commitSha.slice(0, 7)}`);

  // Load installation + owner user
  const installRecord = await db.installation.findUnique({
    where: { id: installation.id },
    include: { user: { select: { id: true, login: true, planTier: true, prUsedThisMonth: true } } },
  });
  if (!installRecord || installRecord.suspended) return;

  // Check repo is active
  const repoRecord = await db.repository.findUnique({
    where: { id: repoId },
    select: { active: true },
  });
  if (!repoRecord?.active) return;

  // Enforce per-plan PR quota
  const user = installRecord.user;
  const limit = PR_LIMITS[user.planTier] ?? 0;
  if (user.prUsedThisMonth >= limit) {
    console.log(`[webhook] Quota reached for ${user.login}: ${user.prUsedThisMonth}/${limit}`);
    return;
  }

  // Idempotency — skip if we already reviewed this exact commit.
  // For "reopened" we intentionally bypass this check: the head SHA
  // is unchanged from the last open/close cycle, so the record already
  // exists but the PR deserves a fresh review.
  if (action !== "reopened") {
    const existing = await db.prReview.findUnique({
      where: { repositoryId_prNumber_commitSha: { repositoryId: repoId, prNumber, commitSha } },
    });
    if (existing) {
      console.log(`[webhook] Already reviewed PR #${prNumber} @ ${commitSha.slice(0, 7)}, skipping`);
      return;
    }
  }

  const reviewRecord = await db.prReview.upsert({
    where: { repositoryId_prNumber_commitSha: { repositoryId: repoId, prNumber, commitSha } },
    create: { repositoryId: repoId, prNumber, commitSha, status: "processing" },
    update: { status: "processing", reviewId: null },
  });

  try {
    const diff = await fetchPRDiff(installation.id, owner, repo, prNumber);

    if (diff.files.length === 0) {
      await db.prReview.update({ where: { id: reviewRecord.id }, data: { status: "completed" } });
      return;
    }

    const comments = await reviewPRFiles(diff.files, diff.prTitle, repository.full_name);

    const reviewId = await postPRReview(
      installation.id, owner, repo, prNumber, commitSha, comments
    );

    await Promise.all([
      db.prReview.update({
        where: { id: reviewRecord.id },
        data: { status: "completed", reviewId },
      }),
      db.user.update({
        where: { id: user.id },
        data: { prUsedThisMonth: { increment: 1 } },
      }),
    ]);

    console.log(
      `[webhook] Review posted for PR #${prNumber} — ${comments.length} comment(s), reviewId=${reviewId}`
    );
  } catch (err) {
    console.error(`[webhook] Review failed for PR #${prNumber} on ${repository.full_name}:`, err);
    await db.prReview.update({
      where: { id: reviewRecord.id },
      data: { status: "failed" },
    }).catch(() => null);
  }
}

export default router;
