import type { Auth, Ctx } from "../env";
import { HireError } from "../errors";
import type { Op } from "../registry";
import { candidateApplicationOps, recruiterApplicationOps, sharedApplicationOps } from "./applications";
import { candidateSearchOps, profileOps } from "./candidates";
import { publicJobOps, recruiterJobOps } from "./jobs";
import { subscriptionOps } from "./subscriptions";

export const OPS: Op[] = [
  ...profileOps,
  ...publicJobOps,
  ...subscriptionOps,
  ...candidateApplicationOps,
  ...recruiterJobOps,
  ...candidateSearchOps,
  ...recruiterApplicationOps,
  ...sharedApplicationOps,
];

function allowed(op: Op, auth: Auth): boolean {
  return op.scopes.length === 0 || op.scopes.some((s) => auth.scopes.has(s));
}

export function requireScope(op: Op, auth: Auth): void {
  if (!allowed(op, auth)) {
    throw new HireError(
      "forbidden_scope",
      `这个令牌没有调用 ${op.name} 的权限，需要范围 ${op.scopes.join(" 或 ")}。换一个带这个范围的令牌，不要重试。`,
      { required: op.scopes, granted: [...auth.scopes] },
    );
  }
}

/** 工具列表只列这个令牌能调的。 */
export function opsFor(auth: Auth): Op[] {
  return OPS.filter((op) => allowed(op, auth));
}

const ACTIVE_STEP_MS = 3600 * 1000;
/** 定时拉事件和查限额不算活跃，不然挂着轮询就永远“刚刚活跃”。 */
const PASSIVE_OPS = ["events_poll", "quota_get"];

/** 记下这个账号最近一次主动操作的时间。一小时内只写一次。 */
export async function touchActive(ctx: Ctx, op: Op): Promise<void> {
  if (!ctx.auth.role || PASSIVE_OPS.includes(op.name)) return;
  const now = new Date();
  const stale = new Date(now.getTime() - ACTIVE_STEP_MS).toISOString();
  const sql =
    ctx.auth.role === "candidate"
      ? "UPDATE candidates SET active_at = ? WHERE account_id = ? AND (active_at IS NULL OR active_at < ?)"
      : "UPDATE companies SET active_at = ? WHERE owner_account_id = ? AND (active_at IS NULL OR active_at < ?)";
  await ctx.db.prepare(sql).bind(now.toISOString(), ctx.auth.accountId, stale).run();
}
