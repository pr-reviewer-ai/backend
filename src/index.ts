import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import cron from "node-cron";

import authRouter from "./routes/auth.js";
import installRouter from "./routes/app-install.js";
import webhookRouter from "./routes/webhook.js";
import billingRouter from "./routes/billing.js";
import paddleWebhookRouter from "./routes/paddle-webhook.js";
import reviewsRouter from "./routes/reviews.js";
import { db } from "./db/client.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.json({}));

app.use(helmet());
app.use(
  cors({
    origin: ["http://localhost:3000", "https://connect-theme-tomorrow-officially.trycloudflare.com"],
    credentials: true,
  })
);
app.use(cookieParser());

// Capture raw body for routes that need webhook signature verification
const RAW_BODY_PATHS = ["/webhooks/github", "/webhooks/paddle"];

app.use((req, _res, next) => {
  if (RAW_BODY_PATHS.some((p) => req.path === p)) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      (req as any).rawBody = raw;
      try { req.body = JSON.parse(raw.toString("utf8")); } catch { req.body = {}; }
      next();
    });
  } else {
    express.json()(req, _res, next);
  }
});

app.use("/auth", authRouter);
app.use("/app", installRouter);
app.use("/billing", billingRouter);
app.use("/reviews", reviewsRouter);
app.use("/webhooks/github", webhookRouter);
app.use("/webhooks/paddle", paddleWebhookRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

function addBillingPeriod(date: Date, period: string): Date {
  const d = new Date(date);
  if (period === "year") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// Daily at midnight: reset PR counters per billing cycle
cron.schedule("0 0 * * *", async () => {
  const now = new Date();
  console.log("[cron] Checking billing cycle resets");

  // Paid users: reset when their billing cycle has rolled over
  const paidUsers = await db.user.findMany({
    where: { billingCycleStart: { not: null }, billingPeriod: { not: null } },
    select: { id: true, login: true, billingCycleStart: true, billingPeriod: true },
  });

  for (const u of paidUsers) {
    if (!u.billingCycleStart || !u.billingPeriod) continue;
    const cycleEnd = addBillingPeriod(u.billingCycleStart, u.billingPeriod);
    if (now >= cycleEnd) {
      let newCycleStart = u.billingCycleStart;
      while (addBillingPeriod(newCycleStart, u.billingPeriod) <= now) {
        newCycleStart = addBillingPeriod(newCycleStart, u.billingPeriod);
      }
      await db.user.update({
        where: { id: u.id },
        data: { prUsedThisMonth: 0, billingCycleStart: newCycleStart },
      });
      console.log(`[cron] Reset counter for ${u.login} (new cycle start: ${newCycleStart.toISOString()})`);
    }
  }

  // Free users (no billing cycle): reset on the 1st of each calendar month
  if (now.getDate() === 1) {
    await db.user.updateMany({
      where: { planTier: "free", billingCycleStart: null },
      data: { prUsedThisMonth: 0 },
    });
    console.log("[cron] Reset counters for free users (calendar month)");
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
