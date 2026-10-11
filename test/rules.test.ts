import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { BASE, CANDIDATE, RECRUITER, api, future, internJob, login, profile, setup, unique } from "./helpers";

describe("校验", () => {
  it("实习岗位必须填每周天数，社招不能填", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const noCompany = await api("POST", "/jobs", hr, internJob);
    expect(noCompany.status).toBe(422);
    await api("PUT", "/company", hr, { name: "校验公司" });

    const { days_per_week, ...missing } = internJob;
    const res = await api("POST", "/jobs", hr, missing);
    expect(res.status).toBe(422);
    expect(res.data.error.details.fields[0].field).toBe("days_per_week");

    const social = await api("POST", "/jobs", hr, { ...internJob, recruit_type: "social", experience: "1to3" });
    expect(social.data.error.details.fields.map((f: any) => f.field)).toEqual(["days_per_week", "min_months"]);

    const unknown = await api("POST", "/jobs", hr, { ...internJob, nope: 1 });
    expect(unknown.status).toBe(422);
    const badEnum = await api("POST", "/jobs", hr, { ...internJob, category: "tech.unknown" });
    expect(badEnum.status).toBe(422);
  });

  it("修改岗位只改传入的字段，并重新校验", async () => {
    const { hr, job } = await setup();
    const updated = await api("PATCH", `/jobs/${job.id}`, hr, { salary_max: 400, status: "paused" });
    expect(updated.data.job).toMatchObject({ salary_max: 400, salary_min: 200, status: "paused", title: internJob.title });
    const bad = await api("PATCH", `/jobs/${job.id}`, hr, { salary_max: 100 });
    expect(bad.status).toBe(422);
    const other = await login(unique("hr"), RECRUITER);
    expect((await api("PATCH", `/jobs/${job.id}`, other, { title: "改名" })).status).toBe(404);
  });

  it("资料不完整不能投递", async () => {
    const { job } = await setup();
    const seeker = await login(unique("seeker"), CANDIDATE);
    await api("PATCH", "/me/profile", seeker, { name: "只有名字" });
    const res = await api("POST", "/applications", seeker, { job_id: job.id });
    expect(res.status).toBe(422);
    expect(res.data.error.details.fields.map((f: any) => f.field)).toEqual(["school", "degree", "grad_year"]);
  });
});

describe("状态和限制", () => {
  it("不能重复投，撤回后 7 天内不能再投，终态不能再变", async () => {
    const { hr, seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const dup = await api("POST", "/applications", seeker, { job_id: job.id });
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe("duplicate_application");

    expect((await api("POST", `/applications/${appId}/respond`, seeker, { accept: false })).data.error.code).toBe("invalid_transition");
    const withdrawn = await api("POST", `/applications/${appId}/withdraw`, seeker, {});
    expect(withdrawn.data.application.status).toBe("withdrawn");

    const again = await api("POST", "/applications", seeker, { job_id: job.id });
    expect(again.data.error.details.retry_after).toBeTruthy();
    const invite = await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [future(1)] });
    expect(invite.data.error).toMatchObject({ code: "invalid_transition", details: { current_status: "withdrawn" } });
    expect((await api("POST", `/applications/${appId}/reject`, hr, {})).status).toBe(422);
    expect((await api("POST", `/applications/${appId}/reject`, hr, { reason: "other" })).status).toBe(409);
  });

  it("别人的投递看不到，也改不了", async () => {
    const { seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const stranger = await login(unique("x"), RECRUITER);
    const peer = await login(unique("x"), CANDIDATE);
    expect((await api("GET", `/applications/${appId}`, stranger)).status).toBe(404);
    expect((await api("POST", `/applications/${appId}/reject`, stranger, { reason: "other" })).status).toBe(404);
    expect((await api("POST", `/applications/${appId}/withdraw`, peer, {})).status).toBe(404);
    expect((await api("GET", `/applications/${appId}`, peer)).status).toBe(404);
  });

  it("每天投递有上限", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    await api("PUT", "/company", hr, { name: "限额公司" });
    const seeker = await login(unique("seeker"), CANDIDATE);
    await api("PATCH", "/me/profile", seeker, profile);
    for (let i = 0; i < 3; i++) {
      const job = (await api("POST", "/jobs", hr, { ...internJob, title: `岗位 ${i}` })).data.job;
      expect((await api("POST", "/applications", seeker, { job_id: job.id })).status).toBe(200);
    }
    const job = (await api("POST", "/jobs", hr, internJob)).data.job;
    const over = await api("POST", "/applications", seeker, { job_id: job.id });
    expect(over.status).toBe(429);
    expect(over.data.error).toMatchObject({ code: "quota_exceeded", details: { limit: 3 } });
    const quota = await api("GET", "/quota", seeker);
    expect(quota.data.applications).toMatchObject({ used: 3, remaining: 0 });
  });

  it("主动邀约每个岗位每天有上限", async () => {
    const { hr, job } = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const seeker = await login(unique("seeker"), CANDIDATE);
      const id = (await api("PATCH", "/me/profile", seeker, profile)).data.profile.id;
      const res = await api("POST", "/invitations", hr, { job_id: job.id, candidate_id: id, mode: "online", slots: [future(1)] });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("关闭岗位会结束未完成的投递", async () => {
    const { hr, seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const closed = await api("POST", `/jobs/${job.id}/close`, hr, { note: "已招满。" });
    expect(closed.data).toMatchObject({ closed_applications: 1, job: { status: "closed" } });
    const app = await api("GET", `/applications/${appId}`, seeker);
    expect(app.data.application).toMatchObject({ status: "closed", closed_by: "system" });
    const events = await api("GET", "/events", seeker);
    expect(events.data.events.at(-1)).toMatchObject({ type: "application.closed", note: "已招满。" });
    const other = await login(unique("seeker"), CANDIDATE);
    await api("PATCH", "/me/profile", other, profile);
    expect((await api("POST", "/applications", other, { job_id: job.id })).data.error.code).toBe("job_not_open");
    expect((await api("PATCH", `/jobs/${job.id}`, hr, { title: "x" })).data.error.code).toBe("job_not_open");
  });
});

describe("权限范围", () => {
  it("求职者令牌不能发岗位，只读令牌不能投递", async () => {
    const name = unique("both");
    const candidate = await login(name, CANDIDATE);
    const res = await api("POST", "/jobs", candidate, internJob);
    expect(res.status).toBe(403);
    expect(res.data.error).toMatchObject({ code: "forbidden_scope", details: { required: ["recruiter:write"] } });

    const readOnly = await login(name, "candidate:read");
    expect((await api("GET", "/me/profile", readOnly)).status).toBe(200);
    expect((await api("PATCH", "/me/profile", readOnly, { name: "x" })).status).toBe(403);
    expect((await api("GET", "/jobs?mine=true", readOnly)).status).toBe(403);
  });

  it("没有令牌返回 401 和资源元数据地址", async () => {
    const res = await api("GET", "/jobs", "bad-token");
    expect(res.status).toBe(401);
    expect(res.data.error.code).toBe("unauthorized");
  });

  it("一个账号只能有一种身份", async () => {
    const name = unique("solo");
    const hr = await login(name, RECRUITER);
    await api("PUT", "/company", hr, { name: unique("一人公司") });
    const res = await SELF.fetch(`${BASE}/oauth/dev/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: name, scope: CANDIDATE }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toBe("access_denied");
    const mixed = await SELF.fetch(`${BASE}/oauth/dev/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: unique("mixed"), scope: "candidate:read recruiter:read" }),
    });
    expect((await mixed.json<any>()).error).toBe("invalid_scope");
    // 招聘者碰不到求职者一侧的任何接口
    expect((await api("PATCH", "/me/profile", hr, profile)).status).toBe(403);
    expect((await api("POST", "/applications", hr, { job_id: "x" })).status).toBe(403);
  });
});

describe("搜索", () => {
  it("按硬条件和关键词过滤岗位", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const seeker = await login(unique("seeker"), CANDIDATE);
    const tag = unique("tag");
    const company = (await api("PUT", "/company", hr, { name: `搜索公司 ${tag}` })).data.company;
    const a = (await api("POST", "/jobs", hr, { ...internJob, title: "大模型应用开发实习生", category: "tech.llm_app", skills: ["Python", "Agent"] })).data.job;
    const b = (await api("POST", "/jobs", hr, { ...internJob, title: "游戏策划实习生", category: "product.game_design", cities: ["深圳"], days_per_week: 5, skills: ["Excel"] })).data.job;
    const c = (await api("POST", "/jobs", hr, {
      ...internJob, title: "后端开发工程师", recruit_type: "social", experience: "1to3", degree: "master",
      days_per_week: undefined, min_months: undefined, salary_min: 25, salary_max: 40, salary_unit: "k_per_month", remote: true,
    })).data.job;
    const ids = async (query: string) =>
      (await api("GET", `/jobs?company_id=${company.id}&${query}`, seeker)).data.jobs.map((j: any) => j.id).sort();

    expect(await ids("")).toEqual([a.id, b.id, c.id].sort());
    expect(await ids("city=深圳")).toEqual([b.id]);
    expect(await ids("category=tech")).toEqual([a.id, c.id].sort());
    expect(await ids("category=tech.llm_app")).toEqual([a.id]);
    expect(await ids("days_per_week_max=4")).toEqual([a.id]);
    expect(await ids("degree=bachelor")).toEqual([a.id, b.id].sort());
    expect(await ids("remote=true")).toEqual([c.id]);
    expect(await ids("salary_min=250&salary_unit=per_day")).toEqual([a.id, b.id].sort());
    expect(await ids("salary_min=30&salary_unit=k_per_month")).toEqual([c.id]);
    expect(await ids("skills=agent,excel")).toEqual([a.id, b.id].sort());
    expect(await ids("grad_year=2026")).toEqual([]);
    // 两个字走 LIKE，三个字以上走 trigram
    expect(await ids("q=策划")).toEqual([b.id]);
    expect(await ids("q=大模型应用")).toEqual([a.id]);
    expect(await ids("q=实习生 Python")).toEqual([a.id]);
    expect(await ids(`q=${tag}`)).toEqual([a.id, b.id, c.id].sort());
    expect((await api("GET", "/jobs?salary_min=30", seeker)).status).toBe(422);

    const page1 = await api("GET", `/jobs?company_id=${company.id}&limit=2`, seeker);
    expect(page1.data.jobs).toHaveLength(2);
    const page2 = await api("GET", `/jobs?company_id=${company.id}&limit=2&cursor=${page1.data.next_cursor}`, seeker);
    expect(page2.data.jobs).toHaveLength(1);
    expect(page2.data.next_cursor).toBeNull();

    await api("PATCH", `/jobs/${b.id}`, hr, { status: "paused" });
    expect(await ids("")).toEqual([a.id, c.id].sort());
    const mine = await api("GET", "/jobs?mine=true", hr);
    expect(mine.data.jobs).toHaveLength(3);
  });

  it("关闭公开后搜不到求职者", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const seeker = await login(unique("seeker"), CANDIDATE);
    const tag = unique("skill");
    const id = (await api("PATCH", "/me/profile", seeker, { ...profile, skills: [tag] })).data.profile.id;
    const search = () => api("GET", `/candidates?skills=${tag}`, hr);
    expect((await search()).data.candidates).toHaveLength(1);
    expect((await api("GET", `/candidates?q=邮电大学&skills=${tag}`, hr)).data.candidates).toHaveLength(1);
    await api("PATCH", "/me/profile", seeker, { resume_public: false });
    expect((await search()).data.candidates).toHaveLength(0);
    expect((await api("GET", `/candidates/${id}`, hr)).status).toBe(404);
  });
});
