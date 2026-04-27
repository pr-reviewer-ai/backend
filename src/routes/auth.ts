import { Router } from "express";
import { Octokit } from "@octokit/rest";
import { db } from "../db/client.js";
import { encrypt } from "../lib/crypto.js";
import { signToken, verifyToken } from "../lib/jwt.js";

const router = Router();

router.get("/github", (_req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: process.env.GITHUB_CALLBACK_URL!,
    scope: "read:user user:email",
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get("/github/callback", async (req, res) => {
  const { code } = req.query as { code?: string };
  if (!code) { res.status(400).json({ error: "Missing code" }); return; }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: process.env.GITHUB_CALLBACK_URL,
    }),
  });

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    res.status(401).json({ error: tokenData.error || "OAuth failed" });
    return;
  }

  const octokit = new Octokit({ auth: tokenData.access_token });
  const { data: ghUser } = await octokit.users.getAuthenticated();
  const emailsRes = await octokit.users.listEmailsForAuthenticatedUser();
  const primaryEmail = emailsRes.data.find((e) => e.primary)?.email ?? null;

  await db.user.upsert({
    where: { id: ghUser.node_id },
    create: {
      id: ghUser.node_id,
      githubId: ghUser.id,
      login: ghUser.login,
      email: primaryEmail,
      avatarUrl: ghUser.avatar_url,
      accessToken: encrypt(tokenData.access_token),
    },
    update: {
      login: ghUser.login,
      email: primaryEmail,
      avatarUrl: ghUser.avatar_url,
      accessToken: encrypt(tokenData.access_token),
    },
  });

  const token = signToken({ userId: ghUser.node_id, login: ghUser.login });
  // Use secure cross-site cookies whenever the frontend is served over HTTPS
  // (covers both production and local-to-tunnel dev scenarios)
  const crossOrigin = (process.env.FRONTEND_URL || "").startsWith("https://");
  res.cookie("token", token, {
    httpOnly: true,
    secure: crossOrigin,
    sameSite: crossOrigin ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
});

router.post("/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", async (req, res) => {
  const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const payload = verifyToken(token);
    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, login: true, email: true, avatarUrl: true, planTier: true },
    });
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json(user);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
