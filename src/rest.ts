import type { Context, Hono } from "hono";
import { z } from "zod";
import { authenticate } from "./auth/tokens";
import type { Ctx, Env } from "./env";
import { HireError, invalid } from "./errors";
import { OPS, requireScope } from "./ops";
import { storePdf } from "./ops/candidates";
import type { Op } from "./registry";
import { parseInput } from "./schemas";

type C = Context<{ Bindings: Env }>;

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

const schemaCache = new Map<string, JsonSchema>();

export function inputSchema(op: Op): JsonSchema {
  let schema = schemaCache.get(op.name);
  if (!schema) {
    schema = z.toJSONSchema(op.input) as JsonSchema;
    delete schema.$schema;
    schemaCache.set(op.name, schema);
  }
  return schema;
}

export async function makeCtx(c: C): Promise<Ctx> {
  return {
    env: c.env,
    db: c.env.DB,
    auth: await authenticate(c.env.DB, c.req.raw),
    origin: new URL(c.req.url).origin,
  };
}

/** 查询串都是字符串，按入参的类型转成数字、布尔和数组。 */
function coerceQuery(op: Op, queries: Record<string, string[]>): Record<string, unknown> {
  const props = inputSchema(op).properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(queries)) {
    const type = props[key]?.type;
    const first = values[0] ?? "";
    if (type === "integer" || type === "number") out[key] = first === "" || Number.isNaN(Number(first)) ? first : Number(first);
    else if (type === "boolean") out[key] = first === "true" || first === "1" ? true : first === "false" || first === "0" ? false : first;
    else if (type === "array") out[key] = values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    else out[key] = first;
  }
  return out;
}

async function jsonBody(c: C): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {}
  throw new HireError("validation_failed", "请求体必须是一个 JSON 对象。", {
    fields: [{ field: "(整体)", message: "不是合法的 JSON 对象" }],
  });
}

/** PDF 上传除了 JSON 里放 base64，也接受 multipart（字段名 file）和直接发 PDF 内容。 */
async function uploadPdf(c: C, ctx: Ctx) {
  const type = c.req.header("Content-Type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw invalid([{ field: "file", message: "multipart 里要有一个名为 file 的文件字段。" }]);
    return storePdf(ctx, file.name || "resume.pdf", new Uint8Array(await file.arrayBuffer()));
  }
  const name = c.req.query("filename") || "resume.pdf";
  return storePdf(ctx, name.slice(0, 120), new Uint8Array(await c.req.arrayBuffer()));
}

export function mountRest(app: Hono<{ Bindings: Env }>): void {
  for (const op of OPS) {
    app.on(op.method, `/v1${op.path}`, async (c) => {
      const ctx = await makeCtx(c);
      requireScope(op, ctx.auth);
      if (op.name === "resume_upload" && !(c.req.header("Content-Type") ?? "").includes("application/json")) {
        return c.json(await uploadPdf(c, ctx));
      }
      const raw = op.method === "GET" ? coerceQuery(op, c.req.queries()) : await jsonBody(c);
      const input = parseInput(op.input, { ...raw, ...c.req.param() });
      return c.json((await op.handler(ctx, input)) as object);
    });
  }
}
