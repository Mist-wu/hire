import type { Context } from "hono";
import type { Env, Role } from "./env";
import { HireError } from "./errors";
import { OPS, opsFor, requireScope } from "./ops";
import { inputSchema, makeCtx } from "./rest";
import { parseInput } from "./schemas";

type C = Context<{ Bindings: Env }>;

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "hire", title: "hire 招聘平台", version: "0.1.0" };

const INSTRUCTIONS = `hire 是给 AI agent 用的招聘平台，没有网页。你代表一位求职者或招聘者操作。
求职者：先 profile_get 看资料，缺什么用 profile_update 补；用 jobs_search 按硬条件过滤，再用 job_get 读详情自己判断；application_create 投递。
招聘者：先 company_get，没有公司就 company_upsert；job_create 发岗位；job_applications_list 和 application_get 看投递；invitation_create 发邀约。
双方用 events_poll 了解进展，有未结束的投递时每 10 分钟一次即可。
投递、回应邀约、发邀约、拒绝、关闭岗位都会被对方看到且不能撤销，执行前先让用户确认。
简历里只写用户确认过的事实。遇到 quota_exceeded 就停下，不要重试。`;

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolDef(op: (typeof OPS)[number]) {
  return {
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: inputSchema(op),
    annotations: {
      title: op.title,
      readOnlyHint: op.readOnly,
      destructiveHint: op.readOnly ? false : (op.destructive ?? false),
      idempotentHint: op.readOnly ? true : (op.idempotent ?? false),
      openWorldHint: false,
    },
  };
}

export function unauthorized(c: C, err: HireError): Response {
  const origin = new URL(c.req.url).origin;
  return c.json(err.toJSON(), 401, {
    "WWW-Authenticate": `Bearer realm="hire", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
}

export async function handleMcp(c: C, role?: Role): Promise<Response> {
  if (c.req.method !== "POST") {
    // 无状态服务：不提供服务端推送的 GET 流，也没有会话可删
    return c.json(rpcError(null, -32000, "这个端点只接受 POST。"), 405, { Allow: "POST" });
  }
  let ctx;
  try {
    ctx = await makeCtx(c);
  } catch (err) {
    if (err instanceof HireError && err.code === "unauthorized") return unauthorized(c, err);
    throw err;
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "请求体不是合法的 JSON。"), 400);
  }

  const handle = async (req: RpcRequest): Promise<object | null> => {
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return rpcError(req?.id, -32600, "不是合法的 JSON-RPC 2.0 请求。");
    }
    const isNotification = req.id === undefined;
    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: req.id, result });

    switch (req.method) {
      case "initialize": {
        const asked = req.params?.protocolVersion;
        const version = typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: opsFor(ctx.auth, role).map(toolDef) });
      case "tools/call": {
        const name = req.params?.name;
        const op = OPS.find((o) => o.name === name);
        const wrongRole = role && op && op.scopes.length > 0 && !op.scopes.some((s) => s.startsWith(`${role}:`));
        if (!op || wrongRole) {
          return rpcError(req.id, -32602, `没有名为 ${String(name)} 的工具。`);
        }
        try {
          requireScope(op, ctx.auth);
          const input = parseInput(op.input, req.params?.arguments ?? {});
          const result = (await op.handler(ctx, input)) as Record<string, unknown>;
          return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        } catch (err) {
          if (err instanceof HireError) {
            return ok({ content: [{ type: "text", text: JSON.stringify(err.toJSON()) }], isError: true });
          }
          console.error("tool failed", op.name, err);
          const internal = new HireError("internal", "服务端出错了。稍后再试一次；仍然失败就告诉用户。");
          return ok({ content: [{ type: "text", text: JSON.stringify(internal.toJSON()) }], isError: true });
        }
      }
      default:
        if (isNotification || req.method.startsWith("notifications/")) return null;
        return rpcError(req.id, -32601, `不支持的方法：${req.method}`);
    }
  };

  if (Array.isArray(payload)) {
    const responses = (await Promise.all(payload.map((item) => handle(item as RpcRequest)))).filter(Boolean);
    return responses.length ? c.json(responses) : c.body(null, 202);
  }
  const response = await handle(payload as RpcRequest);
  return response ? c.json(response) : c.body(null, 202);
}
