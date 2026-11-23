import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, CANDIDATE, RECRUITER, api, internJob, login, profile, unique } from "./helpers";

const db = (env as any).DB as D1Database;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newSeeker() {
  const token = await login(unique("seeker"), CANDIDATE);
  await api("PATCH", "/me/profile", token, profile);
  return token;
}

async function newRecruiter(prefix: string) {
  const hr = await login(unique("hr"), RECRUITER);
  const company = (await api("PUT", "/company", hr, { name: unique(prefix) })).data.company;
  return { hr, company };
}

/** 直接往库里塞一条投递，用来造出大量或遗留的投递。 */
function insertApp(jobId: string, status: string) {
  const id = unique("app");
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO applications (id, job_id, candidate_id, initiated_by, status, rev, created_at, updated_at)
       VALUES (?, ?, ?, 'candidate', ?, 'r', ?, ?)`,
    )
    .bind(id, jobId, unique("cand"), status, now, now);
}

describe("关闭岗位", () => {
  it("一次关掉超过 20 条投递，日志和事件一条不少；已关闭的岗位再调一次会补上遗留的投递", async () => {
    const { hr, company } = await newRecruiter("关闭公司");
    const job = (await api("POST", "/jobs", hr, internJob)).data.job;
    const statuses = ["applied", "viewed", "invited"];
    await db.batch([...Array.from({ length: 25 }, (_, i) => insertApp(job.id, statuses[i % 3]!)), insertApp(job.id, "accepted")]);

    const closed = await api("POST", `/jobs/${job.id}/close`, hr, { note: "招满了" });
    expect(closed.data).toMatchObject({ closed_applications: 25, job: { status: "closed" } });
    const count = async (sql: string) => (await db.prepare(sql).bind(job.id).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM applications WHERE job_id = ? AND status = 'closed'")).toBe(25);
    expect(await count("SELECT COUNT(*) AS n FROM applications WHERE job_id = ? AND status = 'accepted'")).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM application_logs l JOIN applications a ON a.id = l.application_id WHERE a.job_id = ? AND l.to_status = 'closed'",
      ),
    ).toBe(25);
    const event = await db
      .prepare(
        "SELECT e.payload FROM events e JOIN applications a ON a.id = e.application_id WHERE a.job_id = ? AND e.type = 'application.closed'",
      )
      .bind(job.id)
      .all<{ payload: string }>();
    expect(event.results).toHaveLength(25);
    expect(JSON.parse(event.results[0]!.payload)).toEqual({
      job_id: job.id,
      job_title: job.title,
      counterpart: company.name,
      status: "closed",
      note: "招满了",
    });

    const updatedAt = (await db.prepare("SELECT updated_at FROM jobs WHERE id = ?").bind(job.id).first<{ updated_at: string }>())!
      .updated_at;
    await insertApp(job.id, "applied").run();
    const retried = await api("POST", `/jobs/${job.id}/close`, hr, {});
    expect(retried.data.closed_applications).toBe(1);
    expect(retried.data.job.updated_at).toBe(updatedAt);
    expect((await api("POST", `/jobs/${job.id}/close`, hr, {})).data.closed_applications).toBe(0);
  });

  it("和关闭同时进行的修改不会把岗位重新打开，同时投进来的投递也会被关掉", async () => {
    const { hr } = await newRecruiter("并发关闭");
    for (let i = 0; i < 4; i++) {
      const job = (await api("POST", "/jobs", hr, internJob)).data.job;
      const seekers = [await newSeeker(), await newSeeker()];
      const results = await Promise.all([
        api("PATCH", `/jobs/${job.id}`, hr, { title: `改过的标题 ${i}` }),
        ...seekers.map((s) => api("POST", "/applications", s, { job_id: job.id })),
        api("POST", `/jobs/${job.id}/close`, hr, {}),
      ]);
      for (const r of results) expect([200, 409, 422]).toContain(r.status);
      const row = await db
        .prepare(
          `SELECT j.status, (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status IN ('applied', 'viewed', 'invited')) AS pending
           FROM jobs j WHERE j.id = ?`,
        )
        .bind(job.id)
        .first<{ status: string; pending: number }>();
      expect(row).toEqual({ status: "closed", pending: 0 });
    }
  });
});

describe("公司改名", () => {
  it("超过 20 个岗位的搜索文本在同一个事务里改完，和单独修改岗位算出来的一样", async () => {
    const { hr } = await newRecruiter("旧名公司");
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push((await api("POST", "/jobs", hr, { ...internJob, title: `岗位 ${i}`, bonus: i % 2 ? "有加分" : undefined })).data.job.id);
    const name = unique("新名公司");
    expect((await api("PUT", "/company", hr, { name })).status).toBe(200);
    const hits = await db
      .prepare(`SELECT COUNT(*) AS n FROM jobs_fts WHERE job_id IN (${ids.map(() => "?").join(",")}) AND body LIKE ?`)
      .bind(...ids, `%${name}%`)
      .first<{ n: number }>();
    expect(hits!.n).toBe(21);

    const text = (id: string) => db.prepare("SELECT search_text FROM jobs WHERE id = ?").bind(id).first<{ search_text: string }>();
    for (const id of [ids[0]!, ids[1]!]) {
      const bySql = (await text(id))!.search_text;
      await api("PATCH", `/jobs/${id}`, hr, { headcount: 3 });
      expect((await text(id))!.search_text).toBe(bySql);
    }
  });
});

describe("订阅", () => {
  it("同一时刻开放的岗位翻页时不漏；事件清理后重开也不再通知；并发拉取不重复", async () => {
    const { hr, company } = await newRecruiter("同刻公司");
    const token = await newSeeker();
    await api("POST", "/subscriptions", token, { name: "公司", filters: { company_id: company.id } });
    await pause(5);
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push((await api("POST", "/jobs", hr, { ...internJob, title: `同刻 ${i}` })).data.job.id);
    const same = new Date(Date.now() + 1000).toISOString();
    await db.prepare(`UPDATE jobs SET opened_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(same, ...ids).run();

    const [a, b] = await Promise.all([api("GET", "/events", token), api("GET", "/events", token)]);
    const c = await api("GET", "/events", token);
    const d = await api("GET", "/events", token);
    const matched = [a, b, c, d].flatMap((r) => r.data.events).filter((e: any) => e.type === "job.matched");
    expect(new Set(matched.map((e: any) => e.job_id))).toEqual(new Set(ids));
    // 两次同时拉取可能返回同一批事件，但库里每个岗位只写了一条
    const written = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE type = 'job.matched'
         AND json_extract(payload, '$.job_id') IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(...ids)
      .first<{ n: number }>();
    expect(written!.n).toBe(21);

    // 定时任务清掉了旧事件，岗位暂停后重开，仍然不重复通知
    await db.prepare("DELETE FROM events WHERE type = 'job.matched' AND json_extract(payload, '$.job_id') = ?").bind(ids[0]).run();
    await api("PATCH", `/jobs/${ids[0]}`, hr, { status: "paused" });
    await api("PATCH", `/jobs/${ids[0]}`, hr, { status: "open" });
    expect((await api("GET", "/events", token)).data.events).toHaveLength(0);
  });

  it("相同条件同时创建只成功一次，键的顺序不影响", async () => {
    const token = await newSeeker();
    const results = await Promise.all([
      api("POST", "/subscriptions", token, { name: "一", filters: { city: "北京", recruit_type: "intern_daily" } }),
      api("POST", "/subscriptions", token, { name: "二", filters: { recruit_type: "intern_daily", city: "北京市" } }),
      api("POST", "/subscriptions", token, { name: "三", filters: { recruit_type: "intern_daily", city: "北京" } }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 200)) expect(r.data.error.details.fields[0].field).toBe("filters");
    expect((await api("GET", "/subscriptions", token)).data.subscriptions).toHaveLength(1);
  });
});

describe("PDF 上传", () => {
  it("三种上传方式出错时，报的是各自的字段", async () => {
    const token = await newSeeker();
    const put = (body: BodyInit, type?: string) =>
      SELF.fetch(`${BASE}/v1/me/resume/pdf`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, ...(type ? { "Content-Type": type } : {}) },
        body,
      }).then((r) => r.json<any>());
    const field = (data: any) => data.error.details.fields[0].field;
    expect(field(await put(JSON.stringify({ filename: "a.pdf", content_base64: btoa("hello") }), "application/json"))).toBe("content_base64");
    const form = new FormData();
    form.append("file", new File(["hello"], "a.pdf"));
    expect(field(await put(form))).toBe("file");
    expect(field(await put("hello", "application/pdf"))).toBe("(整体)");
  });
});

describe("查询计划", () => {
  // 公开搜索按创建时间倒序翻页，要直接走索引，不能临时排序
  const searches = [
    {
      sql: `SELECT j.*, c.name AS company_name, c.active_at AS recruiter_active_at
            FROM jobs j JOIN companies c ON c.id = j.company_id
            WHERE j.status = 'open' AND (j.deadline IS NULL OR j.deadline >= ?)`,
      params: ["2026-01-01"],
      time: "j.created_at",
      key: "j.id",
    },
    {
      sql: "SELECT c.* FROM candidates c WHERE c.resume_public = 1 AND c.name IS NOT NULL",
      params: [],
      time: "c.created_at",
      key: "c.account_id",
    },
  ];
  for (const s of searches) {
    for (const page of ["首页", "翻页"]) {
      it(`${s.time.split(".")[0] === "j" ? "岗位" : "求职者"}${page}不需要临时排序`, async () => {
        let sql = s.sql;
        const params: unknown[] = [...s.params];
        if (page === "翻页") {
          sql += ` AND (${s.time} < ? OR (${s.time} = ? AND ${s.key} < ?))`;
          params.push("2026-01-01", "2026-01-01", "cursor-id");
        }
        sql += ` ORDER BY ${s.time} DESC, ${s.key} DESC LIMIT ?`;
        const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params, 21).all<{ detail: string }>();
        expect(results.length).toBeGreaterThan(0);
        expect(results.map((r) => r.detail).filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
      });
    }
  }
});
