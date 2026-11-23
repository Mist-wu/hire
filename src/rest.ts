import type { Context, Hono } from "hono";
import { authenticate } from "./auth/tokens";
import type { Ctx, Env } from "./env";
import { HireError, invalid } from "./errors";
import { OPS, requireScope, touchActive } from "./ops";
import { resumePdfForApplication } from "./ops/applications";
import { loadCandidate, storePdf } from "./ops/candidates";
import type { Op } from "./registry";

type C = Context<{ Bindings: Env }>;

export async function makeCtx(c: C): Promise<Ctx> {
  return {
    env: c.env,
    db: c.env.DB,
    auth: await authenticate(c.env.DB, c.req.raw),
  };
}

/** 查询串都是字符串，按入参的类型转成数字、布尔和数组。 */
function coerceQuery(op: Op, queries: Record<string, string[]>): Record<string, unknown> {
  const props = op.inputSchema.properties ?? {};
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
  throw invalid([{ field: "(整体)", message: "不是合法的 JSON 对象" }], "请求体必须是一个 JSON 对象。");
}

/** PDF 上传除了 JSON 里放 base64，也接受 multipart（字段名 file）和直接发 PDF 内容。 */
async function uploadPdf(c: C, ctx: Ctx) {
  const type = c.req.header("Content-Type") ?? "";
  const filename = (name: string | undefined) => name?.trim().slice(0, 120) || "resume.pdf";
  if (type.includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw invalid([{ field: "file", message: "multipart 里要有一个名为 file 的文件字段。" }]);
    return storePdf(ctx, filename(file.name), new Uint8Array(await file.arrayBuffer()), "file");
  }
  return storePdf(ctx, filename(c.req.query("filename")), new Uint8Array(await c.req.arrayBuffer()), "(整体)");
}

export const PDF_DOWNLOADS = [
  {
    path: "/v1/me/resume/pdf",
    scope: "candidate:read",
    summary: "下载我的 PDF 简历",
    description: "求职者下载自己上传的 PDF。只有 REST，没有对应的 MCP 工具。",
    async file(ctx: Ctx) {
      const row = await loadCandidate(ctx.db, ctx.auth.accountId);
      if (!row?.pdf_key) throw new HireError("not_found", "你还没有上传过 PDF 简历。");
      return { key: row.pdf_key, filename: row.pdf_name ?? "resume.pdf" };
    },
  },
  {
    path: "/v1/applications/:application_id/resume.pdf",
    scope: "recruiter:read",
    summary: "下载求职者的 PDF 简历",
    description: "招聘者下载这条投递对应求职者的 PDF。投递必须是“已接受”“已发录用”或“已录用”。只有 REST，没有对应的 MCP 工具。",
    file: (ctx: Ctx, params: Record<string, string>) => resumePdfForApplication(ctx, params.application_id!),
  },
] as const;

export function mountRest(app: Hono<{ Bindings: Env }>): void {
  for (const { path, scope, file } of PDF_DOWNLOADS) {
    app.get(path, async (c) => {
      const ctx = await makeCtx(c);
      if (!ctx.auth.scopes.has(scope)) {
        throw new HireError("forbidden_scope", `需要 ${scope} 范围。`, { required: [scope], granted: [...ctx.auth.scopes] });
      }
      const { key, filename } = await file(ctx, c.req.param());
      const object = await c.env.FILES.get(key);
      if (!object) throw new HireError("not_found", "找不到这份 PDF。");
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "private, no-store",
        },
      });
    });
  }

  for (const op of OPS) {
    app.on(op.method, `/v1${op.path}`, async (c) => {
      const ctx = await makeCtx(c);
      requireScope(op, ctx.auth);
      let result;
      if (op.name === "resume_upload" && !(c.req.header("Content-Type") ?? "").includes("application/json")) {
        result = await uploadPdf(c, ctx);
      } else {
        const raw = op.method === "GET" ? coerceQuery(op, c.req.queries()) : await jsonBody(c);
        result = await op.handler(ctx, { ...raw, ...c.req.param() });
      }
      await touchActive(ctx, op);
      return c.json(result);
    });
  }
}
