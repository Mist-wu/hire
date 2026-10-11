import { describe, expect, it } from "vitest";
import { CANDIDATE, RECRUITER, api, future, internJob, login, profile, setup, unique } from "./helpers";

/** 走到“已接受”：投递、邀约、接受。 */
async function accepted() {
  const ctx = await setup();
  const appId = (await api("POST", "/applications", ctx.seeker, { job_id: ctx.job.id })).data.application.id as string;
  const slot = future(2);
  await api("POST", "/invitations", ctx.hr, { application_id: appId, mode: "online", slots: [slot] });
  await api("POST", `/applications/${appId}/respond`, ctx.seeker, { accept: true, slot });
  return { ...ctx, appId };
}

describe("活跃度", () => {
  it("岗位带招聘者的活跃时间和处理比例，求职者带活跃时间", async () => {
    const { hr, seeker, job, candidateId } = await setup();
    const found = await api("GET", `/jobs?company_id=${job.company.id}&active_within_days=1`, seeker);
    expect(found.data.jobs[0].recruiter_active_at).toBeTruthy();

    const before = await api("GET", `/jobs/${job.id}`, seeker);
    expect(before.data.job.recruiter).toMatchObject({ applications_90d: 0, decision_rate: null });

    const appId = (await api("POST", "/applications", seeker, { job_id: job.id })).data.application.id;
    // 只是查看不算做出决定
    await api("GET", `/applications/${appId}`, hr);
    expect((await api("GET", `/jobs/${job.id}`, seeker)).data.job.recruiter).toMatchObject({ applications_90d: 1, decision_rate: 0 });
    await api("POST", "/invitations", hr, { application_id: appId, mode: "online", slots: [future(1)] });
    const after = (await api("GET", `/jobs/${job.id}`, seeker)).data.job.recruiter;
    expect(after).toMatchObject({ applications_90d: 1, decision_rate: 1 });
    expect(after.avg_decision_hours).toBeGreaterThanOrEqual(0);

    const people = await api("GET", "/candidates?skills=Rust&active_within_days=1&limit=50", hr);
    const me = people.data.candidates.find((c: any) => c.id === candidateId);
    expect(me.active_at).toBeTruthy();
  });

  it("没活跃过的招聘者会被 active_within_days 滤掉", async () => {
    const { hr, seeker, job } = await setup();
    // 挂着拉事件不算活跃，主动操作才算
    const { env } = await import("cloudflare:test");
    await (env as any).DB.prepare("UPDATE companies SET active_at = ? WHERE id = ?").bind("2020-01-01T00:00:00.000Z", job.company.id).run();
    expect((await api("GET", `/jobs?company_id=${job.company.id}&active_within_days=7`, seeker)).data.jobs).toHaveLength(0);
    await api("GET", "/events", hr);
    expect((await api("GET", `/jobs?company_id=${job.company.id}&active_within_days=7`, seeker)).data.jobs).toHaveLength(0);
    await api("GET", "/company", hr);
    expect((await api("GET", `/jobs?company_id=${job.company.id}&active_within_days=7`, seeker)).data.jobs).toHaveLength(1);
  });
});

describe("筛选问题", () => {
  it("有问题的岗位必须答完才能投", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const seeker = await login(unique("seeker"), CANDIDATE);
    await api("PUT", "/company", hr, { name: unique("问题公司") });
    await api("PATCH", "/me/profile", seeker, profile);
    const questions = [{ text: "每周能到岗几天？", options: ["3 天", "4 天", "5 天"] }, { text: "讲一个你做过的后端项目。" }];
    const job = (await api("POST", "/jobs", hr, { ...internJob, questions })).data.job;
    expect(job.questions).toEqual(questions);
    expect((await api("GET", `/jobs?company_id=${job.company.id}`, seeker)).data.jobs[0].question_count).toBe(2);

    const none = await api("POST", "/applications", seeker, { job_id: job.id });
    expect(none.status).toBe(422);
    expect(none.data.error.details.questions).toEqual(questions);
    const wrong = await api("POST", "/applications", seeker, { job_id: job.id, answers: ["6 天", "y2b-rs"] });
    expect(wrong.data.error.details.fields[0].field).toBe("answers.0");

    const ok = await api("POST", "/applications", seeker, { job_id: job.id, answers: ["4 天", "y2b-rs"] });
    expect(ok.status).toBe(200);
    const seen = await api("GET", `/applications/${ok.data.application.id}`, hr);
    expect(seen.data.application.answers).toEqual([
      { question: "每周能到岗几天？", answer: "4 天" },
      { question: "讲一个你做过的后端项目。", answer: "y2b-rs" },
    ]);

    const plain = (await api("POST", "/jobs", hr, internJob)).data.job;
    expect((await api("POST", "/applications", seeker, { job_id: plain.id, answers: ["x"] })).status).toBe(422);
    expect((await api("POST", "/jobs", hr, { ...internJob, questions: [1, 2, 3, 4].map((n) => ({ text: `问题 ${n}` })) })).status).toBe(422);
  });
});

describe("订阅", () => {
  it("新岗位符合条件时出现在事件里，只出现一次", async () => {
    const hr = await login(unique("hr"), RECRUITER);
    const seeker = await login(unique("seeker"), CANDIDATE);
    const company = (await api("PUT", "/company", hr, { name: unique("订阅公司") })).data.company;

    expect((await api("POST", "/subscriptions", seeker, { name: "空", filters: {} })).status).toBe(422);
    expect((await api("POST", "/subscriptions", seeker, { name: "x", filters: { salary_min: 1 } })).status).toBe(422);
    const sub = await api("POST", "/subscriptions", seeker, { name: "深圳实习", filters: { company_id: company.id, city: "深圳" } });
    expect(sub.status).toBe(200);
    const subId = sub.data.subscription.id;

    await new Promise((r) => setTimeout(r, 5));
    await api("POST", "/jobs", hr, internJob);
    const match = (await api("POST", "/jobs", hr, { ...internJob, title: "深圳岗位", cities: ["深圳"] })).data.job;

    const first = await api("GET", "/events", seeker);
    expect(first.data.events).toHaveLength(1);
    expect(first.data.events[0]).toMatchObject({
      type: "job.matched", application_id: null, job_id: match.id, job_title: "深圳岗位", subscription_id: subId,
    });
    expect((await api("GET", "/events", seeker)).data.events).toHaveLength(0);
    expect((await api("GET", "/events?after=0", seeker)).data.events).toHaveLength(1);

    expect((await api("GET", "/subscriptions", seeker)).data.subscriptions).toHaveLength(1);
    const other = await login(unique("seeker"), CANDIDATE);
    expect((await api("POST", `/subscriptions/${subId}/delete`, other)).status).toBe(404);
    expect((await api("POST", `/subscriptions/${subId}/delete`, seeker)).status).toBe(200);
    const cities = ["北京", "上海", "广州", "杭州", "成都"];
    for (const city of cities) {
      expect((await api("POST", "/subscriptions", seeker, { name: city, filters: { city } })).status).toBe(200);
    }
    expect((await api("POST", "/subscriptions", seeker, { name: "重复", filters: { city: "北京" } })).data.error.message).toContain("条件相同");
    expect((await api("POST", "/subscriptions", seeker, { name: "第六个", filters: { city: "武汉" } })).status).toBe(422);
  });
});

describe("面试之后", () => {
  it("发录用、接受录用，联系方式一直可见", async () => {
    const { hr, seeker, job, appId } = await accepted();
    const early = await api("POST", `/applications/${appId}/offer/respond`, seeker, { accept: true });
    expect(early.data.error.code).toBe("invalid_transition");
    expect((await api("POST", `/applications/${appId}/offer`, hr, { salary: 300 })).status).toBe(422);

    const offered = await api("POST", `/applications/${appId}/offer`, hr, {
      start_date: "2026-11-02", salary: 300, salary_unit: "per_day", note: "欢迎加入。",
    });
    expect(offered.data.application).toMatchObject({ status: "offered", offer: { start_date: "2026-11-02", salary: 300 } });
    expect(offered.data.application.contact.phone).toBe("13800000000");
    expect((await api("GET", "/events", seeker)).data.events.at(-1)).toMatchObject({ type: "offer.created", note: "欢迎加入。" });

    // 关闭岗位不影响已经走到面试之后的投递
    expect((await api("POST", `/jobs/${job.id}/close`, hr, {})).data.closed_applications).toBe(0);

    const hired = await api("POST", `/applications/${appId}/offer/respond`, seeker, { accept: true });
    expect(hired.data.application).toMatchObject({ status: "hired", closed_by: null });
    expect(hired.data.application.ended_at).toBeTruthy();
    expect(hired.data.application.contact).toEqual({ company_email: "hr@example.com" });
    expect((await api("GET", "/events", hr)).data.events.at(-1).type).toBe("offer.accepted");
    const final = await api("GET", `/applications/${appId}`, hr);
    expect(final.data.application.logs.map((l: any) => l.to_status)).toEqual(["applied", "invited", "accepted", "offered", "hired"]);
    expect((await api("POST", `/applications/${appId}/withdraw`, seeker, {})).status).toBe(409);
  });

  it("面试没通过要选原因，求职者能看到；接受邀约后不能重复投", async () => {
    const { hr, seeker, job, appId } = await accepted();
    expect((await api("POST", "/applications", seeker, { job_id: job.id })).data.error.code).toBe("duplicate_application");
    const rejected = await api("POST", `/applications/${appId}/reject`, hr, { reason: "interview_failed", note: "谢谢参加。" });
    expect(rejected.data.application).toMatchObject({ status: "rejected", reject_reason: "interview_failed", contact: null });
    expect((await api("GET", "/events", seeker)).data.events.at(-1)).toMatchObject({
      type: "application.rejected", reason: "interview_failed",
    });
    expect((await api("GET", `/applications/${appId}/resume.pdf`, hr)).status).toBe(409);
  });
});

describe("岗位数据", () => {
  it("漏斗、当前状态和拒绝原因", async () => {
    const { hr, seeker, job, appId } = await accepted();
    await api("POST", `/applications/${appId}/offer`, hr, {});
    for (const reason of ["skills_mismatch", "skills_mismatch"]) {
      const other = await login(unique("seeker"), CANDIDATE);
      await api("PATCH", "/me/profile", other, profile);
      const id = (await api("POST", "/applications", other, { job_id: job.id })).data.application.id;
      await api("POST", `/applications/${id}/reject`, hr, { reason });
    }
    const pending = await login(unique("seeker"), CANDIDATE);
    const pendingId = (await api("PATCH", "/me/profile", pending, profile)).data.profile.id;
    await api("POST", "/applications", pending, { job_id: job.id });
    const invitee = await login(unique("seeker"), CANDIDATE);
    const inviteeId = (await api("PATCH", "/me/profile", invitee, profile)).data.profile.id;
    await api("POST", "/invitations", hr, { job_id: job.id, candidate_id: inviteeId, mode: "online", slots: [future(1)] });
    await api("GET", `/jobs/${job.id}`, seeker);
    await api("GET", `/jobs/${job.id}`, hr);

    const stats = await api("GET", `/jobs/${job.id}/stats`, hr);
    expect(stats.data).toMatchObject({
      detail_views: 1,
      applications: { total: 5, by_candidate: 4, by_recruiter: 1 },
      funnel: { applied: 4, viewed: 0, decided: 3, invited: 2, accepted: 1, offered: 1, hired: 0 },
      current: { offered: 1, rejected: 2, applied: 1, invited: 1 },
      reject_reasons: { skills_mismatch: 2 },
    });
    expect(pendingId).toBeTruthy();
    expect((await api("GET", `/jobs/${job.id}/stats`, seeker)).status).toBe(403);
    const stranger = await login(unique("hr"), RECRUITER);
    expect((await api("GET", `/jobs/${job.id}/stats`, stranger)).status).toBe(404);
  });
});
