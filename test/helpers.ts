import { SELF } from "cloudflare:test";

export const BASE = "https://hire.test";
let counter = 0;

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${counter++}`;
}

export async function login(name: string, scope?: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/oauth/dev/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: name, ...(scope ? { scope } : {}) }),
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export const CANDIDATE = "candidate:read candidate:write candidate:apply";
export const RECRUITER = "recruiter:read recruiter:write recruiter:invite";

export async function api<T = any>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await SELF.fetch(`${BASE}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

export async function mcp(token: string, method: string, params?: unknown, path = "/mcp") {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

export const internJob = {
  title: "后端开发实习生",
  recruit_type: "intern_daily",
  category: "tech.backend",
  cities: ["北京"],
  experience: "student",
  degree: "bachelor",
  grad_years: [2027, 2028],
  salary_min: 200,
  salary_max: 300,
  salary_unit: "per_day",
  days_per_week: 4,
  min_months: 3,
  duties: "参与招聘平台的接口开发，维护 Rust 和 TypeScript 服务。",
  requirements: "熟悉至少一门后端语言，了解 HTTP 和 SQLite。",
  skills: ["Rust", "TypeScript", "SQLite"],
};

export const profile = {
  name: "林晓",
  school: "北京邮电大学",
  degree: "bachelor",
  major: "计算机科学与技术",
  grad_year: 2028,
  city: "北京",
  skills: ["Rust", "Python"],
  summary: "做过几个 agent 相关的后端项目。",
  expectation: { recruit_types: ["intern_daily"], cities: ["北京"], days_per_week: 4 },
  phone: "13800000000",
  email: "linxiao@example.com",
};

/** 建好一家公司、一个开放的实习岗位和一位资料完整的求职者。 */
export async function setup() {
  const hr = await login(unique("hr"), RECRUITER);
  const seeker = await login(unique("seeker"), CANDIDATE);
  await api("PUT", "/company", hr, { name: unique("示例公司"), contact_email: "hr@example.com" });
  const job = (await api("POST", "/jobs", hr, internJob)).data.job;
  const me = (await api("PATCH", "/me/profile", seeker, profile)).data.profile;
  return { hr, seeker, job, candidateId: me.id as string };
}

export function future(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}
