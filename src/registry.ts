import * as z from "zod";
import type { Ctx, Role, Scope } from "./env";
import { parseInput } from "./schemas";

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
  inputSchema: JsonSchema;
  handler: (ctx: Ctx, raw: unknown) => Promise<Record<string, unknown>>;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

export function defineOp<S extends z.ZodType>(
  { input, handler, ...metadata }: Omit<Op, "inputSchema" | "handler"> & {
    input: S;
    handler: (ctx: Ctx, input: z.infer<S>) => Promise<Record<string, unknown>>;
  },
): Op {
  let schema: JsonSchema | undefined;
  return {
    ...metadata,
    get inputSchema() {
      if (!schema) {
        schema = z.toJSONSchema(input) as JsonSchema;
        delete schema.$schema;
      }
      return schema;
    },
    handler: (ctx, raw) => handler(ctx, parseInput(input, raw)),
  };
}
