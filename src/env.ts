export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** 只在本地和测试里设为 "1"，开启免 GitHub 的测试登录。 */
  DEV_LOGIN?: string;
  QUOTA_APPLY_PER_DAY?: string;
  QUOTA_INVITE_PER_JOB_PER_DAY?: string;
  QUOTA_SEARCH_PER_MIN?: string;
  QUOTA_POLL_PER_MIN?: string;
}

export const SCOPES = [
  "candidate:read",
  "candidate:write",
  "candidate:apply",
  "recruiter:read",
  "recruiter:write",
  "recruiter:invite",
] as const;
export type Scope = (typeof SCOPES)[number];
export type Role = "candidate" | "recruiter";

export const ROLE_SCOPES: Record<Role, Scope[]> = {
  candidate: ["candidate:read", "candidate:write", "candidate:apply"],
  recruiter: ["recruiter:read", "recruiter:write", "recruiter:invite"],
};

export interface Auth {
  accountId: string;
  login: string;
  scopes: Set<Scope>;
}

export interface Ctx {
  env: Env;
  db: D1Database;
  auth: Auth;
  origin: string;
}

export function hasRole(auth: Auth, role: Role): boolean {
  return ROLE_SCOPES[role].some((s) => auth.scopes.has(s));
}
