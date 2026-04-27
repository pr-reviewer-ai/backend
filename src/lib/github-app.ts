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
