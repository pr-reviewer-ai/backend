import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "../db/client.js";

const router = Router();

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
  if (!exists) return; // installation not yet in DB; /app/callback will sync repos on user login

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

  console.log(`[webhook] PR #${pull_request.number} ${action} on ${repository.full_name}`);
  // TODO: queue AI review job
}

export default router;
