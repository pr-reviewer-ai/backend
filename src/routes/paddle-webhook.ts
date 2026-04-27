import { Router } from "express";
import { db } from "../db/client.js";
import crypto from "crypto";

const router = Router();

const PRICE_PLAN_MAP: Record<string, string> = {
  [process.env.PADDLE_PRICE_FOUNDING_SOLO ?? "___"]: "founding_solo",
  [process.env.PADDLE_PRICE_SOLO_MONTHLY ?? "___"]: "solo",
  [process.env.PADDLE_PRICE_SOLO_ANNUAL ?? "___"]: "solo",
  [process.env.PADDLE_PRICE_DUO_MONTHLY ?? "___"]: "duo",
  [process.env.PADDLE_PRICE_DUO_ANNUAL ?? "___"]: "duo",
  [process.env.PADDLE_PRICE_SMALL_TEAM_MONTHLY ?? "___"]: "small_team",
  [process.env.PADDLE_PRICE_SMALL_TEAM_ANNUAL ?? "___"]: "small_team",
  [process.env.PADDLE_PRICE_STUDIO_MONTHLY ?? "___"]: "studio",
  [process.env.PADDLE_PRICE_STUDIO_ANNUAL ?? "___"]: "studio",
};

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  try {
    const parts = Object.fromEntries(
      signature.split(";").map((p) => p.split("=") as [string, string])
    );
    const ts = parts["ts"];
    const h1 = parts["h1"];
    if (!ts || !h1) return false;
    const payload = `${ts}:${rawBody.toString("utf8")}`;
    const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(h1, "hex"));
  } catch {
    return false;
  }
}

router.post("/", async (req, res) => {
  const sig = req.headers["paddle-signature"] as string | undefined;
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!secret || !sig || !verifySignature((req as any).rawBody, sig, secret)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { event_type, data } = req.body as {
    event_type: string;
    data: Record<string, any>;
  };

  try {
    if (event_type === "subscription.created" || event_type === "subscription.updated") {
      const userId = data.custom_data?.userId as string | undefined;
      if (!userId) { res.json({ ok: true }); return; }

      const priceId = data.items?.[0]?.price?.id as string | undefined;
      const planTier = (priceId && PRICE_PLAN_MAP[priceId]) || "solo";

      // If a cancel is scheduled but not yet effective, Paddle still reports
      // status as "active" — use "cancelling" so the UI reflects reality.
      const hasScheduledCancel = data.scheduled_change?.action === "cancel";
      const effectiveStatus = hasScheduledCancel ? "cancelling" : (data.status ?? null);

      await db.user.update({
        where: { id: userId },
        data: {
          planTier: planTier as any,
          paddleCustomerId: data.customer_id ?? null,
          paddleSubscriptionId: data.id ?? null,
          subscriptionStatus: effectiveStatus,
          subscriptionEndsAt: data.current_billing_period?.ends_at
            ? new Date(data.current_billing_period.ends_at)
            : null,
          billingPeriod: data.billing_cycle?.interval ?? null,
        },
      });
    }

    if (event_type === "subscription.cancelled") {
      const userId = data.custom_data?.userId as string | undefined;
      if (!userId) { res.json({ ok: true }); return; }

      await db.user.update({
        where: { id: userId },
        data: {
          planTier: "free",
          subscriptionStatus: "cancelled",
          subscriptionEndsAt: data.scheduled_change?.effective_at
            ? new Date(data.scheduled_change.effective_at)
            : null,
        },
      });
    }

    if (event_type === "subscription.past_due") {
      const userId = data.custom_data?.userId as string | undefined;
      if (userId) {
        await db.user.update({
          where: { id: userId },
          data: { subscriptionStatus: "past_due" },
        });
      }
    }
  } catch (err) {
    console.error("Paddle webhook error:", err);
    res.status(500).json({ error: "Internal error" });
    return;
  }

  res.json({ ok: true });
});

export default router;
