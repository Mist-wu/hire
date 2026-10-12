import type { Ctx } from "../env";
import { invalid, notFound } from "../errors";
import { defineOp } from "../registry";
import { EmptyInput, type JobFilters, SubscriptionCreateInput, SubscriptionDeleteInput } from "../schemas";
import type { Where } from "../search";
import { newId, normCity, nowIso, parseJson } from "../util";
import { addJobFilters, addOpenFilter, checkSalaryPair } from "./jobs";

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

/** 存之前先归一化：去掉空值，城市别名统一，技能去重排序。这样换个写法的相同条件能认出来。 */
function normalizeFilters(input: JobFilters): JobFilters {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === "") continue;
    if (key === "city") out[key] = normCity(value as string);
    else if (key === "skills") {
      const skills = [...new Set(value as string[])].sort();
      if (skills.length) out[key] = skills;
    } else out[key] = value;
  }
  return out as JobFilters;
}

function sameFilters(a: object, b: object): boolean {
  const norm = (o: object) => JSON.stringify(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

function toApi(row: SubRow) {
  return { id: row.id, name: row.name, filters: parseJson<JobFilters>(row.filters, {}), created_at: row.created_at };
}

/**
 * 把订阅创建之后新开放、又符合条件的岗位写成事件。在拉取事件时才算，
 * 所以发布岗位不用遍历所有人的订阅。cursor_at 记着算到哪了，也用来防止并发时重复写。
 * 同一个岗位只通知一次，哪怕命中了几个订阅。返回值表示还有没推完的，调用方应该再拉一次。
 */
export async function deliverMatches(ctx: Ctx): Promise<boolean> {
  let more = false;
  const { results: subs } = await ctx.db
    .prepare("SELECT * FROM subscriptions WHERE account_id = ? ORDER BY created_at")
    .bind(ctx.auth.accountId)
    .all<SubRow>();
  for (const sub of subs) {
    // 按最近一次开放的时间算：暂停后重开的岗位也能补上
    const where: Where = { clauses: ["j.opened_at > ?"], params: [sub.cursor_at] };
    addOpenFilter(where);
    addJobFilters(where, parseJson<JobFilters>(sub.filters, {}));
    const { results: jobs } = await ctx.db
      .prepare(
        `SELECT j.id, j.title, j.opened_at, c.name AS company_name
         FROM jobs j JOIN companies c ON c.id = j.company_id
         WHERE ${where.clauses.join(" AND ")} ORDER BY j.opened_at, j.id LIMIT ?`,
      )
      .bind(...where.params, MATCHES_PER_POLL)
      .all<{ id: string; title: string; opened_at: string; company_name: string }>();
    if (!jobs.length) continue;
    if (jobs.length === MATCHES_PER_POLL) more = true;
    const now = nowIso();
    const guard = `WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = ? AND cursor_at = ?)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.account_id = ? AND e.type = 'job.matched'
                      AND json_extract(e.payload, '$.job_id') = ?)`;
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
            sub.account_id,
            job.id,
          ),
      ),
      ctx.db
        .prepare("UPDATE subscriptions SET cursor_at = ? WHERE id = ? AND cursor_at = ?")
        .bind(jobs[jobs.length - 1]!.opened_at, sub.id, sub.cursor_at),
    ]);
  }
  return more;
}

export const subscriptionOps = [
  defineOp({
    name: "subscription_create",
    title: "订阅岗位搜索",
    description:
      "求职者保存一组搜索条件。之后有新发布的岗位符合条件时，events_poll 里会出现一条 job.matched 事件，不用反复搜索。只对订阅之后发布或重新开放的岗位生效，同一个岗位只通知一次。最多 5 个订阅。",
    method: "POST",
    path: "/subscriptions",
    scopes: ["candidate:write"],
    readOnly: false,
    input: SubscriptionCreateInput,
    handler: async (ctx, input) => {
      const filters = normalizeFilters(input.filters);
      if (!Object.keys(filters).length) {
        throw invalid([{ field: "filters", message: "至少传一个搜索条件。" }]);
      }
      checkSalaryPair(input.filters);
      const { results: existing } = await ctx.db
        .prepare("SELECT * FROM subscriptions WHERE account_id = ?")
        .bind(ctx.auth.accountId)
        .all<SubRow>();
      const same = existing.find((row) => sameFilters(parseJson<JobFilters>(row.filters, {}), filters));
      if (same) {
        throw invalid(
          [{ field: "filters", message: `和已有的订阅“${same.name}”条件相同。` }],
          "已经有一个条件相同的订阅，不用再建。",
        );
      }
      const full = invalid(
        [{ field: "name", message: `最多 ${MAX_SUBSCRIPTIONS} 个订阅。` }],
        `订阅已达上限 ${MAX_SUBSCRIPTIONS} 个。先用 subscription_delete 删掉一个。`,
      );
      if (existing.length >= MAX_SUBSCRIPTIONS) throw full;
      const row: SubRow = {
        id: newId("sub"),
        account_id: ctx.auth.accountId,
        name: input.name,
        filters: JSON.stringify(filters),
        cursor_at: nowIso(),
        created_at: nowIso(),
      };
      // 上限写在插入语句里，并发创建也挤不过去
      const result = await ctx.db
        .prepare(
          `INSERT INTO subscriptions (id, account_id, name, filters, cursor_at, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE (SELECT COUNT(*) FROM subscriptions WHERE account_id = ?2) < ?7`,
        )
        .bind(row.id, row.account_id, row.name, row.filters, row.cursor_at, row.created_at, MAX_SUBSCRIPTIONS)
        .run();
      if (!result.meta.changes) throw full;
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
