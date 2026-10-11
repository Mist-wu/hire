import { SCOPES, type Auth, type Scope } from "../env";
import { HireError } from "../errors";
import { isoAfter, newId, nowIso, parseJson, randomHex, sha256Hex } from "../util";

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 30 * 24 * 3600;

export function parseScopes(raw: unknown): Scope[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  return SCOPES.filter((s) => parts.includes(s));
}

export async function upsertAccount(db: D1Database, githubId: number, login: string): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO accounts (id, github_id, github_login, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET github_login = excluded.github_login RETURNING id`,
    )
    .bind(newId("acc"), githubId, login, nowIso())
    .first<{ id: string }>();
  return row!.id;
}

export async function issueTokens(db: D1Database, accountId: string, scopes: Scope[], clientId: string | null) {
  const access = `hire_at_${randomHex(32)}`;
  const refresh = `hire_rt_${randomHex(32)}`;
  await db
    .prepare(
      `INSERT INTO tokens (id, account_id, client_id, scopes, access_hash, access_expires_at, refresh_hash,
         refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("tok"),
      accountId,
      clientId,
      JSON.stringify(scopes),
      await sha256Hex(access),
      isoAfter(ACCESS_TTL),
      await sha256Hex(refresh),
      isoAfter(REFRESH_TTL),
      nowIso(),
    )
    .run();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

export async function authenticate(db: D1Database, request: Request): Promise<Auth> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HireError("unauthorized", "缺少令牌。请在 Authorization 头里带上 Bearer 令牌。");
  const row = await db
    .prepare(
      `SELECT t.account_id, t.scopes, a.github_login FROM tokens t JOIN accounts a ON a.id = t.account_id
       WHERE t.access_hash = ? AND t.revoked = 0 AND t.access_expires_at > ?`,
    )
    .bind(await sha256Hex(match[1]!), nowIso())
    .first<{ account_id: string; scopes: string; github_login: string }>();
  if (!row) throw new HireError("unauthorized", "令牌无效或已过期。用刷新令牌换一个新的，或重新登录。");
  return {
    accountId: row.account_id,
    login: row.github_login,
    scopes: new Set(parseScopes(parseJson<string[]>(row.scopes, []))),
  };
}
