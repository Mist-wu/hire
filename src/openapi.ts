import pkg from "../package.json";
import { SCOPES, type Scope } from "./env";
import { OPS } from "./ops";
import { inputSchema } from "./registry";

const ERROR_SCHEMA = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object" } },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};
const ERROR_RESPONSE = { description: "出错", content: { "application/json": { schema: ERROR_SCHEMA } } };

/** OpenAPI 里同一条安全要求中的范围要全部具备，所以“有其中任意一个即可”要拆成多条。 */
function security(scopes: Scope[]) {
  return scopes.length ? scopes.map((s) => ({ bearer: [s] })) : [{ bearer: [] }];
}

function pdfDownload(summary: string, description: string, scope: Scope, parameters: unknown[] = []) {
  return {
    summary,
    description,
    security: security([scope]),
    ...(parameters.length ? { parameters } : {}),
    responses: {
      "200": { description: "PDF 文件", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
      default: ERROR_RESPONSE,
    },
  };
}

export function openapi(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    const schema = inputSchema(op);
    const props = { ...(schema.properties ?? {}) };
    const required = new Set(schema.required ?? []);
    const pathParams = [...op.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
    const parameters: unknown[] = pathParams.map((name) => {
      const paramSchema = props[name] ?? { type: "string" };
      delete props[name];
      required.delete(name);
      return { name, in: "path", required: true, schema: paramSchema };
    });
    const operation: Record<string, unknown> = {
      operationId: op.name,
      summary: op.title,
      description: op.description,
      security: security(op.scopes),
      "x-readonly": op.readOnly,
      responses: {
        "200": { description: "成功", content: { "application/json": { schema: { type: "object" } } } },
        default: ERROR_RESPONSE,
      },
    };
    if (op.method === "GET") {
      for (const [name, propSchema] of Object.entries(props)) {
        parameters.push({
          name,
          in: "query",
          required: required.has(name),
          schema: propSchema,
          ...(propSchema.type === "array" ? { style: "form", explode: false } : {}),
        });
      }
    } else if (Object.keys(props).length) {
      const content: Record<string, unknown> = {
        "application/json": {
          schema: { type: "object", properties: props, required: [...required], additionalProperties: false },
        },
      };
      if (op.name === "resume_upload") {
        content["multipart/form-data"] = {
          schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
        };
        content["application/pdf"] = { schema: { type: "string", format: "binary" } };
        parameters.push({
          name: "filename",
          in: "query",
          required: false,
          description: "直接发送 PDF 内容时的文件名",
          schema: { type: "string", maxLength: 120 },
        });
      }
      operation.requestBody = { required: required.size > 0, content };
    }
    if (parameters.length) operation.parameters = parameters;
    const path = `/v1${op.path.replace(/:(\w+)/g, "{$1}")}`;
    (paths[path] ??= {})[op.method.toLowerCase()] = operation;
  }

  (paths["/v1/me/resume/pdf"] ??= {}).get = pdfDownload(
    "下载我的 PDF 简历",
    "求职者下载自己上传的 PDF。只有 REST，没有对应的 MCP 工具。",
    "candidate:read",
  );
  (paths["/v1/applications/{application_id}/resume.pdf"] ??= {}).get = pdfDownload(
    "下载求职者的 PDF 简历",
    "招聘者下载这条投递对应求职者的 PDF。投递必须是“已接受”“已发录用”或“已录用”。只有 REST，没有对应的 MCP 工具。",
    "recruiter:read",
    [{ name: "application_id", in: "path", required: true, schema: { type: "string" } }],
  );

  return {
    openapi: "3.1.0",
    info: {
      title: "hire",
      version: pkg.version,
      description: "给 AI agent 用的招聘平台。有对应 MCP 工具的操作，operationId 就是工具名。",
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearer: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${origin}/oauth/authorize`,
              tokenUrl: `${origin}/oauth/token`,
              scopes: Object.fromEntries(SCOPES.map((s) => [s, s])),
            },
          },
        },
      },
    },
    paths,
  };
}
