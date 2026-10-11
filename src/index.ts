import { Hono } from "hono";
import { cors } from "hono/cors";
import { oauth } from "./auth/oauth";
import type { Env } from "./env";
import { HireError } from "./errors";
import { handleMcp, unauthorized } from "./mcp";
import { openapi } from "./openapi";
import { OPS } from "./ops";
import { resumePdfForApplication } from "./ops/applications";
import { loadCandidate } from "./ops/candidates";
import { makeCtx, mountRest } from "./rest";
import { nowIso } from "./util";

const app = new Hono<{ Bindings: Env }>();

const open = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version", "Mcp-Session-Id"],
  exposeHeaders: ["WWW-Authenticate"],
  maxAge: 86400,
});
for (const path of ["/v1/*", "/mcp", "/mcp/*", "/.well-known/*", "/oauth/token", "/oauth/register", "/oauth/device/code", "/oauth/revoke"]) {
  app.use(path, open);
}

app.onError((err, c) => {
  if (err instanceof HireError) {
    if (err.code === "unauthorized") return unauthorized(c, err);
    return c.json(err.toJSON(), err.status as 400);
  }
  console.error("unhandled", err);
  return c.json(new HireError("internal", "服务端出错了。稍后再试一次。").toJSON(), 500);
});

app.notFound((c) => c.json(new HireError("not_found", "没有这个地址。接口列表见 /v1/openapi.json。").toJSON(), 404));

app.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    name: "hire",
    description: "给 AI agent 用的招聘平台。没有网页，只有接口。",
    mcp: { any: `${origin}/mcp`, candidate: `${origin}/mcp/candidate`, recruiter: `${origin}/mcp/recruiter` },
    rest: `${origin}/v1`,
    openapi: `${origin}/v1/openapi.json`,
    oauth_metadata: `${origin}/.well-known/oauth-authorization-server`,
    tools: OPS.map((op) => op.name),
    source: "https://github.com/Mist-wu/hire",
  });
});

app.get("/v1/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));

app.route("/", oauth);

async function sendPdf(env: Env, key: string, filename: string): Promise<Response> {
  const object = await env.FILES.get(key);
  if (!object) throw new HireError("not_found", "找不到这份 PDF。");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}

// 两个下载地址只有 REST，没有对应的 MCP 工具
app.get("/v1/me/resume/pdf", async (c) => {
  const ctx = await makeCtx(c);
  if (!ctx.auth.scopes.has("candidate:read")) {
    throw new HireError("forbidden_scope", "需要 candidate:read 范围。", { required: ["candidate:read"] });
  }
  const row = await loadCandidate(ctx.db, ctx.auth.accountId);
  if (!row?.pdf_key) throw new HireError("not_found", "你还没有上传过 PDF 简历。");
  return sendPdf(c.env, row.pdf_key, row.pdf_name ?? "resume.pdf");
});

app.get("/v1/applications/:application_id/resume.pdf", async (c) => {
  const ctx = await makeCtx(c);
  if (!ctx.auth.scopes.has("recruiter:read")) {
    throw new HireError("forbidden_scope", "需要 recruiter:read 范围。", { required: ["recruiter:read"] });
  }
  const { key, filename } = await resumePdfForApplication(ctx, c.req.param("application_id"));
  return sendPdf(c.env, key, filename);
});

mountRest(app);

app.all("/mcp", (c) => handleMcp(c));
app.all("/mcp/candidate", (c) => handleMcp(c, "candidate"));
app.all("/mcp/recruiter", (c) => handleMcp(c, "recruiter"));

async function cleanup(env: Env): Promise<void> {
  const now = nowIso();
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE created_at < ?").bind(daysAgo(30)),
    env.DB.prepare("DELETE FROM auth_requests WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM auth_codes WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM device_requests WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM tokens WHERE refresh_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM rate_counters WHERE CAST(bucket AS INTEGER) < ?").bind(Math.floor(Date.now() / 60000) - 60),
  ]);
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
