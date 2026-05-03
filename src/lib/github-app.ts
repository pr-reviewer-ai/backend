import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

export const appOctokit: InstanceType<typeof Octokit> = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  },
});

export const githubApp = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  webhooks: {
    secret: process.env.GITHUB_WEBHOOK_SECRET!,
  },
  oauth: {
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  },
});

export async function getInstallationToken(installationId: number) {
  const octokit = await githubApp.getInstallationOctokit(installationId);
  // @ts-ignore — internal token access
  const auth = await octokit.auth({ type: "installation" }) as any;
  return { token: auth.token as string, expiresAt: new Date(auth.expiresAt) };
}

// Returns an @octokit/rest Octokit authenticated as the installation.
// githubApp.getInstallationOctokit() returns an internal Octokit type that
// doesn't expose .rest — this helper gives a standard Octokit that does.
export async function getInstallationRestClient(installationId: number): Promise<InstanceType<typeof Octokit>> {
  const { token } = await getInstallationToken(installationId);
  return new Octokit({ auth: token });
}

// Retries fn on transient socket/network errors (e.g. "other side closed", ECONNRESET).
// HTTP 4xx/5xx are not retried — those are deterministic API errors.
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 300 }: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        /other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(msg);
      if (!isTransient || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}
