#!/usr/bin/env node
// 把演示数据导入 hire。账号、临时令牌和公司用 SQL 写入，岗位和简历走 REST 接口，
// 这样搜索用的派生字段由服务端自己生成。可以重复执行，已有的同名岗位会跳过。
//
// 用法：node scripts/seed.mjs --url <服务地址> (--local | --remote) [--file seed/demo.json]
//                             [--owner-id <GitHub 数字 ID> --owner-login <GitHub 用户名>]
// 不传 owner 时用 gh 命令查当前登录的 GitHub 账号。演示公司都挂在这个账号名下。

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const url = opt("url")?.replace(/\/$/, "");
const target = flag("remote") ? "--remote" : flag("local") ? "--local" : null;
if (!url || !target) {
  console.error("用法：node scripts/seed.mjs --url <服务地址> (--local | --remote) [--file seed/demo.json]");
  process.exit(1);
}
const data = JSON.parse(readFileSync(opt("file", "seed/demo.json"), "utf8"));

let ownerId = opt("owner-id");
let ownerLogin = opt("owner-login");
if (!ownerId || !ownerLogin) {
  const me = JSON.parse(execFileSync("gh", ["api", "user"], { encoding: "utf8" }));
  ownerId = String(me.id);
  ownerLogin = me.login;
}
if (!/^-?\d+$/.test(ownerId)) throw new Error("owner-id 必须是数字");

const q = (value) => (value == null ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const now = new Date().toISOString();
const expires = new Date(Date.now() + 3600_000).toISOString();
const ALL_SCOPES = JSON.stringify([
  "candidate:read", "candidate:write", "candidate:apply", "recruiter:read", "recruiter:write", "recruiter:invite",
]);

function d1(sql) {
  const file = join(mkdtempSync(join(tmpdir(), "hire-seed-")), "seed.sql");
  writeFileSync(file, sql);
  execFileSync("npx", ["wrangler", "d1", "execute", "hire", target, "--yes", "--file", file], { stdio: ["ignore", "ignore", "inherit"] });
}

const tokens = new Map();
function accountSql(key, githubId, login, role) {
  const token = `hire_at_${randomBytes(32).toString("hex")}`;
  tokens.set(key, token);
  return [
    // 一个账号只有一种身份。已有身份的账号不改
    `INSERT INTO accounts (id, github_id, github_login, role, created_at)
     VALUES (${q(`acc_${randomBytes(10).toString("hex")}`)}, ${githubId}, ${q(login)}, ${q(role)}, ${q(now)})
     ON CONFLICT (github_id) DO UPDATE SET role = COALESCE(accounts.role, excluded.role);`,
    `INSERT INTO tokens (id, account_id, client_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
     SELECT ${q(`tok_seed_${randomBytes(8).toString("hex")}`)}, id, NULL, ${q(ALL_SCOPES)}, ${q(sha(token))}, ${q(expires)},
            ${q(`seed-${randomBytes(16).toString("hex")}`)}, ${q(now)}, ${q(now)}
     FROM accounts WHERE github_id = ${githubId};`,
  ];
}

const sql = [...accountSql("owner", ownerId, ownerLogin, "recruiter")];
data.candidates.forEach((c, i) => sql.push(...accountSql(c.login, -(900001 + i), c.login, "candidate")));
for (const c of data.companies) {
  sql.push(
    `INSERT INTO companies (id, owner_account_id, name, name_key, industry, scale, stage, website, intro, contact_email, created_at, updated_at)
     VALUES (${q(`com_demo_${c.key}`)}, (SELECT id FROM accounts WHERE github_id = ${ownerId}), ${q(c.name)}, ${q(c.name.normalize("NFKC").replace(/\s+/g, "").toLowerCase())}, ${q(c.industry)},
             ${q(c.scale)}, ${q(c.stage)}, ${q(c.website)}, ${q(c.intro)}, ${q(c.contact_email)}, ${q(now)}, ${q(now)})
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, industry = excluded.industry, scale = excluded.scale,
       stage = excluded.stage, website = excluded.website, intro = excluded.intro,
       contact_email = excluded.contact_email, updated_at = excluded.updated_at;`,
  );
}
console.log(`写入账号和公司（${target}）……`);
d1(sql.join("\n"));

async function call(method, path, token, body) {
  const res = await fetch(`${url}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

try {
  const owner = tokens.get("owner");
  const existing = new Set();
  let cursor;
  do {
    const page = await call("GET", `/jobs?mine=true&limit=50${cursor ? `&cursor=${cursor}` : ""}`, owner);
    for (const job of page.jobs) existing.add(`${job.company_id}|${job.title}`);
    cursor = page.next_cursor;
  } while (cursor);

  let created = 0;
  // 旧数据文件里可能还有已经去掉的字段
  for (const { company, teams, source_url, salary_months, custom_fields, ...fields } of data.jobs) {
    const companyId = `com_demo_${company}`;
    if (existing.has(`${companyId}|${fields.title}`)) continue;
    await call("POST", "/jobs", owner, { ...fields, company_id: companyId });
    created++;
  }
  console.log(`岗位：新建 ${created} 个，跳过 ${data.jobs.length - created} 个已有的。`);

  for (const c of data.candidates) await call("PATCH", "/me/profile", tokens.get(c.login), c.profile);
  console.log(`求职者：写入 ${data.candidates.length} 份简历。`);
} finally {
  d1("DELETE FROM tokens WHERE id LIKE 'tok_seed_%';");
  console.log("临时令牌已删除。");
}
