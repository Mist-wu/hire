import { z } from "zod";
import { invalid, type FieldIssue } from "./errors";
import {
  APPLICATION_STATUSES,
  CATEGORIES,
  CATEGORY_L1,
  COMPANY_SCALES,
  COMPANY_STAGES,
  DEGREES,
  ENUM_DOCS,
  EXPERIENCES,
  INTERN_TYPES,
  RECRUIT_TYPES,
  REJECT_REASONS,
  SALARY_UNITS,
  keysOf,
  type RecruitType,
} from "./taxonomy";

z.config(z.locales.zhCN());

const str = (max: number) => z.string().trim().min(1).max(max);
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(300)
  .describe("http 或 https 地址");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "格式为 YYYY-MM");
const id = (what: string) => z.string().min(1).max(64).describe(`${what}编号`);

export const RecruitTypeEnum = z.enum(keysOf(RECRUIT_TYPES)).describe(`招聘类型：${ENUM_DOCS.recruit_type}`);
export const CategoryEnum = z.enum(CATEGORIES).describe("职类，写成“一级.二级”，从枚举里选最接近的");
export const ExperienceEnum = z.enum(keysOf(EXPERIENCES)).describe(`经验要求：${ENUM_DOCS.experience}`);
export const DegreeEnum = z.enum(keysOf(DEGREES)).describe(`学历：${ENUM_DOCS.degree}`);
export const SalaryUnitEnum = z.enum(keysOf(SALARY_UNITS)).describe(`薪资单位：${ENUM_DOCS.salary_unit}`);
export const StatusEnum = z.enum(keysOf(APPLICATION_STATUSES)).describe(`投递状态：${ENUM_DOCS.status}`);
const PersonDegreeEnum = z
  .enum(["junior_high", "secondary", "high", "college", "bachelor", "master", "doctor"])
  .describe("在读或已获得的最高学历");

const pageShape = {
  cursor: z.string().max(400).optional().describe("上一页返回的 next_cursor"),
  limit: z.int().min(1).max(50).optional().describe("每页条数，默认 20，最多 50"),
};

// ---------- 公司 ----------

export const CompanyInput = z.strictObject({
  name: str(60).optional().describe("公司名称。第一次创建时必填"),
  industry: str(40).nullable().optional().describe("行业，自由文本"),
  scale: z.enum(keysOf(COMPANY_SCALES)).nullable().optional().describe(`规模：${ENUM_DOCS.scale}`),
  stage: z.enum(keysOf(COMPANY_STAGES)).nullable().optional().describe(`融资阶段：${ENUM_DOCS.stage}`),
  website: httpUrl.nullable().optional(),
  intro: str(1000).nullable().optional().describe("公司介绍，1000 字以内"),
  contact_email: z.email().max(200).nullable().optional().describe("邀约被接受后，求职者能看到这个邮箱"),
});

// ---------- 岗位 ----------

const jobShape = {
  title: str(60).describe("岗位名称，60 字以内"),
  recruit_type: RecruitTypeEnum,
  category: CategoryEnum,
  cities: z.array(str(20)).min(1).max(10).describe('工作城市，至少一个，如 ["北京"]'),
  remote: z.boolean().optional().describe("是否可远程，默认 false"),
  experience: ExperienceEnum,
  degree: DegreeEnum.describe(`最低学历要求：${ENUM_DOCS.degree}`),
  grad_years: z.array(z.int().min(2000).max(2100)).max(6).optional().describe("面向届别，如 [2027, 2028]"),
  salary_min: z.int().min(0).nullable().optional().describe("薪资下限。不面议时必填"),
  salary_max: z.int().min(0).nullable().optional().describe("薪资上限。不面议时必填"),
  salary_unit: SalaryUnitEnum.nullable().optional(),
  salary_negotiable: z.boolean().optional().describe("是否面议，默认 false"),
  days_per_week: z.int().min(1).max(7).nullable().optional().describe("每周到岗天数。实习岗位必填，其他类型不要传"),
  min_months: z.int().min(1).max(24).nullable().optional().describe("最短实习月数。实习岗位必填，其他类型不要传"),
  convertible: z.boolean().nullable().optional().describe("能否转正，仅实习"),
  duties: str(5000).describe("岗位职责"),
  requirements: str(5000).describe("任职要求"),
  bonus: str(3000).nullable().optional().describe("加分项"),
  skills: z.array(str(30)).max(15).optional().describe("技能标签，最多 15 个"),
  headcount: z.int().min(1).max(9999).nullable().optional().describe("招聘人数"),
  deadline: z.iso.date().nullable().optional().describe("截止日期，YYYY-MM-DD。过了这一天岗位不再出现在搜索里，也不能投递"),
  questions: z
    .array(
      z.strictObject({
        text: str(200).describe("问题"),
        options: z
          .array(str(60))
          .min(2)
          .max(6)
          .refine((list) => new Set(list).size === list.length, "选项不能重复")
          .optional()
          .describe("可选答案。传了就是单选题，不传是问答题"),
      }),
    )
    .max(3)
    .optional()
    .describe("筛选问题，最多 3 个。求职者投递时必须逐个回答"),
};

export const JobFields = z.strictObject(jobShape);
export type JobFields = z.infer<typeof JobFields>;

export const JobCreateInput = JobFields.extend({
  company_id: id("公司").optional().describe("名下有多家公司时指定。不传则用最早创建的那家"),
});

export const JobUpdateInput = JobFields.partial().extend({
  job_id: id("岗位"),
  status: z.enum(["open", "paused"]).optional().describe("open=开放，paused=暂停。关闭请用 job_close"),
});

/** 跨字段校验，创建和更新后的完整岗位都要过一遍。 */
export function checkJob(job: JobFields): void {
  const issues: FieldIssue[] = [];
  const intern = INTERN_TYPES.includes(job.recruit_type as RecruitType);
  if (intern) {
    if (job.days_per_week == null) issues.push({ field: "days_per_week", message: "实习岗位必须填每周到岗天数。" });
    if (job.min_months == null) issues.push({ field: "min_months", message: "实习岗位必须填最短实习月数。" });
  } else {
    for (const field of ["days_per_week", "min_months", "convertible"] as const) {
      if (job[field] != null) issues.push({ field, message: "只有实习岗位才有这个字段，请去掉或传 null。" });
    }
  }
  if (job.salary_negotiable) {
    if ((job.salary_min == null) !== (job.salary_max == null)) {
      issues.push({ field: "salary_max", message: "薪资上下限要么都填，要么都不填。" });
    }
  } else {
    if (job.salary_min == null) issues.push({ field: "salary_min", message: "不面议时必须填薪资下限。" });
    if (job.salary_max == null) issues.push({ field: "salary_max", message: "不面议时必须填薪资上限。" });
  }
  if (job.salary_min != null || job.salary_max != null) {
    if (job.salary_unit == null) issues.push({ field: "salary_unit", message: "填了薪资就必须填单位。" });
    if (job.salary_min != null && job.salary_max != null && job.salary_min > job.salary_max) {
      issues.push({ field: "salary_min", message: "薪资下限不能高于上限。" });
    }
  }
  if (issues.length) throw invalid(issues);
}

const jobFilterShape = {
  q: z.string().trim().max(100).optional().describe("关键词，空格分隔表示都要包含"),
  recruit_type: RecruitTypeEnum.optional(),
  category: z
    .enum([...CATEGORY_L1, ...CATEGORIES])
    .optional()
    .describe("职类。可以只传一级，如 tech；也可以传完整编码，如 tech.backend"),
  city: str(20).optional().describe("工作城市，如 北京"),
  remote: z.boolean().optional().describe("true 表示只看可远程的岗位"),
  degree: DegreeEnum.optional().describe("你的学历。只返回最低学历要求不高于它的岗位"),
  grad_year: z.int().min(2000).max(2100).optional().describe("你的毕业年份。只返回面向这一届或不限届别的岗位"),
  days_per_week_max: z.int().min(1).max(7).optional().describe("你每周最多能到岗几天"),
  min_months_max: z.int().min(1).max(24).optional().describe("你最多能实习几个月"),
  salary_min: z.int().min(0).optional().describe("期望的最低薪资，必须和 salary_unit 一起传。只匹配同一单位、上限不低于它的岗位"),
  salary_unit: SalaryUnitEnum.optional(),
  skills: z.array(str(30)).max(10).optional().describe("技能标签，命中任意一个即可"),
  company_id: id("公司").optional(),
  active_within_days: z.int().min(1).max(90).optional().describe("只返回招聘者最近这么多天内活跃过的岗位"),
};

export const JobFilters = z.strictObject(jobFilterShape);
export type JobFilters = z.infer<typeof JobFilters>;

export const JobsSearchInput = z.strictObject({
  ...jobFilterShape,
  mine: z.boolean().optional().describe("招聘者专用：true 表示列出自己名下所有状态的岗位"),
  ...pageShape,
});

export const SubscriptionCreateInput = z.strictObject({
  name: str(40).describe("给这组条件起个名字，如 北京后端实习"),
  filters: JobFilters.describe("搜索条件，和 jobs_search 的入参相同，至少传一项"),
});
export const SubscriptionDeleteInput = z.strictObject({ subscription_id: id("订阅") });

// ---------- 简历 ----------

const educationItem = z.strictObject({
  school: str(50),
  degree: PersonDegreeEnum.optional(),
  major: str(50).optional(),
  start: month.optional(),
  end: month.nullable().optional().describe("在读传 null"),
});
const experienceItem = z.strictObject({
  company: str(60),
  title: str(60),
  start: month.optional(),
  end: month.nullable().optional().describe("在职传 null"),
  description: str(2000).optional(),
});
const projectItem = z.strictObject({
  name: str(60),
  role: str(40).optional(),
  start: month.optional(),
  end: month.nullable().optional(),
  description: str(2000).optional(),
  link: httpUrl.optional(),
});

const resumeShape = {
  name: str(30).describe("姓名"),
  school: str(50).describe("学校"),
  degree: PersonDegreeEnum,
  major: str(50).nullable().describe("专业。传 null 清空"),
  grad_year: z.int().min(1980).max(2100).describe("毕业年份"),
  city: str(20).nullable().describe("现居城市。传 null 清空"),
  summary: str(500).nullable().describe("个人简介，500 字以内。传 null 清空"),
  skills: z.array(str(30)).max(30).describe("技能标签，最多 30 个"),
  education: z.array(educationItem).max(10),
  experience: z.array(experienceItem).max(20).describe("工作和实习经历"),
  projects: z.array(projectItem).max(20),
  links: z.array(httpUrl).max(10).describe("GitHub、个人网站等链接"),
};

export const ResumeContent = z.strictObject(resumeShape).partial();
export type ResumeContent = z.infer<typeof ResumeContent>;

export const Expectation = z.strictObject({
  recruit_types: z.array(RecruitTypeEnum).max(5).optional().describe("想找的招聘类型"),
  cities: z.array(str(20)).max(10).optional().describe("期望城市"),
  days_per_week: z.int().min(1).max(7).optional().describe("每周能到岗几天"),
  salary_min: z.int().min(0).optional(),
  salary_unit: SalaryUnitEnum.optional(),
  available_from: z.iso.date().optional().describe("最早到岗日期，YYYY-MM-DD"),
  duration_months: z.int().min(1).max(36).optional().describe("能实习几个月"),
});

export const ProfileUpdateInput = ResumeContent.extend({
  expectation: Expectation.optional().describe("求职期望，整体替换"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d[\d\- ]{5,19}$/, "手机号格式不对")
    .nullable()
    .optional()
    .describe("手机号。只有接受邀约后，对方才能看到。传 null 清空"),
  email: z.email().max(200).nullable().optional().describe("邮箱。只有接受邀约后，对方才能看到。传 null 清空"),
  resume_public: z.boolean().optional().describe("是否出现在招聘者的搜索里，默认 true。关闭后，已经收到你投递的招聘者仍然能看简历"),
});

export const ResumeUploadInput = z.strictObject({
  filename: str(120).describe("文件名，如 张三-后端.pdf"),
  content_base64: z.string().min(1).describe("PDF 文件内容的 base64 编码，原文件不超过 5 MB"),
});

export const CandidatesSearchInput = z.strictObject({
  q: z.string().trim().max(100).optional().describe("关键词，空格分隔表示都要包含"),
  recruit_type: RecruitTypeEnum.optional().describe("只返回期望里包含这个招聘类型的求职者"),
  city: str(20).optional().describe("现居城市或期望城市"),
  degree: PersonDegreeEnum.optional().describe("最低学历"),
  grad_year: z.int().min(1980).max(2100).optional(),
  days_per_week_min: z.int().min(1).max(7).optional().describe("每周至少能到岗几天"),
  skills: z.array(str(30)).max(10).optional().describe("技能标签，命中任意一个即可"),
  active_within_days: z.int().min(1).max(90).optional().describe("只返回最近这么多天内活跃过的求职者"),
  ...pageShape,
});

// ---------- 投递 ----------

const note = z.string().trim().max(500).optional().describe("给对方的备注，500 字以内");
export const ApplicationCreateInput = z.strictObject({
  job_id: id("岗位"),
  custom_resume: ResumeContent.optional().describe("针对这个岗位改写的简历，只有这个岗位的招聘者能看。不传就用公开简历"),
  answers: z
    .array(str(500))
    .max(3)
    .optional()
    .describe("按顺序回答岗位的筛选问题，每题一项。岗位有 questions 时必填，问题用 job_get 查看"),
  note,
});

export const ApplicationsListInput = z.strictObject({
  status: StatusEnum.optional(),
  ...pageShape,
});

export const JobApplicationsListInput = z.strictObject({
  job_id: id("岗位"),
  status: StatusEnum.optional(),
  ...pageShape,
});

export const ApplicationGetInput = z.strictObject({ application_id: id("投递") });

export const ApplicationActionInput = z.strictObject({ application_id: id("投递"), note });

export const ApplicationRejectInput = z.strictObject({
  application_id: id("投递"),
  reason: z.enum(keysOf(REJECT_REASONS)).describe(`拒绝原因：${ENUM_DOCS.reject_reason}`),
  note,
});

export const OfferCreateInput = z.strictObject({
  application_id: id("投递"),
  start_date: z.iso.date().optional().describe("入职日期，YYYY-MM-DD"),
  salary: z.int().min(0).optional().describe("录用薪资，必须和 salary_unit 一起传"),
  salary_unit: SalaryUnitEnum.optional(),
  reply_by: z.iso.date().optional().describe("希望对方在这一天前答复，YYYY-MM-DD"),
  note,
});

export const OfferRespondInput = z.strictObject({
  application_id: id("投递"),
  accept: z.boolean().describe("true=接受录用，false=拒绝"),
  note,
});

export const InvitationCreateInput = z.strictObject({
  application_id: id("投递").optional().describe("回应一条已有的投递，或给一条已发出的邀约改时间时传它"),
  job_id: id("岗位").optional().describe("主动邀约时传，必须和 candidate_id 一起"),
  candidate_id: id("求职者").optional().describe("主动邀约时传，必须和 job_id 一起"),
  mode: z.enum(["online", "onsite", "phone"]).describe("面试方式：online=线上，onsite=线下，phone=电话"),
  slots: z
    .array(z.iso.datetime({ offset: true }))
    .min(1)
    .max(5)
    .describe('可选的面试时间，1 到 5 个，带时区，如 "2026-10-20T14:00:00+08:00"'),
  location: str(200).optional().describe("线下地址或会议说明。onsite 时必填"),
  note,
});

export const InvitationRespondInput = z.strictObject({
  application_id: id("投递"),
  accept: z.boolean().describe("true=接受，false=拒绝"),
  slot: z.iso.datetime({ offset: true }).optional().describe("接受时必填，必须是邀约里给出的时间之一"),
  note,
});

export const JobGetInput = z.strictObject({ job_id: id("岗位") });
export const JobCloseInput = z.strictObject({ job_id: id("岗位"), note });
export const CandidateGetInput = z.strictObject({ candidate_id: id("求职者") });
export const EmptyInput = z.strictObject({});

export const EventsPollInput = z.strictObject({
  after: z.int().min(0).optional().describe("一般不传：服务端记着你上次拉到哪，只返回之后的新事件。想重看旧事件时传序号，传 0 从头看"),
  limit: z.int().min(1).max(100).optional().describe("最多返回几条，默认 50"),
});

export const QuotaGetInput = z.strictObject({
  job_id: id("岗位").optional().describe("招聘者传它可以看这个岗位今天还能主动邀约几次"),
});

export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(整体)",
    message: issue.message,
  }));
}

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw invalid(zodIssues(result.error));
  return result.data;
}
