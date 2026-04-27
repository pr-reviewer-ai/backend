import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import authRouter from "./routes/auth.js";
import installRouter from "./routes/app-install.js";
import webhookRouter from "./routes/webhook.js";
import billingRouter from "./routes/billing.js";
import paddleWebhookRouter from "./routes/paddle-webhook.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.json({}));

app.use(helmet());
app.use(
  cors({
    origin: ["http://localhost:3000", "https://diary-linda-penn-faqs.trycloudflare.com"],
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
app.use("/webhooks/github", webhookRouter);
app.use("/webhooks/paddle", paddleWebhookRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
