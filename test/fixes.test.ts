import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { expireStale } from "../src/ops/applications";
import { CANDIDATE, RECRUITER, api, future, internJob, login, profile, setup, unique } from "./helpers";

const db = (env as any).DB as D1Database;

async function newSeeker() {
  const token = await login(unique("seeker"), CANDIDATE);
  const id = (await api("PATCH", "/me/profile", token, profile)).data.profile.id as string;
  return { token, id };
}

describe("限额和重复", () => {
  it("同时投很多个岗位也挤不过每日上限", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    await api("PUT", "/company", hr, { name: unique("并发公司") });
    const { token } = await newSeeker();
    const jobs: string[] = [];
    for (let i = 0; i < 6; i++) jobs.push((await api("POST", "/jobs", hr, { ...internJob, title: `并发 ${i}` })).data.job.id);
    const results = await Promise.all(jobs.map((job_id) => api("POST", "/applications", token, { job_id })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    // 没挤进去的不留下日志和事件
    expect((await api("GET", "/events", hr)).data.events).toHaveLength(3);
  });

  it("求职者拒绝后，招聘者 7 天内不能再邀约同一个人", async () => {
    const { hr, seeker, job, candidateId } = await setup();
    const invite = () => api("POST", "/invitations", hr, { job_id: job.id, candidate_id: candidateId, mode: "online", slots: [future(2)] });
    const first = await invite();
    await api("POST", `/applications/${first.data.application.id}/respond`, seeker, { accept: false });
    const again = await invite();
    expect(again.data.error).toMatchObject({ code: "duplicate_application" });
    expect(again.data.error.details.retry_after).toBeTruthy();
  });
});

describe("时间", () => {
  it("截止日期不能填过去；过期的岗位搜不到也不能投", async () => {
    const { hr, seeker, job } = await setup();
    expect((await api("POST", "/jobs", hr, { ...internJob, deadline: "2020-01-01" })).status).toBe(422);
    expect((await api("PATCH", `/jobs/${job.id}`, hr, { deadline: "2020-01-01" })).status).toBe(422);
    await db.prepare("UPDATE jobs SET deadline = '2020-01-01' WHERE id = ?").bind(job.id).run();
    expect((await api("GET", `/jobs?company_id=${job.company.id}`, seeker)).data.jobs).toHaveLength(0);
    expect((await api("GET", `/jobs/${job.id}`, seeker)).data.job.accepting).toBe(false);
    expect((await api("POST", "/applications", seeker, { job_id: job.id })).data.error.code).toBe("job_not_open");
    // 过期后改别的字段不受影响
    expect((await api("PATCH", `/jobs/${job.id}`, hr, { headcount: 2 })).status).toBe(200);
  });

  it("面试时间过了不能再接受；招聘者可以改时间", async () => {
    const { hr, seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const soon = new Date(Date.now() + 300).toISOString();
    await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [soon] });
    await new Promise((r) => setTimeout(r, 400));
    expect((await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot: soon })).status).toBe(422);

    const slot = future(3);
    const moved = await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [slot], note: "改到周五。" });
    expect(moved.data.application).toMatchObject({ status: "invited", invitation: { slots: [slot] } });
    expect((await api("GET", "/events", seeker)).data.events.at(-1)).toMatchObject({ type: "invitation.updated", note: "改到周五。" });
    expect((await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot })).status).toBe(200);
    // 约好之后也能改：回到“已邀约”，等对方重新选，这期间看不到联系方式
    const again = await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [future(4)] });
    expect(again.data.application).toMatchObject({ status: "invited", chosen_slot: null, contact: null });
  });

  it("线下面试要写地址，录用日期不能在过去", async () => {
    const { hr, seeker, job } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const slot = future(1);
    expect((await api("POST", "/invitations", hr, { application_id: appId, mode: "onsite", slots: [slot] })).data.error.details.fields[0].field).toBe("location");
    await api("POST", "/invitations", hr, { application_id: appId, mode: "onsite", slots: [slot], location: "西土城路 10 号" });
    await api("POST", `/applications/${appId}/respond`, seeker, { accept: true, slot });
    const bad = await api("POST", `/applications/${appId}/offer`, hr, { start_date: "2020-01-01", reply_by: "2020-01-01" });
    expect(bad.data.error.details.fields.map((f: any) => f.field)).toEqual(["start_date", "reply_by"]);
  });

  it("没人管的投递会过期", async () => {
    const { hr, seeker, job } = await setup();
    const stale = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const b = await newSeeker();
    const invited = (await api("POST", "/invitations", hr, { job_id: job.id, candidate_id: b.id, mode: "online", slots: [future(1)] })).data.application.id;
    const c = await newSeeker();
    const fresh = (await api("POST", "/applications", c.token, { job_id: job.id })).data.application.id;
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    await db.batch([
      db.prepare("UPDATE applications SET created_at = ? WHERE id = ?").bind(old, stale),
      db.prepare("UPDATE applications SET invitation = ? WHERE id = ?").bind(JSON.stringify({ mode: "online", slots: [old], location: null }), invited),
    ]);
    await api("GET", "/events", hr);
    expect(await expireStale(db)).toBe(2);
    expect(await expireStale(db)).toBe(0);

    const app = (await api("GET", `/applications/${stale}`, seeker)).data.application;
    expect(app).toMatchObject({ status: "closed", closed_by: "system" });
    expect(app.logs.at(-1).note).toContain("30 天");
    expect((await api("GET", `/applications/${fresh}`, c.token)).data.application.status).toBe("applied");
    expect((await api("GET", "/events", seeker)).data.events.at(-1).type).toBe("application.expired");
    expect((await api("GET", "/events", hr)).data.events.map((e: any) => e.type)).toEqual(["application.expired", "application.expired"]);
    // 过期不是被拒绝，可以马上再投
    expect((await api("POST", "/applications", seeker, { job_id: job.id })).status).toBe(200);
  });
});

describe("资料", () => {
  it("能清空可选字段，链接只接受 http 和 https", async () => {
    const { token } = await newSeeker();
    const cleared = await api("PATCH", "/me/profile", token, { phone: null, summary: null, major: null });
    expect(cleared.data.profile).toMatchObject({ phone: null, summary: null, major: null, email: "linxiao@example.com", name: "林晓" });
    expect((await api("PATCH", "/me/profile", token, { name: null })).status).toBe(422);
    expect((await api("PATCH", "/me/profile", token, { links: ["javascript:alert(1)"] })).status).toBe(422);
    expect((await api("PATCH", "/me/profile", token, { links: ["https://github.com/x"] })).status).toBe(200);
    const hr = await login(unique("hr"), RECRUITER);
    expect((await api("PUT", "/company", hr, { name: unique("链接公司"), website: "javascript:alert(1)" })).status).toBe(422);
    expect((await api("POST", "/jobs", hr, { ...internJob, questions: [{ text: "q", options: ["a", "a"] }] })).status).toBe(422);
  });

  it("删除资料会撤回未结束的投递，之后搜不到", async () => {
    const { hr, seeker, job, candidateId } = await setup();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id, custom_resume: { summary: "定制" } })).data.application.id;
    await api("POST", "/subscriptions", seeker, { name: "s", filters: { city: "北京" } });
    const gone = await api("POST", "/me/profile/delete", seeker);
    expect(gone.data).toEqual({ deleted: true, withdrawn_applications: 1 });
    expect((await api("GET", "/me/profile", seeker)).data.profile).toBeNull();
    expect((await api("GET", "/subscriptions", seeker)).data.subscriptions).toHaveLength(0);
    expect((await api("GET", `/candidates/${candidateId}`, hr)).status).toBe(404);
    const app = (await api("GET", `/applications/${appId}`, hr)).data.application;
    expect(app).toMatchObject({ status: "withdrawn", candidate: null, custom_resume: null, contact: null });
    expect((await api("GET", "/events", hr)).data.events.at(-1).type).toBe("application.withdrawn");
    expect((await api("POST", "/me/profile/delete", seeker)).data.deleted).toBe(false);
    // 删完可以重新填
    expect((await api("PATCH", "/me/profile", seeker, profile)).status).toBe(200);
  });

  it("公司不能重名，城市写“北京市”和“北京”一样", async () => {
    const name = unique("重名公司");
    const a = await login(unique("hr"), RECRUITER);
    const b = await login(unique("hr"), RECRUITER);
    expect((await api("PUT", "/company", a, { name })).status).toBe(200);
    expect((await api("PUT", "/company", b, { name: name.toUpperCase() })).status).toBe(422);
    expect((await api("PUT", "/company", a, { name, intro: "改简介不算重名。" })).status).toBe(200);

    const job = (await api("POST", "/jobs", a, { ...internJob, cities: ["北京市", "北京", "上海市"] })).data.job;
    expect(job.cities).toEqual(["北京", "上海"]);
    const { token } = await newSeeker();
    expect((await api("GET", `/jobs?company_id=${job.company.id}&city=北京市`, token)).data.jobs).toHaveLength(1);
    const me = (await api("PATCH", "/me/profile", token, { city: "深圳市", expectation: { cities: ["广州市"] } })).data.profile;
    expect(me).toMatchObject({ city: "深圳", expectation: { cities: ["广州"] } });
  });
});

describe("搜索和事件", () => {
  it("修改岗位不改变排位，翻页不漏", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const company = (await api("PUT", "/company", hr, { name: unique("排序公司") })).data.company;
    const titles = ["甲", "乙", "丙"];
    const ids: string[] = [];
    for (const title of titles) {
      ids.push((await api("POST", "/jobs", hr, { ...internJob, title })).data.job.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const { token } = await newSeeker();
    const page1 = await api("GET", `/jobs?company_id=${company.id}&limit=2`, token);
    expect(page1.data.jobs.map((j: any) => j.title)).toEqual(["丙", "乙"]);
    await api("PATCH", `/jobs/${ids[0]}`, hr, { headcount: 3 });
    await api("PATCH", `/jobs/${ids[1]}`, hr, { headcount: 3 });
    const page2 = await api("GET", `/jobs?company_id=${company.id}&limit=2&cursor=${page1.data.next_cursor}`, token);
    expect(page2.data.jobs.map((j: any) => j.title)).toEqual(["甲"]);
  });

  it("搜索结果标出投过的岗位和联系过的人；每周天数不滤掉全职岗位", async () => {
    const { hr, seeker, job, candidateId } = await setup();
    const social = (await api("POST", "/jobs", hr, {
      ...internJob, title: "后端工程师", recruit_type: "social", experience: "1to3",
      days_per_week: undefined, min_months: undefined, salary_min: 20, salary_max: 30, salary_unit: "k_per_month",
    })).data.job;
    const base = `/jobs?company_id=${job.company.id}`;
    expect((await api("GET", `${base}&days_per_week_max=5&min_months_max=3`, seeker)).data.jobs.map((j: any) => j.id).sort()).toEqual([job.id, social.id].sort());
    expect((await api("GET", `${base}&days_per_week_max=4`, seeker)).data.jobs.map((j: any) => j.id)).toEqual([job.id]);

    expect((await api("GET", `/jobs/${job.id}`, seeker)).data.job.my_application).toBeNull();
    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    const found = (await api("GET", base, seeker)).data.jobs;
    expect(found.find((j: any) => j.id === job.id).my_application).toEqual({ id: appId, status: "applied" });
    expect(found.find((j: any) => j.id === social.id).my_application).toBeNull();
    expect((await api("GET", `/jobs/${job.id}`, seeker)).data.job.my_application.id).toBe(appId);
    expect((await api("GET", base, hr)).data.jobs[0].my_application).toBeUndefined();

    const people = (await api("GET", "/candidates?skills=Rust&limit=50", hr)).data.candidates;
    expect(people.find((c: any) => c.id === candidateId).my_application).toEqual({ id: appId, job_id: job.id, status: "applied" });
    const other = await login(unique("hr"), RECRUITER);
    expect((await api("GET", `/candidates/${candidateId}`, other)).data.candidate.my_application).toBeNull();
  });

  it("服务端记着事件拉到哪了", async () => {
    const name = unique("hr");
    const hr = await login(name, RECRUITER);
    await api("PUT", "/company", hr, { name: unique("游标公司") });
    const job = (await api("POST", "/jobs", hr, internJob)).data.job;
    const { token } = await newSeeker();
    await api("POST", "/applications", token, { job_id: job.id });
    const first = await api("GET", "/events", hr);
    expect(first.data.events).toHaveLength(1);
    expect((await api("GET", "/events", hr)).data).toMatchObject({ events: [], next_after: first.data.next_after });
    // 同一个账号换一个令牌（agent 换了会话）也接着拉；想重看可以传 after
    const again = await login(name, RECRUITER);
    expect((await api("GET", "/events", again)).data.events).toHaveLength(0);
    expect((await api("GET", "/events?after=0", again)).data.events).toHaveLength(1);
  });

  it("录用人数到了招聘人数，岗位自动暂停", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    await api("PUT", "/company", hr, { name: unique("人数公司") });
    const job = (await api("POST", "/jobs", hr, { ...internJob, headcount: 1 })).data.job;
    const { token } = await newSeeker();
    const appId = (await api("POST", "/applications", token, { job_id: job.id })).data.application.id;
    const slot = future(1);
    await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [slot] });
    await api("POST", `/applications/${appId}/respond`, token, { accept: true, slot });
    await api("POST", `/applications/${appId}/offer`, hr, {});
    await api("POST", `/applications/${appId}/offer/respond`, token, { accept: true });
    expect((await api("GET", `/jobs/${job.id}`, hr)).data.job).toMatchObject({ status: "paused", accepting: false });
  });
});
