import { getInstallationRestClient } from "./github-app.js";
import type { ReviewComment } from "./ai-reviewer.js";

export async function postProcessingComment(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  try {
    const octokit = await getInstallationRestClient(installationId);
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: "<!-- mergecheck-processing -->\n> 🔍 **Mergecheck** is reviewing your pull request…",
    });
    return data.id;
  } catch (err) {
    console.warn("[review-poster] Failed to post processing comment:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function deleteProcessingComment(
  installationId: number,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  try {
    const octokit = await getInstallationRestClient(installationId);
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId });
  } catch (err) {
    console.warn("[review-poster] Failed to delete processing comment:", err instanceof Error ? err.message : err);
  }
}

export async function postPRReview(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  comments: ReviewComment[]
): Promise<number | null> {
  const octokit = await getInstallationRestClient(installationId);

  if (comments.length === 0) {
    const { data } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: "COMMENT",
      body: "**AI Code Review** — No issues found. Looks good! ✓",
    });
    return data.id as number;
  }

  const inlineComments = comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT" as const,
    body: c.body,
  }));

  const summaryBody =
    comments.length === 1
      ? "**AI Code Review** — 1 issue found."
      : `**AI Code Review** — ${comments.length} issues found.`;

  try {
    const { data } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: "COMMENT",
      body: summaryBody,
      comments: inlineComments,
    });
    return data.id as number;
  } catch (err: unknown) {
    // Fall back to a top-level review body when inline line numbers are invalid
    console.warn(
      "[review-poster] Inline review failed, falling back to body-only review:",
      err instanceof Error ? err.message : err
    );

    const fallbackBody = buildFallbackBody(comments);
    const { data } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: "COMMENT",
      body: fallbackBody,
    });
    return data.id as number;
  }
}

function buildFallbackBody(comments: ReviewComment[]): string {
  const lines = [`**AI Code Review** — ${comments.length} issue(s) found:\n`];
  for (const c of comments) {
    lines.push(`**\`${c.path}\` line ${c.line}**\n${c.body}\n`);
  }
  return lines.join("\n");
}
