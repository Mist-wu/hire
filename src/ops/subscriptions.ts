import type { Ctx } from "../env";
import { invalid, notFound } from "../errors";
import { defineOp } from "../registry";
import { EmptyInput, type JobFilters, SubscriptionCreateInput, SubscriptionDeleteInput } from "../schemas";
import type { Where } from "../search";
import { newId, nowIso, parseJson } from "../util";
import { addJobFilters, checkSalaryPair } from "./jobs";

const MAX_SUBSCRIPTIONS = 5;
const MATCHES_PER_POLL = 20;

interface SubRow {
  id: string;
  account_id: string;
  name: string;
  filters: string;
  cursor_at: string;
  created_at: string;
}

function toApi(row: SubRow) {
  return { id: row.id, name: row.name, filters: parseJson<JobFilters>(row.filters, {}), created_at: row.created_at };
}

/**
 * 把订阅创建之后新发布、又符合条件的岗位写成事件。在拉取事件时才算，
 * 所以发布岗位不用遍历所有人的订阅。cursor_at 记着算到哪了，也用来防止并发时重复写。
 */
export async function deliverMatches(ctx: Ctx): Promise<void> {
  const { results: subs } = await ctx.db
    .prepare("SELECT * FROM subscriptions WHERE account_id = ? ORDER BY created_at")
    .bind(ctx.auth.accountId)
    .all<SubRow>();
  for (const sub of subs) {
    const where: Where = { clauses: ["j.status = 'open'", "j.created_at > ?"], params: [sub.cursor_at] };
    addJobFilters(where, parseJson<JobFilters>(sub.filters, {}));
    const { results: jobs } = await ctx.db
      .prepare(
        `SELECT j.id, j.title, j.created_at, c.name AS company_name
         FROM jobs j JOIN companies c ON c.id = j.company_id
         WHERE ${where.clauses.join(" AND ")} ORDER BY j.created_at, j.id LIMIT ?`,
      )
      .bind(...where.params, MATCHES_PER_POLL)
      .all<{ id: string; title: string; created_at: string; company_name: string }>();
    if (!jobs.length) continue;
    const now = nowIso();
    const guard = "WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND cursor_at = ?)";
    await ctx.db.batch([
      ...jobs.map((job) =>
        ctx.db
          .prepare(
            `INSERT INTO events (account_id, audience, type, application_id, payload, created_at)
             SELECT ?, 'candidate', 'job.matched', NULL, ?, ? ${guard}`,
          )
          .bind(
            sub.account_id,
            JSON.stringify({
              job_id: job.id,
              job_title: job.title,
              counterpart: job.company_name,
              subscription_id: sub.id,
              subscription_name: sub.name,
            }),
            now,
            sub.id,
            sub.cursor_at,
          ),
      ),
      ctx.db
        .prepare("UPDATE subscriptions SET cursor_at = ? WHERE id = ? AND cursor_at = ?")
        .bind(jobs[jobs.length - 1]!.created_at, sub.id, sub.cursor_at),
    ]);
  }
}

export const subscriptionOps = [
  defineOp({
    name: "subscription_create",
    title: "订阅岗位搜索",
    description:
      "求职者保存一组搜索条件。之后有新发布的岗位符合条件时，events_poll 里会出现一条 job.matched 事件，不用反复搜索。只对订阅之后发布的岗位生效。最多 5 个订阅。",
    method: "POST",
    path: "/subscriptions",
    scopes: ["candidate:write"],
    readOnly: false,
    input: SubscriptionCreateInput,
    handler: async (ctx, input) => {
      const filters = Object.fromEntries(Object.entries(input.filters).filter(([, v]) => v !== undefined));
      if (!Object.keys(filters).length) {
        throw invalid([{ field: "filters", message: "至少传一个搜索条件。" }]);
      }
      checkSalaryPair(input.filters);
      const count = await ctx.db
        .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE account_id = ?")
        .bind(ctx.auth.accountId)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_SUBSCRIPTIONS) {
        throw invalid(
          [{ field: "name", message: `最多 ${MAX_SUBSCRIPTIONS} 个订阅。` }],
          `订阅已达上限 ${MAX_SUBSCRIPTIONS} 个。先用 subscription_delete 删掉一个。`,
        );
      }
      const row: SubRow = {
        id: newId("sub"),
        account_id: ctx.auth.accountId,
        name: input.name,
        filters: JSON.stringify(filters),
        cursor_at: nowIso(),
        created_at: nowIso(),
      };
      await ctx.db
        .prepare("INSERT INTO subscriptions (id, account_id, name, filters, cursor_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.account_id, row.name, row.filters, row.cursor_at, row.created_at)
        .run();
      return { subscription: toApi(row) };
    },
  }),

  defineOp({
    name: "subscriptions_list",
    title: "查看我的订阅",
    description: "求职者列出自己保存的全部订阅和各自的搜索条件。",
    method: "GET",
    path: "/subscriptions",
    scopes: ["candidate:read"],
    readOnly: true,
    input: EmptyInput,
    handler: async (ctx) => {
      const { results } = await ctx.db
        .prepare("SELECT * FROM subscriptions WHERE account_id = ? ORDER BY created_at")
        .bind(ctx.auth.accountId)
        .all<SubRow>();
      return { subscriptions: results.map(toApi) };
    },
  }),

  defineOp({
    name: "subscription_delete",
    title: "删除订阅",
    description: "求职者删除一个订阅。之后不再收到它的 job.matched 事件。",
    method: "POST",
    path: "/subscriptions/:subscription_id/delete",
    scopes: ["candidate:write"],
    readOnly: false,
    destructive: true,
    idempotent: true,
    input: SubscriptionDeleteInput,
    handler: async (ctx, input) => {
      const result = await ctx.db
        .prepare("DELETE FROM subscriptions WHERE id = ? AND account_id = ?")
        .bind(input.subscription_id, ctx.auth.accountId)
        .run();
      if (!result.meta.changes) throw notFound("订阅");
      return { deleted: input.subscription_id };
    },
  }),
];
