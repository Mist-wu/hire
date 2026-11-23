import { ROLE_SCOPES, SCOPES, type Auth, type Role, type Scope } from "../env";
import { HireError } from "../errors";
import { isoAfter, newId, nowIso, parseJson, randomHex, sha256Hex } from "../util";

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;

export function parseScopes(raw: unknown): Scope[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  return SCOPES.filter((s) => parts.includes(s));
}

/** 客户端在请求里写的 scope。没写是空数组；写了不认识的值返回 null，调用方按 invalid_scope 处理，不能悄悄忽略。 */
export function requestedScopes(raw: string | undefined): Scope[] | null {
  const parts = new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
  const scopes = parseScopes([...parts]);
  return scopes.length === parts.size ? scopes : null;
}

/**
 * 令牌的受众（RFC 8707 的 resource）。/mcp 和 /v1 是同一个资源，用受保护资源元数据里公布的地址表示。
 * 客户端没传 resource 时就是它。
 */
export function resourceUri(origin: string): string {
  return `${origin}/mcp`;
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

/** 给还没定身份的账号定下身份。返回账号最终的身份，可能和传入的不同。 */
export async function claimRole(db: D1Database, accountId: string, role: Role): Promise<Role> {
  await db.prepare("UPDATE accounts SET role = ? WHERE id = ? AND role IS NULL").bind(role, accountId).run();
  return (await accountRole(db, accountId)) ?? role;
}

export async function accountRole(db: D1Database, accountId: string): Promise<Role | null> {
  const row = await db.prepare("SELECT role FROM accounts WHERE id = ?").bind(accountId).first<{ role: Role | null }>();
  return row?.role ?? null;
}

export async function issueTokens(
  db: D1Database,
  accountId: string,
  scopes: Scope[],
  clientId: string | null,
  resource: string,
) {
  const access = `hire_at_${randomHex(32)}`;
  const refresh = `hire_rt_${randomHex(32)}`;
  await db
    .prepare(
      `INSERT INTO tokens (id, account_id, client_id, scopes, access_hash, access_expires_at, refresh_hash,
         refresh_expires_at, created_at, resource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      resource,
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
  // 受众留空的是加上资源绑定之前签发的，照旧可用，刷新后换成绑定的
  const row = await db
    .prepare(
      `SELECT t.account_id, t.scopes, a.role FROM tokens t JOIN accounts a ON a.id = t.account_id
       WHERE t.access_hash = ? AND t.revoked = 0 AND t.access_expires_at > ? AND (t.resource IS NULL OR t.resource = ?)`,
    )
    .bind(await sha256Hex(match[1]!), nowIso(), resourceUri(new URL(request.url).origin))
    .first<{ account_id: string; scopes: string; role: Role | null }>();
  if (!row) throw new HireError("unauthorized", "令牌无效、已过期或不是发给这个服务的。用刷新令牌换一个新的，或重新登录。");
  return {
    accountId: row.account_id,
    role: row.role,
    // 令牌的范围不能超出账号的身份
    scopes: new Set(
      parseScopes(parseJson<string[]>(row.scopes, [])).filter((s) => row.role && ROLE_SCOPES[row.role].includes(s)),
    ),
  };
}
