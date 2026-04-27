import { Router } from "express";
import { db } from "../db/client.js";
import { requireAuth } from "../middleware/auth.js";
import { Octokit } from "@octokit/rest";
import { appOctokit, getInstallationToken } from "../lib/github-app.js";
import { encrypt } from "../lib/crypto.js";

const router = Router();

// GitHub redirects here after app installation
router.get("/callback", requireAuth, async (req, res) => {
  const { installation_id, setup_action } = req.query as {
    installation_id?: string;
    setup_action?: string;
  };

  if (!installation_id || setup_action !== "install") {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
    return;
  }

  const installId = parseInt(installation_id, 10);

  const { data: install } = await appOctokit.apps.getInstallation({ installation_id: installId });
  const { token, expiresAt } = await getInstallationToken(installId);

  await db.installation.upsert({
    where: { id: installId },
    create: {
      id: installId,
      userId: req.user!.userId,
      accountLogin: (install.account as any)?.login ?? "",
      accountType: (install.account as any)?.type ?? "User",
      accountAvatarUrl: install.account?.avatar_url ?? null,
      accessToken: encrypt(token),
      tokenExpiresAt: expiresAt,
    },
    update: {
      userId: req.user!.userId,
      accessToken: encrypt(token),
      tokenExpiresAt: expiresAt,
      suspended: false,
    },
  });

  // Sync repos
  const installOctokit = new Octokit({ auth: token });
  const { data: reposData } = await installOctokit.apps.listReposAccessibleToInstallation({ per_page: 100 });
  for (const repo of reposData.repositories) {
    await db.repository.upsert({
      where: { id: repo.id },
      create: {
        id: repo.id,
        installationId: installId,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        active: true,
      },
      update: { fullName: repo.full_name, active: true },
    });
  }

  res.redirect(`${process.env.FRONTEND_URL}/dashboard?installed=1`);
});

// List installations for the current user
router.get("/", requireAuth, async (req, res) => {
  const installs = await db.installation.findMany({
    where: { userId: req.user!.userId },
    include: { repositories: true },
  });
  res.json(installs.map(({ accessToken, ...rest }) => rest));
});

// Refresh an installation token
router.post("/:id/refresh-token", requireAuth, async (req, res) => {
  const installId = parseInt(req.params["id"] as string, 10);
  const install = await db.installation.findUnique({ where: { id: installId } });

  if (!install || install.userId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { token, expiresAt } = await getInstallationToken(installId);
  await db.installation.update({
    where: { id: installId },
    data: { accessToken: encrypt(token), tokenExpiresAt: expiresAt },
  });

  res.json({ expiresAt });
});

export default router;
