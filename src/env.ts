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
  /** 账号的身份。一个账号只能是求职者或招聘者，第一次登录时选定 */
  role: Role | null;
  scopes: Set<Scope>;
}

export interface Ctx {
  env: Env;
  db: D1Database;
  auth: Auth;
  origin: string;
}

export const ROLE_NAMES: Record<Role, string> = { candidate: "求职者", recruiter: "招聘者" };

/** 一组范围属于哪种身份。两种都有返回 "mixed"，一个都没有返回 null。 */
export function roleOfScopes(scopes: Scope[]): Role | "mixed" | null {
  const roles = (["candidate", "recruiter"] as Role[]).filter((role) => scopes.some((s) => s.startsWith(`${role}:`)));
  return roles.length > 1 ? "mixed" : (roles[0] ?? null);
}
