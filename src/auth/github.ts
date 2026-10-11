import type { Env } from "../env";
import { HireError } from "../errors";

const HEADERS = { Accept: "application/json", "User-Agent": "hire-worker" };

export function githubConfig(env: Env): { id: string; secret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HireError("not_configured", "服务端还没有配置 GitHub 登录（GITHUB_CLIENT_ID 和 GITHUB_CLIENT_SECRET）。");
  }
  return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: githubConfig(env).id,
    redirect_uri: redirectUri,
    scope: "read:user",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string | null> {
  const { id, secret } = githubConfig(env);
  const data = await postForm("https://github.com/login/oauth/access_token", {
    client_id: id,
    client_secret: secret,
    code,
    redirect_uri: redirectUri,
  });
  return typeof data.access_token === "string" ? data.access_token : null;
}

export async function getUser(accessToken: string): Promise<{ id: number; login: string } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: { ...HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: unknown; login?: unknown };
  return typeof data.id === "number" && typeof data.login === "string" ? { id: data.id, login: data.login } : null;
}

export async function startDevice(env: Env) {
  const data = await postForm("https://github.com/login/device/code", {
    client_id: githubConfig(env).id,
    scope: "read:user",
  });
  if (typeof data.device_code !== "string" || typeof data.user_code !== "string") return null;
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: String(data.verification_uri ?? "https://github.com/login/device"),
    expires_in: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

export async function pollDevice(env: Env, deviceCode: string): Promise<{ access_token?: string; error?: string }> {
  const data = await postForm("https://github.com/login/oauth/access_token", {
    client_id: githubConfig(env).id,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (typeof data.access_token === "string") return { access_token: data.access_token };
  return { error: typeof data.error === "string" ? data.error : "server_error" };
}
