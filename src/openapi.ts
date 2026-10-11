import { SCOPES } from "./env";
import { OPS } from "./ops";
import { inputSchema } from "./rest";

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
      security: [{ bearer: op.scopes }],
      "x-readonly": op.readOnly,
      responses: {
        "200": { description: "成功", content: { "application/json": { schema: { type: "object" } } } },
        default: { description: "出错", content: { "application/json": { schema: ERROR_SCHEMA } } },
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
      operation.requestBody = {
        required: required.size > 0,
        content: {
          "application/json": {
            schema: { type: "object", properties: props, required: [...required], additionalProperties: false },
          },
        },
      };
    }
    if (parameters.length) operation.parameters = parameters;
    const path = `/v1${op.path.replace(/:(\w+)/g, "{$1}")}`;
    (paths[path] ??= {})[op.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "hire",
      version: "0.1.0",
      description: "给 AI agent 用的招聘平台。每个操作同时是一个 MCP 工具，工具名就是 operationId。",
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
