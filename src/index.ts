import { Hono } from "hono";
import { cors } from "hono/cors";
import { oauth } from "./auth/oauth";
import type { Env } from "./env";
import { HireError } from "./errors";
import { handleMcp } from "./mcp";
import { openapi } from "./openapi";
import { OPS } from "./ops";
import { expireStale } from "./ops/applications";
import { mountRest } from "./rest";
import { nowIso } from "./util";

const app = new Hono<{ Bindings: Env }>();

// 浏览器直接打开 JSON 时，没有 charset 会按系统的旧编码猜，中文变成乱码。
app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Content-Type")?.toLowerCase() === "application/json") {
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set("Content-Type", "application/json; charset=utf-8");
  }
});

const open = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version", "Mcp-Session-Id"],
  exposeHeaders: ["WWW-Authenticate"],
  maxAge: 86400,
});
for (const path of ["/v1/*", "/mcp", "/.well-known/*", "/oauth/token", "/oauth/register", "/oauth/device/code", "/oauth/revoke"]) {
  app.use(path, open);
}

app.onError((err, c) => {
  if (err instanceof HireError) {
    if (err.code === "unauthorized") {
      const origin = new URL(c.req.url).origin;
      c.header("WWW-Authenticate", `Bearer realm="hire", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    }
    return c.json(err.toJSON(), err.status);
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
    mcp: `${origin}/mcp`,
    rest: `${origin}/v1`,
    openapi: `${origin}/v1/openapi.json`,
    oauth_metadata: `${origin}/.well-known/oauth-authorization-server`,
    tools: OPS.map((op) => op.name),
    source: "https://github.com/Mist-wu/hire",
  });
});

app.get("/v1/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));

app.route("/", oauth);

mountRest(app);

app.all("/mcp", handleMcp);

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
    ctx.waitUntil(cleanup(env).then(() => expireStale(env.DB)));
  },
} satisfies ExportedHandler<Env>;
