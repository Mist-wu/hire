export const RECRUIT_TYPES = {
  social: "社招",
  campus: "校招",
  intern_grad: "应届实习",
  intern_daily: "日常实习",
  part_time: "兼职",
} as const;
export type RecruitType = keyof typeof RECRUIT_TYPES;
export const INTERN_TYPES: RecruitType[] = ["intern_grad", "intern_daily"];

export const CATEGORY_TREE = {
  tech: {
    name: "技术",
    children: {
      backend: "后端开发",
      frontend: "前端开发",
      mobile: "移动开发",
      fullstack: "全栈开发",
      game_client: "游戏客户端开发",
      game_server: "游戏服务端开发",
      qa: "测试",
      sre: "运维",
      security: "安全",
      data_eng: "数据开发",
      data_analysis: "数据分析",
      algorithm: "算法",
      llm_algorithm: "大模型算法",
      llm_app: "大模型应用开发",
      embedded: "嵌入式和硬件",
      hpc: "高性能计算",
      research: "技术研究",
    },
  },
  product: {
    name: "产品",
    children: {
      pm: "产品经理",
      ai_pm: "AI 产品经理",
      data_pm: "数据产品经理",
      game_design: "游戏策划",
      user_research: "用户研究",
    },
  },
  design: {
    name: "设计",
    children: { visual: "视觉设计", interaction: "交互设计", game_art: "游戏美术", tech_art: "技术美术" },
  },
  ops: {
    name: "运营",
    children: {
      product_ops: "产品运营",
      content_ops: "内容运营",
      user_ops: "用户运营",
      game_ops: "游戏运营",
      ecommerce_ops: "电商运营",
      support: "客服",
    },
  },
  marketing: {
    name: "市场",
    children: { marketing: "市场营销", pr: "品牌公关", bd: "商务拓展", investment: "投资分析" },
  },
  sales: { name: "销售", children: { sales: "销售", presales: "售前和解决方案" } },
  corporate: { name: "职能", children: { hr: "人力资源", finance: "财务", legal: "法务", admin: "行政" } },
  other: { name: "其他", children: { other: "其他" } },
} as const;

export const CATEGORY_L1 = Object.keys(CATEGORY_TREE) as (keyof typeof CATEGORY_TREE)[];

export const CATEGORY_NAMES: Record<string, string> = {};
for (const [l1, group] of Object.entries(CATEGORY_TREE)) {
  for (const [l2, name] of Object.entries(group.children)) {
    CATEGORY_NAMES[`${l1}.${l2}`] = `${group.name} / ${name}`;
  }
}
export const CATEGORIES = Object.keys(CATEGORY_NAMES) as [string, ...string[]];

export const EXPERIENCES = {
  student: "在校生",
  fresh: "应届生",
  any: "不限",
  lt1: "1 年以内",
  "1to3": "1-3 年",
  "3to5": "3-5 年",
  "5to10": "5-10 年",
  gt10: "10 年以上",
} as const;

export const DEGREES = {
  any: "不限",
  junior_high: "初中及以下",
  secondary: "中专或中技",
  high: "高中",
  college: "大专",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士",
} as const;
export type Degree = keyof typeof DEGREES;
export const DEGREE_RANK: Record<Degree, number> = {
  any: 0,
  junior_high: 1,
  secondary: 2,
  high: 3,
  college: 4,
  bachelor: 5,
  master: 6,
  doctor: 7,
};

export const COMPANY_SCALES = {
  "0to20": "0-20 人",
  "20to99": "20-99 人",
  "100to499": "100-499 人",
  "500to999": "500-999 人",
  "1000to9999": "1000-9999 人",
  gte10000: "10000 人以上",
} as const;

export const COMPANY_STAGES = {
  none: "未融资",
  angel: "天使轮",
  a: "A 轮",
  b: "B 轮",
  c: "C 轮",
  d_plus: "D 轮及以上",
  listed: "已上市",
  no_need: "不需要融资",
} as const;

export const SALARY_UNITS = { per_day: "元/天", k_per_month: "千元/月" } as const;

export const APPLICATION_STATUSES = {
  applied: "已投递",
  viewed: "已查看",
  invited: "已邀约",
  accepted: "已接受",
  offered: "已发录用",
  hired: "已录用",
  rejected: "已拒绝",
  withdrawn: "已撤回",
  closed: "已关闭",
} as const;
export type ApplicationStatus = keyof typeof APPLICATION_STATUSES;
/** 还没结束的投递。同一个岗位同一个人只能有一条。 */
export const ACTIVE_STATUSES: ApplicationStatus[] = ["applied", "viewed", "invited", "accepted", "offered"];
/** 还没约上面试的投递。关闭岗位时只结束这些。 */
export const PENDING_STATUSES: ApplicationStatus[] = ["applied", "viewed", "invited"];
/** 这些状态下双方能看到对方的联系方式。 */
export const CONTACT_STATUSES: ApplicationStatus[] = ["accepted", "offered", "hired"];

export const REJECT_REASONS = {
  skills_mismatch: "技能不匹配",
  experience_mismatch: "经历不匹配",
  education_mismatch: "学历或届别不符",
  availability: "到岗时间或每周天数不合适",
  interview_failed: "面试未通过",
  position_filled: "岗位已招满",
  other: "其他",
} as const;

export function keysOf<T extends Record<string, unknown>>(obj: T): [keyof T & string, ...(keyof T & string)[]] {
  return Object.keys(obj) as [keyof T & string, ...(keyof T & string)[]];
}

function describe(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("，");
}

export const ENUM_DOCS = {
  recruit_type: describe(RECRUIT_TYPES),
  experience: describe(EXPERIENCES),
  degree: describe(DEGREES),
  scale: describe(COMPANY_SCALES),
  stage: describe(COMPANY_STAGES),
  salary_unit: describe(SALARY_UNITS),
  status: describe(APPLICATION_STATUSES),
  reject_reason: describe(REJECT_REASONS),
  category: Object.entries(CATEGORY_TREE)
    .map(([l1, g]) => `${l1}（${g.name}）: ${Object.entries(g.children).map(([k, v]) => `${l1}.${k}=${v}`).join("，")}`)
    .join("；"),
};
