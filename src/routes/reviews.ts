import { Router } from "express";
import { db } from "../db/client.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// GET /reviews?page=1&limit=20
// Returns paginated PR review history for all repos belonging to the current user's installations
router.get("/", requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt((req.query["limit"] as string) ?? "20", 10)));
  const skip = (page - 1) * limit;

  const installs = await db.installation.findMany({
    where: { userId: req.user!.userId },
    select: { id: true },
  });

  const installIds = installs.map((i) => i.id);

  const [reviews, total] = await Promise.all([
    db.prReview.findMany({
      where: { repository: { installationId: { in: installIds } } },
      include: { repository: { select: { fullName: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.prReview.count({
      where: { repository: { installationId: { in: installIds } } },
    }),
  ]);

  res.json({
    reviews: reviews.map((r) => ({
      id: r.id,
      repoFullName: r.repository.fullName,
      prNumber: Number(r.prNumber),
      commitSha: r.commitSha.slice(0, 7),
      status: r.status,
      reviewId: r.reviewId != null ? Number(r.reviewId) : null,
      createdAt: r.createdAt,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

export default router;
