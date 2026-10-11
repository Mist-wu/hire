import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, api } from "./helpers";

const REDIRECT = "http://127.0.0.1:53111/callback";

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce() {
  const verifier = "v".repeat(50) + Math.random().toString(36).slice(2);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** 假装 GitHub：换令牌、查用户、设备码。 */
function mockGithub(user: { id: number; login: string }, device: { pending: number } = { pending: 0 }) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = String(init?.body ?? "");
    if (url === "https://github.com/login/oauth/access_token") {
      if (body.includes("device_code") && device.pending-- > 0) return Response.json({ error: "authorization_pending" });
      return Response.json({ access_token: "gho_test" });
    }
    if (url === "https://api.github.com/user") return Response.json(user);
    if (url === "https://github.com/login/device/code") {
      return Response.json({ device_code: "gh-device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    return real(input as RequestInfo, init);
  });
}

async function register(extra: Record<string, unknown> = {}) {
  const res = await SELF.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "测试客户端", redirect_uris: [REDIRECT], ...extra }),
  });
  return { status: res.status, data: await res.json<any>() };
}

async function startAuthorize(clientId: string, challenge: string, extra = "") {
  const res = await SELF.fetch(
    `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz${extra}`,
    { redirect: "manual" },
  );
  const location = new URL(res.headers.get("Location") ?? "http://none");
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  return { res, location, cookie, requestId: location.searchParams.get("state")! };
}

async function consent(requestId: string, cookie: string, decision: string, roles: string[] = []) {
  const callback = await SELF.fetch(`${BASE}/oauth/github/callback?code=gh-code&state=${requestId}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  const html = await callback.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const res = await SELF.fetch(`${BASE}/oauth/consent`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([["request_id", requestId], ["csrf", csrf], ["decision", decision], ...roles.map((r) => ["role", r])]),
    redirect: "manual",
  });
  return { html, callbackStatus: callback.status, location: new URL(res.headers.get("Location") ?? "http://none") };
}

async function token(params: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, data: await res.json<any>() };
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth", () => {
  it("元数据齐全", async () => {
    const meta = await (await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`)).json<any>();
    expect(meta).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("注册时拒绝危险的回调地址", async () => {
    expect((await register()).status).toBe(201);
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: ["cursor://anysphere.cursor/oauth"] })).status).toBe(201);
  });

  it("授权码流程：GitHub 登录、确认页、换令牌、刷新", async () => {
    mockGithub({ id: 4242, login: "octo" });
    const client = (await register()).data;
    const { verifier, challenge } = await pkce();
    const start = await startAuthorize(client.client_id, challenge);
    expect(start.res.status).toBe(302);
    expect(start.location.origin + start.location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(start.location.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/github/callback`);

    const done = await consent(start.requestId, start.cookie, "approve", ["candidate"]);
    expect(done.html).toContain("octo");
    expect(done.html).toContain("测试客户端");
    expect(done.html).toContain("127.0.0.1:53111");
    expect(done.location.searchParams.get("state")).toBe("xyz");
    const code = done.location.searchParams.get("code")!;
    expect(code).toBeTruthy();

    const wrong = await token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "wrong" });
    expect(wrong.data.error).toBe("invalid_grant");
    // 授权码只能用一次，哪怕第一次因为 verifier 不对失败了
    const reused = await token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(reused.data.error).toBe("invalid_grant");

    const again = await startAuthorize(client.client_id, challenge);
    const code2 = (await consent(again.requestId, again.cookie, "approve", ["candidate"])).location.searchParams.get("code")!;
    const issued = await token({ grant_type: "authorization_code", code: code2, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(issued.status).toBe(200);
    expect(issued.data).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "candidate:read candidate:write candidate:apply" });

    expect((await api("GET", "/me/profile", issued.data.access_token)).status).toBe(200);
    expect((await api("GET", "/company", issued.data.access_token)).status).toBe(403);

    const refreshed = await token({ grant_type: "refresh_token", refresh_token: issued.data.refresh_token, client_id: client.client_id });
    expect(refreshed.status).toBe(200);
    expect((await api("GET", "/me/profile", issued.data.access_token)).status).toBe(401);
    expect((await api("GET", "/me/profile", refreshed.data.access_token)).status).toBe(200);
    const replay = await token({ grant_type: "refresh_token", refresh_token: issued.data.refresh_token, client_id: client.client_id });
    expect(replay.data.error).toBe("invalid_grant");
  });

  it("确认页必须在发起授权的浏览器里完成，拒绝则不发码", async () => {
    mockGithub({ id: 4343, login: "victim" });
    const client = (await register()).data;
    const { challenge } = await pkce();

    // 没有 cookie：攻击者把自己发起的链接发给别人
    const start = await startAuthorize(client.client_id, challenge);
    const stolen = await SELF.fetch(`${BASE}/oauth/github/callback?code=gh-code&state=${start.requestId}`, { redirect: "manual" });
    expect(stolen.status).toBe(400);

    const denied = await consent(start.requestId, start.cookie, "deny");
    expect(denied.location.searchParams.get("error")).toBe("access_denied");
    expect(denied.location.searchParams.get("code")).toBeNull();

    // 指定了 resource 的连接器只能授权对应身份
    const fixed = await startAuthorize(client.client_id, challenge, `&resource=${encodeURIComponent(`${BASE}/mcp/recruiter`)}`);
    const mismatch = await consent(fixed.requestId, fixed.cookie, "approve", ["candidate"]);
    expect(mismatch.html).not.toContain('value="candidate"');
    expect(mismatch.html).toContain('value="recruiter"');
    expect(mismatch.location.searchParams.get("error")).toBe("access_denied");
  });

  it("固定身份的连接器只拿到那种身份的范围，即使客户端申请了全部", async () => {
    mockGithub({ id: 4545, login: "pi-user" });
    const unauth = await SELF.fetch(`${BASE}/mcp/candidate`, { method: "POST", body: "{}" });
    const metaUrl = /resource_metadata="([^"]+)"/.exec(unauth.headers.get("WWW-Authenticate") ?? "")?.[1];
    expect(metaUrl).toBe(`${BASE}/.well-known/oauth-protected-resource/mcp/candidate`);
    const meta = await (await SELF.fetch(metaUrl!)).json<any>();
    expect(meta).toMatchObject({ resource: `${BASE}/mcp/candidate`, scopes_supported: ["candidate:read", "candidate:write", "candidate:apply"] });

    const client = (await register()).data;
    const { verifier, challenge } = await pkce();
    const all = "candidate:read candidate:write candidate:apply recruiter:read recruiter:write recruiter:invite";
    const start = await startAuthorize(client.client_id, challenge, `&scope=${encodeURIComponent(all)}&resource=${encodeURIComponent(`${BASE}/mcp/candidate`)}`);
    const done = await consent(start.requestId, start.cookie, "approve", ["candidate", "recruiter"]);
    expect(done.html).not.toContain("发布和关闭岗位");
    const issued = await token({ grant_type: "authorization_code", code: done.location.searchParams.get("code")!, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(issued.data.scope).toBe("candidate:read candidate:write candidate:apply");
  });

  it("通用地址上可以勾选身份：两个都选、只选一个、一个都不选", async () => {
    mockGithub({ id: 4646, login: "chooser" });
    const client = (await register()).data;
    const { verifier, challenge } = await pkce();
    const grant = async (roles: string[]) => {
      const start = await startAuthorize(client.client_id, challenge);
      const done = await consent(start.requestId, start.cookie, "approve", roles);
      const code = done.location.searchParams.get("code");
      if (!code) return { html: done.html, error: done.location.searchParams.get("error") };
      const issued = await token({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
      return { html: done.html, scope: issued.data.scope as string };
    };
    const both = await grant(["candidate", "recruiter"]);
    expect(both.html).toContain('type="checkbox" name="role" value="candidate" checked');
    expect(both.scope).toBe("candidate:read candidate:write candidate:apply recruiter:read recruiter:write recruiter:invite");
    expect((await grant(["recruiter"])).scope).toBe("recruiter:read recruiter:write recruiter:invite");
    expect((await grant([])).error).toBe("access_denied");
    expect((await grant(["admin"])).error).toBe("access_denied");
  });

  it("授权请求不合法时不跳转到未登记的地址", async () => {
    const client = (await register()).data;
    const { challenge } = await pkce();
    const badRedirect = await SELF.fetch(
      `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(badRedirect.status).toBe(400);
    const noPkce = await SELF.fetch(
      `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      { redirect: "manual" },
    );
    expect(new URL(noPkce.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    // 回环地址换端口仍然算同一个
    const otherPort = await SELF.fetch(
      `${BASE}/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(otherPort.headers.get("Location")).toContain("github.com");
  });

  it("设备码流程", async () => {
    mockGithub({ id: 4444, login: "cli-user" }, { pending: 1 });
    const post = async (body: Record<string, string>) => {
      const res = await SELF.fetch(`${BASE}/oauth/device/code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json<any>() };
    };
    expect((await post({})).data.error).toBe("invalid_scope");
    const started = await post({ scope: "recruiter:read recruiter:write" });
    expect(started.data).toMatchObject({ user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" });

    const grant = { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.data.device_code };
    expect((await token(grant)).data.error).toBe("authorization_pending");
    const issued = await token(grant);
    expect(issued.data.scope).toBe("recruiter:read recruiter:write");
    expect((await api("GET", "/company", issued.data.access_token)).status).toBe(200);
    expect((await token(grant)).data.error).toBe("invalid_grant");
  });
});
