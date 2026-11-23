import * as z from "zod";
import type { Ctx, Role, Scope } from "./env";

export interface Op {
  /** MCP 工具名 */
  name: string;
  title: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  /** REST 路径，写在 /v1 之后。路径参数名与入参字段同名 */
  path: string;
  /** 有其中任意一个范围即可调用。空数组表示任何令牌都行 */
  scopes: Scope[];
  readOnly: boolean;
  /** 整体不是只读，但对这些身份是只读 */
  readOnlyFor?: Role[];
  idempotent?: boolean;
  destructive?: boolean;
  input: z.ZodType;
  handler: (ctx: Ctx, input: any) => Promise<unknown>;
}

export function defineOp<S extends z.ZodType>(
  def: Omit<Op, "input" | "handler"> & { input: S; handler: (ctx: Ctx, input: z.infer<S>) => Promise<unknown> },
): Op {
  return def;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

const schemaCache = new Map<string, JsonSchema>();

/** 入参的 JSON Schema。MCP 工具定义、OpenAPI 和 REST 查询串转换共用 */
export function inputSchema(op: Op): JsonSchema {
  let schema = schemaCache.get(op.name);
  if (!schema) {
    schema = z.toJSONSchema(op.input) as JsonSchema;
    delete schema.$schema;
    schemaCache.set(op.name, schema);
  }
  return schema;
}
