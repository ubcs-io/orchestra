/**
 * GitHub glue for the task review flow: resolving which repo/token to push
 * against, and opening a pull request once the branch is up. Deliberately
 * uses plain `fetch` rather than an SDK — a handful of REST calls don't
 * justify a new dependency in this codebase's otherwise minimal footprint.
 */

import { getConfig } from "./config.js";
import { remoteUrl } from "./git.js";
import type { ProjectRow } from "./db.js";

/** Project-level token wins over the shared env fallback — different projects
 *  plausibly point at different GitHub orgs/accounts, unlike the single shared
 *  LLM endpoint the model-connection env-override exists for. */
export function resolveGithubToken(project: ProjectRow): string | undefined {
  return project.github_token || getConfig().githubToken || undefined;
}

export function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Prefer an explicit `owner/repo` override on the project; else derive it
 *  from the repo's "origin" remote. */
export function resolveOwnerRepo(project: ProjectRow, repoPath: string): { owner: string; repo: string } {
  if (project.github_repo) {
    const [owner, repo] = project.github_repo.split("/");
    if (owner && repo) return { owner, repo };
  }
  const remote = remoteUrl(repoPath, "origin");
  const parsed = remote && parseOwnerRepo(remote);
  if (!parsed) {
    throw new Error(
      'could not determine the GitHub owner/repo — set it explicitly in project settings (no "origin" remote, or it isn\'t a github.com URL)',
    );
  }
  return parsed;
}

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export async function createPullRequest(input: CreatePullRequestInput): Promise<{ url: string; number: number }> {
  const res = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { message?: string; errors?: unknown };
    const detailText = JSON.stringify(detail);
    const baseMissing = detailText.includes(input.base) && detailText.includes("not found");
    throw new Error(
      baseMissing
        ? `GitHub rejected the PR — base branch "${input.base}" may not exist on the remote yet (push it first)`
        : `GitHub PR creation failed (${res.status}): ${detail.message ?? res.statusText}`,
    );
  }
  const json = (await res.json()) as { html_url: string; number: number };
  return { url: json.html_url, number: json.number };
}
