import type { Octokit } from "@octokit/rest";

// Files that add no value to review
const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /\.min\.(js|css)$/,
  /\.generated\.(ts|js|tsx|jsx)$/,
  /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|otf)$/,
  /\.(mp4|mp3|wav|ogg|pdf)$/,
  /^\.next\//,
  /^dist\//,
  /^build\//,
  /^out\//,
  /^node_modules\//,
  /^coverage\//,
  /^\.husky\//,
  /^storybook-static\//,
  /\/__snapshots__\//,
  /\.snap$/,
  /\.d\.ts$/,
  /^public\//,
];

// Diff above this threshold is likely auto-generated or a large reformat
const MAX_CHANGES_PER_FILE = 400;

export interface FileDiff {
  filename: string;
  status: "added" | "modified" | "renamed" | "removed" | "copied";
  patch: string;
  additions: number;
  deletions: number;
}

export interface PRDiff {
  files: FileDiff[];
  headSha: string;
  prTitle: string;
  prBody: string | null;
}

export async function fetchPRDiff(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRDiff> {

  const [{ data: pr }, { data: rawFiles }] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const files: FileDiff[] = (rawFiles as any[])
    .filter((f) => f.status !== "removed")
    .filter((f) => !!f.patch) // binary files lack a patch
    .filter((f) => !SKIP_PATTERNS.some((p) => p.test(f.filename)))
    .filter((f) => f.additions + f.deletions <= MAX_CHANGES_PER_FILE)
    .map((f) => ({
      filename: f.filename,
      status: f.status as FileDiff["status"],
      patch: f.patch as string,
      additions: f.additions as number,
      deletions: f.deletions as number,
    }));

  return {
    files,
    headSha: pr.head.sha,
    prTitle: pr.title,
    prBody: pr.body ?? null,
  };
}
