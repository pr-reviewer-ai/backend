import { Router } from "express";
import { db } from "../db/client.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const PADDLE_API =
  process.env.PADDLE_ENV === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";

router.get("/info", requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.user!.userId },
    select: {
      planTier: true,
      paddleSubscriptionId: true,
      subscriptionStatus: true,
      subscriptionEndsAt: true,
      billingPeriod: true,
      prUsedThisMonth: true,
    },
  });
  if (!user) { res.status(404).json({ error: "Not found" }); return; }
  res.json(user);
});

router.post("/resume", requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.user!.userId },
    select: { paddleSubscriptionId: true },
  });

  if (!user?.paddleSubscriptionId) {
    res.status(400).json({ error: "No active subscription" });
    return;
  }

  const r = await fetch(`${PADDLE_API}/subscriptions/${user.paddleSubscriptionId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scheduled_change: null }),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error("Paddle resume error:", r.status, err);
    res.status(502).json({ error: "Failed to resume subscription" });
    return;
  }

  await db.user.update({
    where: { id: req.user!.userId },
    data: { subscriptionStatus: "active" },
  });

  res.json({ ok: true });
});

router.post("/cancel", requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.user!.userId },
    select: { paddleSubscriptionId: true },
  });

  if (!user?.paddleSubscriptionId) {
    res.status(400).json({ error: "No active subscription" });
    return;
  }

  const r = await fetch(
    `${PADDLE_API}/subscriptions/${user.paddleSubscriptionId}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ effective_from: "next_billing_period" }),
    }
  );

  if (!r.ok) {
    res.status(502).json({ error: "Failed to cancel subscription with Paddle" });
    return;
  }

  await db.user.update({
    where: { id: req.user!.userId },
    data: { subscriptionStatus: "cancelling" },
  });

  res.json({ ok: true });
});

router.get("/portal-url", requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.user!.userId },
    select: { paddleCustomerId: true },
  });

  if (!user?.paddleCustomerId) {
    res.status(400).json({ error: "No Paddle customer" });
    return;
  }

  const r = await fetch(
    `${PADDLE_API}/customers/${user.paddleCustomerId}/portal-sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!r.ok) {
    const err = await r.text();
    console.error("Paddle portal-sessions error:", r.status, err);
    res.status(502).json({ error: "Failed to create portal session" });
    return;
  }

  const data = (await r.json()) as {
    data?: { urls?: { general?: { overview?: string } } };
  };
  const url = data.data?.urls?.general?.overview ?? null;

  res.json({ url });
});

export default router;
