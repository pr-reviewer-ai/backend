import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import authRouter from "./routes/auth.js";
import installRouter from "./routes/app-install.js";
import webhookRouter from "./routes/webhook.js";

const app = express();
const PORT = process.env.PORT || 3001;

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.json({}));

app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(cookieParser());

// Capture raw body for webhook signature verification before JSON parsing
app.use((req, _res, next) => {
  if (req.path === "/webhooks/github") {
    let data: Buffer[] = [];
    req.on("data", (chunk) => data.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(data);
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
app.use("/webhooks/github", webhookRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
