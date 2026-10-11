import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ROLE_NAMES, ROLE_SCOPES, SCOPES, roleOfScopes, type Env, type Role, type Scope } from "../env";
import { HireError } from "../errors";
import { escapeHtml, isoAfter, newId, nowIso, parseJson, randomHex, safeEqual, sha256Base64url, sha256Hex } from "../util";
import { authorizeUrl, exchangeCode, getUser, githubConfig, pollDevice, startDevice } from "./github";
import { accountRole, claimRole, issueTokens, parseScopes, upsertAccount } from "./tokens";

type C = Context<{ Bindings: Env }>;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const COOKIE = "hire_auth";
const REQUEST_TTL = 600;
const CODE_TTL = 300;

const SCOPE_LABELS: Record<Scope, string> = {
  "candidate:read": "查看资料和投递、搜索岗位",
  "candidate:write": "修改资料和简历",
  "candidate:apply": "投递、撤回、回应邀约",
  "recruiter:read": "搜索求职者、查看投递",
  "recruiter:write": "修改公司、发布和关闭岗位",
  "recruiter:invite": "发邀约、发录用、拒绝投递",
};

function oauthError(c: C, error: string, description: string, status: 400 | 401 | 503 = 400) {
  return c.json({ error, error_description: description }, status, { "Cache-Control": "no-store" });
}

function origin(c: C): string {
  return new URL(c.req.url).origin;
}

async function body(c: C): Promise<Record<string, string>> {
  const type = c.req.header("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const data = (await c.req.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.join(" ") : String(v ?? "")]),
      );
    }
    const form = await c.req.parseBody();
    return Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function validRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url);
  // 桌面客户端的自定义协议，如 cursor://。挡掉能执行脚本或读本地文件的协议
  return !["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"].includes(url.protocol);
}

/** 精确匹配。本机回环地址忽略端口，因为客户端每次监听的端口不同。 */
function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  try {
    const g = new URL(given);
    if (!isLoopback(g)) return false;
    return registered.some((r) => {
      const u = new URL(r);
      return isLoopback(u) && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    });
  } catch {
    return false;
  }
}

function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

const PAGE_CSS = `
:root{--bg:#fff;--text:#222;--muted:#6b6b6b;--line:#e5e5e5;--accent:#f6821f}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--text:#eee;--muted:#9a9a9a;--line:#333}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:22rem;margin:0 auto;padding:4.5rem 1.25rem 2rem}
.brand{font-weight:600;margin:0 0 2.5rem}
h1{font-size:1.375rem;line-height:1.3;font-weight:600;margin:0 0 .375rem}
p{margin:0}
.muted{color:var(--muted);font-size:.875rem;word-break:break-all}
.roles{margin:1.75rem 0;border-top:1px solid var(--line)}
.role{display:flex;gap:.75rem;padding:.875rem 0;border-bottom:1px solid var(--line)}
.role input{flex:none;width:1rem;height:1rem;margin:.2rem 0 0;accent-color:var(--accent)}
.role b{display:block;font-weight:500}
.actions{display:flex;gap:.5rem}
button{font:inherit;padding:.5rem 1.25rem;border-radius:4px;border:1px solid var(--line);background:none;color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

function page(title: string, inner: string, status: 200 | 400 = 200): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head>
<body><main><p class="brand">hire</p>${inner}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function failPage(message: string): Response {
  return page("授权失败", `<h1>授权失败</h1><p class="muted">${escapeHtml(message)}</p>`, 400);
}

/** 这次授权最多能给哪些范围：客户端申请的，没申请就是全部。 */
function grantable(request: { scopes: string | null }): Scope[] {
  const requested = parseScopes(parseJson<string[]>(request.scopes, []));
  return requested.length ? requested : [...SCOPES];
}

function rolesIn(scopes: Scope[]): Role[] {
  return (["candidate", "recruiter"] as Role[]).filter((role) => scopes.some((s) => s.startsWith(`${role}:`)));
}

function wrongRole(actual: Role): string {
  return `这个 GitHub 账号已经是${ROLE_NAMES[actual]}，不能再用另一种身份登录。一个账号只能有一种身份。`;
}

interface AuthRequestRow {
  id: string;
  csrf: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scopes: string | null;
  resource: string | null;
  account_id: string | null;
  expires_at: string;
}

async function loadRequest(c: C, id: string): Promise<AuthRequestRow | null> {
  const row = await c.env.DB.prepare("SELECT * FROM auth_requests WHERE id = ? AND expires_at > ?")
    .bind(id, nowIso())
    .first<AuthRequestRow>();
  if (!row) return null;
  // 这个 cookie 把授权请求绑在发起它的那个浏览器上
  const cookie = getCookie(c, COOKIE) ?? "";
  return safeEqual(cookie, `${row.id}.${row.csrf}`) ? row : null;
}

function metadata(c: C) {
  const base = origin(c);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    device_authorization_endpoint: `${base}/oauth/device/code`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SCOPES,
  };
}

export const oauth = new Hono<{ Bindings: Env }>();

oauth.get("/.well-known/oauth-authorization-server", (c) => c.json(metadata(c)));
oauth.get("/.well-known/oauth-authorization-server/*", (c) => c.json(metadata(c)));
oauth.get("/.well-known/openid-configuration", (c) => c.json(metadata(c)));

function protectedResource(c: C) {
  const base = origin(c);
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "hire",
  });
}
oauth.get("/.well-known/oauth-protected-resource", protectedResource);
oauth.get("/.well-known/oauth-protected-resource/*", protectedResource);

// 动态客户端注册
oauth.post("/oauth/register", async (c) => {
  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    return oauthError(c, "invalid_client_metadata", "请求体必须是 JSON。");
  }
  const uris = Array.isArray(data.redirect_uris) ? data.redirect_uris.filter((u) => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError(
      c,
      "invalid_redirect_uri",
      "redirect_uris 必须是 1 到 10 个地址：https、本机回环的 http，或客户端自定义协议。",
    );
  }
  const method = typeof data.token_endpoint_auth_method === "string" ? data.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    return oauthError(c, "invalid_client_metadata", "不支持这种 token_endpoint_auth_method。");
  }
  const id = newId("cli");
  const secret = method === "none" ? null : `hire_cs_${randomHex(24)}`;
  const name = typeof data.client_name === "string" ? data.client_name.slice(0, 80) : null;
  await c.env.DB.prepare(
    "INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, secret ? await sha256Hex(secret) : null, name, JSON.stringify(uris), nowIso())
    .run();
  return c.json(
    {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    },
    201,
    { "Cache-Control": "no-store" },
  );
});

// 授权：不出自己的登录页，直接跳去 GitHub
oauth.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const client = await c.env.DB.prepare("SELECT * FROM oauth_clients WHERE id = ?")
    .bind(q.client_id ?? "")
    .first<{ id: string; redirect_uris: string }>();
  if (!client) return failPage("client_id 无效。请让客户端重新注册。");
  const redirectUri = q.redirect_uri ?? "";
  if (!redirectMatches(parseJson<string[]>(client.redirect_uris, []), redirectUri)) {
    return failPage("redirect_uri 和客户端注册时登记的不一致。");
  }
  const back = (error: string, description: string) =>
    c.redirect(redirectWith(redirectUri, { error, error_description: description, state: q.state }));
  if (q.response_type !== "code") return back("unsupported_response_type", "只支持 response_type=code");
  if (!q.code_challenge || (q.code_challenge_method ?? "plain") !== "S256") {
    return back("invalid_request", "必须使用 PKCE，且 code_challenge_method=S256");
  }
  try {
    githubConfig(c.env);
  } catch {
    return back("server_error", "服务端还没有配置 GitHub 登录");
  }
  const scopes = parseScopes(q.scope ?? "");
  const id = newId("req");
  const csrf = randomHex(24);
  await c.env.DB.prepare(
    `INSERT INTO auth_requests (id, csrf, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      csrf,
      client.id,
      redirectUri,
      q.state ?? null,
      q.code_challenge,
      scopes.length ? JSON.stringify(scopes) : null,
      q.resource ?? null,
      isoAfter(REQUEST_TTL),
    )
    .run();
  setCookie(c, COOKIE, `${id}.${csrf}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/oauth",
    maxAge: REQUEST_TTL,
  });
  return c.redirect(authorizeUrl(c.env, `${origin(c)}/oauth/github/callback`, id));
});

// GitHub 回来之后，出一个确认页。没有这一步，任何注册过的客户端都能借用户已有的 GitHub 授权悄悄拿到令牌
oauth.get("/oauth/github/callback", async (c) => {
  const q = c.req.query();
  const request = await loadRequest(c, q.state ?? "");
  if (!request) return failPage("这次授权已过期，或者不是在这个浏览器里发起的。请回到客户端重新开始。");
  if (!q.code) {
    await c.env.DB.prepare("DELETE FROM auth_requests WHERE id = ?").bind(request.id).run();
    return c.redirect(redirectWith(request.redirect_uri, { error: "access_denied", state: request.state }));
  }
  const ghToken = await exchangeCode(c.env, q.code, `${origin(c)}/oauth/github/callback`);
  const user = ghToken ? await getUser(ghToken) : null;
  if (!user) return failPage("向 GitHub 确认身份失败。请回到客户端重新开始。");
  const accountId = await upsertAccount(c.env.DB, user.id, user.login);
  await c.env.DB.prepare("UPDATE auth_requests SET account_id = ? WHERE id = ?").bind(accountId, request.id).run();

  const client = await c.env.DB.prepare("SELECT name FROM oauth_clients WHERE id = ?")
    .bind(request.client_id)
    .first<{ name: string | null }>();
  // 账号已有身份时只能用那个身份；还没有时在这一页选定
  const fixed = await accountRole(c.env.DB, accountId);
  const scopes = grantable(request).filter((s) => !fixed || ROLE_SCOPES[fixed].includes(s));
  const roles = rolesIn(scopes);
  if (!roles.length) return failPage(wrongRole(fixed!));
  const clientName = escapeHtml(client?.name ?? "未命名客户端");
  let host = request.redirect_uri;
  try {
    const u = new URL(request.redirect_uri);
    host = u.host || u.protocol;
  } catch {}

  const roleRow = (role: Role) => {
    const can = scopes
      .filter((s) => s.startsWith(`${role}:`))
      .map((s) => SCOPE_LABELS[s])
      .join("；");
    // 两种身份都可选时二选一；只有一种时不需要选
    const input =
      roles.length > 1
        ? `<input type="radio" name="role" value="${role}" required>`
        : `<input type="hidden" name="role" value="${role}">`;
    return `<label class="role">${input}<span><b>${ROLE_NAMES[role]}</b><span class="muted">${escapeHtml(can)}</span></span></label>`;
  };

  return page(
    "授权访问 hire",
    `<form method="post" action="/oauth/consent">
<input type="hidden" name="request_id" value="${escapeHtml(request.id)}">
<input type="hidden" name="csrf" value="${escapeHtml(request.csrf)}">
<h1>${clientName} 请求访问你的账号</h1>
<p class="muted">${escapeHtml(user.login)} · 授权后跳转到 ${escapeHtml(host)}${roles.length > 1 ? " · 身份选定后不能更改" : ""}</p>
<div class="roles">${roles.map(roleRow).join("")}</div>
<div class="actions"><button name="decision" value="approve" class="primary">授权</button><button name="decision" value="deny">拒绝</button></div>
</form>`,
  );
});

oauth.post("/oauth/consent", async (c) => {
  const form = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
  const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "");
  const request = await loadRequest(c, field("request_id"));
  if (!request || !request.account_id || !safeEqual(field("csrf"), request.csrf)) {
    return failPage("这次授权已过期或无效。请回到客户端重新开始。");
  }
  await c.env.DB.prepare("DELETE FROM auth_requests WHERE id = ?").bind(request.id).run();
  deleteCookie(c, COOKIE, { path: "/oauth" });

  // 只发页面上列出过、并且属于所选身份的那些范围
  const chosen = field("role") as Role;
  const scopes =
    field("decision") === "approve" && (chosen === "candidate" || chosen === "recruiter")
      ? grantable(request).filter((s) => ROLE_SCOPES[chosen].includes(s))
      : [];
  if (!scopes.length) {
    return c.redirect(redirectWith(request.redirect_uri, { error: "access_denied", state: request.state }), 303);
  }
  const actual = await claimRole(c.env.DB, request.account_id, chosen);
  if (actual !== chosen) return failPage(wrongRole(actual));
  const code = `hire_ac_${randomHex(32)}`;
  await c.env.DB.prepare(
    `INSERT INTO auth_codes (code_hash, client_id, redirect_uri, code_challenge, account_id, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(code),
      request.client_id,
      request.redirect_uri,
      request.code_challenge,
      request.account_id,
      JSON.stringify(scopes),
      isoAfter(CODE_TTL),
    )
    .run();
  return c.redirect(redirectWith(request.redirect_uri, { code, state: request.state }), 303);
});

async function checkClient(c: C, form: Record<string, string>): Promise<{ id: string } | Response> {
  let clientId = form.client_id ?? "";
  let secret = form.client_secret ?? "";
  const basic = /^Basic\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  if (basic) {
    try {
      const [user, ...rest] = atob(basic[1]!).split(":");
      clientId = decodeURIComponent(user ?? "");
      secret = decodeURIComponent(rest.join(":"));
    } catch {}
  }
  const client = await c.env.DB.prepare("SELECT id, secret_hash FROM oauth_clients WHERE id = ?")
    .bind(clientId)
    .first<{ id: string; secret_hash: string | null }>();
  if (!client) return oauthError(c, "invalid_client", "client_id 无效。", 401);
  if (client.secret_hash && !safeEqual(client.secret_hash, await sha256Hex(secret))) {
    return oauthError(c, "invalid_client", "client_secret 不对。", 401);
  }
  return { id: client.id };
}

async function deviceGrant(c: C, form: Record<string, string>) {
  const hash = await sha256Hex(form.device_code ?? "");
  const row = await c.env.DB.prepare("SELECT * FROM device_requests WHERE device_hash = ?")
    .bind(hash)
    .first<{ github_device_code: string; scopes: string; expires_at: string }>();
  const drop = () => c.env.DB.prepare("DELETE FROM device_requests WHERE device_hash = ?").bind(hash).run();
  if (!row) return oauthError(c, "invalid_grant", "device_code 无效。");
  if (row.expires_at <= nowIso()) {
    await drop();
    return oauthError(c, "expired_token", "设备码已过期，请重新申请。");
  }
  const result = await pollDevice(c.env, row.github_device_code);
  if (!result.access_token) {
    const error = result.error ?? "server_error";
    if (error === "authorization_pending") return oauthError(c, error, "用户还没有在 GitHub 上输入用户码。稍后再试。");
    if (error === "slow_down") return oauthError(c, error, "轮询太快了，把间隔加 5 秒。");
    await drop();
    if (error === "access_denied") return oauthError(c, error, "用户拒绝了授权。");
    if (error === "expired_token") return oauthError(c, error, "设备码已过期，请重新申请。");
    return oauthError(c, "invalid_grant", `GitHub 返回了错误：${error}`);
  }
  const user = await getUser(result.access_token);
  if (!user) return oauthError(c, "invalid_grant", "向 GitHub 确认身份失败。");
  await drop();
  const accountId = await upsertAccount(c.env.DB, user.id, user.login);
  const scopes = parseScopes(parseJson<string[]>(row.scopes, []));
  const role = roleOfScopes(scopes);
  if (role === null || role === "mixed") return oauthError(c, "invalid_scope", "scope 只能包含一种身份的范围。");
  const actual = await claimRole(c.env.DB, accountId, role);
  if (actual !== role) return oauthError(c, "access_denied", wrongRole(actual));
  const tokens = await issueTokens(c.env.DB, accountId, scopes, null);
  return c.json(tokens, 200, { "Cache-Control": "no-store" });
}

oauth.post("/oauth/token", async (c) => {
  const form = await body(c);
  const db = c.env.DB;
  if (form.grant_type === DEVICE_GRANT) {
    try {
      return await deviceGrant(c, form);
    } catch (err) {
      if (err instanceof HireError) return oauthError(c, "server_error", err.message, 503);
      throw err;
    }
  }

  if (form.grant_type === "authorization_code") {
    const client = await checkClient(c, form);
    if (client instanceof Response) return client;
    const row = await db
      .prepare("UPDATE auth_codes SET used = 1 WHERE code_hash = ? AND used = 0 RETURNING *")
      .bind(await sha256Hex(form.code ?? ""))
      .first<{
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        account_id: string;
        scopes: string;
        expires_at: string;
      }>();
    if (!row || row.expires_at <= nowIso() || row.client_id !== client.id) {
      return oauthError(c, "invalid_grant", "授权码无效、已用过或已过期。");
    }
    if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri) {
      return oauthError(c, "invalid_grant", "redirect_uri 和授权时的不一致。");
    }
    const challenge = await sha256Base64url(form.code_verifier ?? "");
    if (!form.code_verifier || !safeEqual(challenge, row.code_challenge)) {
      return oauthError(c, "invalid_grant", "code_verifier 校验失败。");
    }
    const tokens = await issueTokens(db, row.account_id, parseScopes(parseJson<string[]>(row.scopes, [])), client.id);
    return c.json(tokens, 200, { "Cache-Control": "no-store" });
  }

  if (form.grant_type === "refresh_token") {
    const hash = await sha256Hex(form.refresh_token ?? "");
    const existing = await db
      .prepare("SELECT client_id FROM tokens WHERE refresh_hash = ? AND revoked = 0")
      .bind(hash)
      .first<{ client_id: string | null }>();
    if (!existing) return oauthError(c, "invalid_grant", "刷新令牌无效或已用过。请重新登录。");
    if (existing.client_id) {
      const client = await checkClient(c, form);
      if (client instanceof Response) return client;
      if (client.id !== existing.client_id) return oauthError(c, "invalid_grant", "这个刷新令牌不属于这个客户端。");
    }
    // 刷新令牌一次有效：先作废旧的，再签新的
    const row = await db
      .prepare("UPDATE tokens SET revoked = 1 WHERE refresh_hash = ? AND revoked = 0 RETURNING *")
      .bind(hash)
      .first<{ account_id: string; client_id: string | null; scopes: string; refresh_expires_at: string }>();
    if (!row || row.refresh_expires_at <= nowIso()) {
      return oauthError(c, "invalid_grant", "刷新令牌无效或已过期。请重新登录。");
    }
    const tokens = await issueTokens(db, row.account_id, parseScopes(parseJson<string[]>(row.scopes, [])), row.client_id);
    return c.json(tokens, 200, { "Cache-Control": "no-store" });
  }

  return oauthError(c, "unsupported_grant_type", "只支持 authorization_code、refresh_token 和设备码。");
});

// 设备码：给命令行和技能包用。必须说明要哪些范围
oauth.post("/oauth/device/code", async (c) => {
  const form = await body(c);
  const scopes = parseScopes(form.scope ?? "");
  if (roleOfScopes(scopes) === null || roleOfScopes(scopes) === "mixed") {
    return oauthError(
      c,
      "invalid_scope",
      `scope 必填，用空格分隔，只能包含一种身份的范围。求职者用 "${ROLE_SCOPES.candidate.join(" ")}"，招聘者用 "${ROLE_SCOPES.recruiter.join(" ")}"。`,
    );
  }
  let started;
  try {
    started = await startDevice(c.env);
  } catch (err) {
    if (err instanceof HireError) return oauthError(c, "server_error", err.message, 503);
    throw err;
  }
  if (!started) return oauthError(c, "server_error", "向 GitHub 申请设备码失败。确认 GitHub 应用已开启 Device Flow。", 503);
  const deviceCode = `hire_dc_${randomHex(32)}`;
  await c.env.DB.prepare(
    "INSERT INTO device_requests (device_hash, github_device_code, scopes, poll_interval, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(deviceCode), started.device_code, JSON.stringify(scopes), started.interval, isoAfter(started.expires_in))
    .run();
  return c.json(
    {
      device_code: deviceCode,
      user_code: started.user_code,
      verification_uri: started.verification_uri,
      expires_in: started.expires_in,
      interval: started.interval,
      scope: scopes.join(" "),
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

oauth.post("/oauth/revoke", async (c) => {
  const form = await body(c);
  const hash = await sha256Hex(form.token ?? "");
  await c.env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE access_hash = ? OR refresh_hash = ?").bind(hash, hash).run();
  return c.body(null, 200);
});

// 测试登录：只在 DEV_LOGIN=1 时存在，线上不开
oauth.post("/oauth/dev/token", async (c) => {
  if (c.env.DEV_LOGIN !== "1") return c.notFound();
  const form = await body(c);
  const login = (form.login ?? "").trim();
  if (!/^[\w-]{1,39}$/.test(login)) return oauthError(c, "invalid_request", "login 必填，只能包含字母、数字、下划线和连字符。");
  const digest = await sha256Hex(`dev:${login.toLowerCase()}`);
  const accountId = await upsertAccount(c.env.DB, -Number.parseInt(digest.slice(0, 12), 16), login);
  const existing = await accountRole(c.env.DB, accountId);
  const scopes = form.scope ? parseScopes(form.scope) : existing ? ROLE_SCOPES[existing] : [];
  const role = roleOfScopes(scopes);
  if (role === null || role === "mixed") return oauthError(c, "invalid_scope", "scope 只能包含一种身份的范围。");
  const actual = await claimRole(c.env.DB, accountId, role);
  if (actual !== role) return oauthError(c, "access_denied", wrongRole(actual));
  return c.json(await issueTokens(c.env.DB, accountId, scopes, null), 200, { "Cache-Control": "no-store" });
});
