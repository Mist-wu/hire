# hire 设计

这份文档写给实现 hire 的人。读完应该能建表、写接口、写 MCP 工具，不需要再回头问产品问题。

## 范围

hire 是一个演示项目，目标是跑通一条完整流程：HR 的 agent 发岗位，求职者的 agent 传简历并投递，HR 邀约，求职者接受，双方拿到联系方式。

做的事：

- 岗位和简历的结构化存储、搜索。
- 投递、邀约的状态流转。
- 事件接口，供 agent 轮询进展。
- GitHub 登录、令牌和权限范围。
- 一个技能包，教 agent 怎么用这些工具。

不做的事：

- 网页和 App。
- 服务端跑模型。解析简历、给岗位打分都交给用户的 agent。
- 自由对话。双方只通过固定的状态和一段备注交流。
- 公司资质审核。所有公司都标为“未认证”。
- 回调通知。agent 只能轮询。

## 账号、身份和令牌

一个账号对应一个 GitHub 用户。账号下可以开两种身份：

| 身份 | 能做什么 | 需要先有 |
|---|---|---|
| 求职者 `candidate` | 维护资料和简历、搜索岗位、投递、回应邀约 | 无 |
| 招聘者 `recruiter` | 维护公司、发岗位、搜索求职者、邀约、拒绝 | 一家公司 |

同一个账号可以同时有两种身份。演示时一个 GitHub 账号就能扮两边。

令牌按身份签发，一个令牌只属于一种身份。令牌还带权限范围，服务端按范围放行或拒绝：

| 范围 | 覆盖的动作 |
|---|---|
| `candidate:read` | 看自己的资料和投递、搜索和查看岗位 |
| `candidate:write` | 改资料、传简历、设置简历是否公开 |
| `candidate:apply` | 投递、撤回、回应邀约 |
| `recruiter:read` | 搜索和查看求职者、看收到的投递 |
| `recruiter:write` | 改公司、发布、修改和关闭岗位 |
| `recruiter:invite` | 发出邀约、拒绝 |

事件和限额两个接口，任何令牌都能调。

“始终允许、每次确认、禁止”三档由客户端提供，服务端不实现。服务端只保证两件事：每个动作是一个独立的 MCP 工具，令牌没有的范围一律拒绝。

### 登录

有两条路，签出的令牌格式相同。

**（1）MCP 连接器：标准 OAuth。** 服务端实现授权服务器的元数据、动态客户端注册、授权和换令牌四个端点。授权端点不出页面，直接跳转到 GitHub 授权，回调后再跳回客户端。

**（2）命令行和技能包：设备码。** agent 向服务端要一个设备码，服务端转去向 GitHub 申请，把 GitHub 的验证地址和用户码返回给 agent。人在 `github.com/login/device` 输入用户码。agent 轮询服务端，拿到令牌。

两条路都不需要 hire 自己的页面。

令牌是随机串，库里只存哈希。访问令牌有效 1 小时，刷新令牌有效 30 天。

## 数据模型

下面是逻辑模型。数组字段在 SQLite 里存成 JSON，需要过滤的数组（城市、技能）另建关联表。

### 公司 `companies`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `name` | 字符串 | |
| `industry` | 字符串 | 自由文本 |
| `scale` | 枚举 | 见“公司规模” |
| `stage` | 枚举 | 见“融资阶段” |
| `website` | 字符串 | 可空 |
| `intro` | 文本 | 可空，1000 字以内 |
| `verified` | 布尔 | 固定为 `false` |
| `contact_email` | 字符串 | 邀约被接受后，求职者能看到 |

一个招聘者属于一家公司。演示阶段，一家公司只有创建它的那一个招聘者。

### 岗位 `jobs`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `company_id` | 字符串 | |
| `title` | 字符串 | 60 字以内 |
| `recruit_type` | 枚举 | 见“招聘类型” |
| `category` | 枚举 | 见“职类” |
| `cities` | 字符串数组 | 至少一个 |
| `remote` | 布尔 | 是否可远程 |
| `teams` | 字符串数组 | 部门或事业群，自由文本，可空 |
| `experience` | 枚举 | 见“经验” |
| `degree` | 枚举 | 见“学历”，表示最低要求 |
| `grad_years` | 整数数组 | 面向届别，如 `[2027, 2028]`，可空 |
| `salary_min`、`salary_max` | 整数 | 面议时可空 |
| `salary_unit` | 枚举 | `per_day`（元/天）或 `k_per_month`（千元/月） |
| `salary_months` | 整数 | 年薪月数，如 14，可空 |
| `salary_negotiable` | 布尔 | |
| `days_per_week` | 整数 | 仅实习，1 到 7 |
| `min_months` | 整数 | 仅实习，最短实习月数 |
| `convertible` | 布尔 | 仅实习，能否转正，可空 |
| `duties` | 文本 | 岗位职责 |
| `requirements` | 文本 | 任职要求 |
| `bonus` | 文本 | 加分项，可空 |
| `skills` | 字符串数组 | 技能标签，最多 15 个 |
| `headcount` | 整数 | 招聘人数，可空 |
| `deadline` | 日期 | 可空 |
| `status` | 枚举 | `open`、`paused`、`closed` |
| `source_url` | 字符串 | 模拟数据的参考来源，可空 |
| `custom_fields` | 键值对 | 最多 10 项 |

校验规则：`recruit_type` 是两种实习之一时，`days_per_week` 和 `min_months` 必填。其他类型不接受这两个字段。

### 求职者 `candidates`

| 字段 | 类型 | 握手前可见 | 说明 |
|---|---|---|---|
| `name` | 字符串 | 是 | |
| `school` | 字符串 | 是 | |
| `degree` | 枚举 | 是 | 在读或已获得的最高学历 |
| `major` | 字符串 | 是 | |
| `grad_year` | 整数 | 是 | 毕业年份 |
| `city` | 字符串 | 是 | 现居城市 |
| `summary` | 文本 | 是 | 500 字以内 |
| `skills` | 字符串数组 | 是 | 最多 30 个 |
| `education` | 对象数组 | 是 | 学校、学历、专业、起止年月 |
| `experience` | 对象数组 | 是 | 公司、职位、起止年月、内容 |
| `projects` | 对象数组 | 是 | 名称、角色、起止年月、内容、链接 |
| `links` | 字符串数组 | 是 | GitHub、个人网站 |
| `expectation` | 对象 | 是 | 见下 |
| `resume_public` | 布尔 | — | 关闭后不出现在搜索里 |
| `phone` | 字符串 | 否 | |
| `email` | 字符串 | 否 | |
| `pdf` | 文件 | 否 | 可选，5 MB 以内 |

`expectation` 的字段：`recruit_types`、`cities`、`days_per_week`、`salary_min`、`salary_unit`、`available_from`、`duration_months`。

求职者只有一份公开简历，就是上表。它给主动找人的 HR 看。

### 投递 `applications`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `job_id`、`candidate_id` | 字符串 | 同一对只能有一条未结束的投递 |
| `initiated_by` | 枚举 | `candidate` 或 `recruiter` |
| `status` | 枚举 | 见“投递状态” |
| `custom_resume` | 对象 | 可空。投递时 agent 针对这个岗位改写的简历，结构同公开简历，只有这个岗位的招聘者能看 |
| `invitation` | 对象 | 邀约内容，见下 |
| `chosen_slot` | 时间 | 求职者接受时选的面试时间 |
| `closed_by` | 枚举 | `candidate`、`recruiter`、`system`，结束时填 |

每次状态变化在 `application_logs` 里记一行：谁、什么时候、从哪个状态到哪个状态、备注。备注 500 字以内。

`invitation` 的字段：`mode`（`online`、`onsite`、`phone`）、`slots`（1 到 5 个可选时间）、`location`（线下地址或会议说明，可空）。

## 可见性

简历内容对所有登录用户公开，没有匿名阶段。只有三样东西受保护：手机号、邮箱、PDF 原件。

| 谁在看 | 能看到 |
|---|---|
| 任何招聘者 | 公开简历的全部内容，不含手机、邮箱、PDF |
| 收到投递的招聘者 | 另加这次投递的 `custom_resume` |
| 投递状态为“已接受”的招聘者 | 另加手机、邮箱、PDF 下载 |
| 投递状态为“已接受”的求职者 | 公司的 `contact_email` |

`resume_public` 关闭时，求职者不出现在搜索结果里。已经收到他投递的招聘者仍然能看他的简历。

PDF 里通常印着手机号，所以它和手机号受同样的保护。

## 投递状态

共 7 个状态，后 4 个是终态。

| 状态 | 含义 |
|---|---|
| `applied` 已投递 | 求职者投了，招聘者还没看 |
| `viewed` 已查看 | 招聘者读过这条投递的详情 |
| `invited` 已邀约 | 招聘者发出了面试邀约 |
| `accepted` 已接受 | 求职者接受了邀约，双方可见联系方式 |
| `rejected` 已拒绝 | 招聘者拒绝了投递，或求职者拒绝了邀约 |
| `withdrawn` 已撤回 | 求职者主动撤回 |
| `closed` 已关闭 | 岗位关闭，系统结束了这条投递 |

允许的变化：

| 从 | 到 | 谁触发 | 怎么触发 |
|---|---|---|---|
| — | `applied` | 求职者 | 投递 |
| — | `invited` | 招聘者 | 主动邀约，跳过前两步 |
| `applied` | `viewed` | 招聘者 | 第一次读投递详情，自动变化 |
| `applied`、`viewed` | `invited` | 招聘者 | 发出邀约 |
| `applied`、`viewed`、`invited` | `rejected` | 招聘者 | 拒绝 |
| `invited` | `accepted` | 求职者 | 接受，并选一个时间 |
| `invited` | `rejected` | 求职者 | 拒绝邀约 |
| `applied`、`viewed`、`invited` | `withdrawn` | 求职者 | 撤回 |
| 任何非终态 | `closed` | 系统 | 岗位被关闭 |

其他变化一律返回 `invalid_transition` 错误，并在错误里带上当前状态。

同一对岗位和求职者，上一条投递进入终态 7 天后才能再投。

## 事件

每次状态变化，给对方写一条事件。agent 轮询事件接口来了解进展。

| 事件类型 | 发给谁 | 什么时候 |
|---|---|---|
| `application.created` | 招聘者 | 收到新投递 |
| `application.viewed` | 求职者 | 投递被查看 |
| `invitation.created` | 求职者 | 收到邀约 |
| `invitation.accepted` | 招聘者 | 邀约被接受 |
| `application.rejected` | 对方 | 任一方拒绝 |
| `application.withdrawn` | 招聘者 | 求职者撤回 |
| `application.closed` | 求职者 | 岗位关闭 |

事件带自增序号。轮询时传 `after=<上次拿到的最大序号>`，服务端返回之后的事件，一次最多 100 条。事件保留 30 天。

事件里只放投递编号、岗位标题、对方名称和备注。详情让 agent 再调投递详情接口。

建议的轮询间隔写在技能包里：有未结束的投递时每 10 分钟一次，否则不轮询。

## 限额

| 对象 | 上限 | 说明 |
|---|---|---|
| 求职者投递 | 每天 20 次 | 撤回不返还 |
| 招聘者主动邀约 | 每个岗位每天 20 次 | 回应投递的邀约不计入 |
| 搜索 | 每分钟 30 次 | 两种身份相同 |
| 事件轮询 | 每分钟 6 次 | |

“每天”按北京时间 0 点重置。超出时返回 HTTP 429，错误码 `quota_exceeded`，并带 `reset_at`。四个数字都是配置项。

## 分类表

所有枚举值都写进接口的 JSON Schema。agent 从工具定义里就能看到可选值，不需要另外查表。

### 招聘类型

| 值 | 名称 |
|---|---|
| `social` | 社招 |
| `campus` | 校招 |
| `intern_grad` | 应届实习 |
| `intern_daily` | 日常实习 |
| `part_time` | 兼职 |

### 职类

两级。存储时用“一级。二级”的编码，如 `tech.backend`。搜索时可以只传一级。

| 一级 | 二级 |
|---|---|
| 技术 `tech` | 后端开发、前端开发、移动开发、全栈开发、游戏客户端开发、游戏服务端开发、测试、运维、安全、数据开发、数据分析、算法、大模型算法、大模型应用开发、嵌入式和硬件、高性能计算、技术研究 |
| 产品 `product` | 产品经理、AI 产品经理、数据产品经理、游戏策划、用户研究 |
| 设计 `design` | 视觉设计、交互设计、游戏美术、技术美术 |
| 运营 `ops` | 产品运营、内容运营、用户运营、游戏运营、电商运营、客服 |
| 市场 `marketing` | 市场营销、品牌公关、商务拓展、投资分析 |
| 销售 `sales` | 销售、售前和解决方案 |
| 职能 `corporate` | 人力资源、财务、法务、行政 |
| 其他 `other` | 其他 |

共 43 项。不设第三级，更细的区分用技能标签。

### 经验

`student` 在校生、`fresh` 应届生、`any` 不限、`lt1` 1 年以内、`1to3`、`3to5`、`5to10`、`gt10`。

### 学历

`any` 不限、`junior_high` 初中及以下、`secondary` 中专或中技、`high` 高中、`college` 大专、`bachelor` 本科、`master` 硕士、`doctor` 博士。

### 公司规模

`0to20`、`20to99`、`100to499`、`500to999`、`1000to9999`、`gte10000`。

### 融资阶段

`none` 未融资、`angel` 天使轮、`a`、`b`、`c`、`d_plus` D 轮及以上、`listed` 已上市、`no_need` 不需要融资。

经验、学历、规模、融资阶段四张表的档位与 BOSS 直聘的筛选项一致。招聘类型参考腾讯校招的“应聘项目”。

## 接口

REST 是主体，MCP 工具是同一组处理函数的另一种入口。REST 路径都以 `/v1` 开头。

### 求职者

| MCP 工具 | REST | 只读 | 范围 |
|---|---|---|---|
| `profile_get` | `GET /me/profile` | 是 | `candidate:read` |
| `profile_update` | `PATCH /me/profile` | 否 | `candidate:write` |
| `resume_upload` | `PUT /me/resume/pdf` | 否 | `candidate:write` |
| `resume_set_visibility` | `PUT /me/resume/visibility` | 否 | `candidate:write` |
| `jobs_search` | `GET /jobs` | 是 | `candidate:read` |
| `job_get` | `GET /jobs/{id}` | 是 | `candidate:read` |
| `application_create` | `POST /applications` | 否 | `candidate:apply` |
| `applications_list` | `GET /applications` | 是 | `candidate:read` |
| `application_withdraw` | `POST /applications/{id}/withdraw` | 否 | `candidate:apply` |
| `invitation_respond` | `POST /applications/{id}/respond` | 否 | `candidate:apply` |

### 招聘者

| MCP 工具 | REST | 只读 | 范围 |
|---|---|---|---|
| `company_upsert` | `PUT /company` | 否 | `recruiter:write` |
| `job_create` | `POST /jobs` | 否 | `recruiter:write` |
| `job_update` | `PATCH /jobs/{id}` | 否 | `recruiter:write` |
| `job_close` | `POST /jobs/{id}/close` | 否 | `recruiter:write` |
| `candidates_search` | `GET /candidates` | 是 | `recruiter:read` |
| `candidate_get` | `GET /candidates/{id}` | 是 | `recruiter:read` |
| `job_applications_list` | `GET /jobs/{id}/applications` | 是 | `recruiter:read` |
| `invitation_create` | `POST /invitations` | 否 | `recruiter:invite` |
| `application_reject` | `POST /applications/{id}/reject` | 否 | `recruiter:invite` |

### 两种身份共用

| MCP 工具 | REST | 只读 | 范围 |
|---|---|---|---|
| `application_get` | `GET /applications/{id}` | 否 | 各自的 `read` |
| `events_poll` | `GET /events` | 是 | 任意 |
| `quota_get` | `GET /quota` | 是 | 任意 |

共 22 个工具，其中 9 个只读。

`application_get` 没有标为只读：招聘者第一次调用时，投递会从“已投递”变成“已查看”，并给求职者发一条事件。它是幂等的，重复调用不再产生变化。

几个容易写错的细节：

- `profile_update` 是部分更新，只改传入的字段。数组字段整体替换。
- `resume_upload` 在 MCP 里接收 base64 内容，在 REST 里接收 `multipart/form-data`。
- `application_create` 的入参是 `job_id`、可选的 `custom_resume`、可选的 `note`。
- `invitation_create` 有两种用法：传 `application_id` 是回应投递，传 `job_id` 加 `candidate_id` 是主动邀约。后一种会新建一条投递。
- `invitation_respond` 的入参是 `accept`（布尔）、接受时必填的 `slot`、可选的 `note`。`slot` 必须是邀约里给出的时间之一。
- `job_close` 会把这个岗位下所有未结束的投递改成“已关闭”。
- `job_get` 和 `candidate_get` 返回的对象里带公司或求职者的基本资料，agent 不需要再查一次。

### 搜索

岗位搜索的过滤项：`q`（关键词）、`recruit_type`、`category`、`city`、`remote`、`degree`、`grad_year`、`days_per_week_max`、`min_months_max`、`salary_min`、`salary_unit`、`skills`、`company_id`。只返回 `open` 状态的岗位。

求职者搜索的过滤项：`q`、`recruit_type`、`city`、`degree`、`grad_year`、`days_per_week_min`、`skills`。只返回公开了简历的求职者。

两个搜索都用游标分页，每页最多 50 条，按更新时间倒序。服务端不打分。结果里的列表项只含摘要字段，详情另取。

`salary_min` 必须和 `salary_unit` 一起传，只匹配同一单位的岗位。两种单位之间不换算。

### 错误格式

所有错误返回同一个结构：

```json
{
  "error": {
    "code": "invalid_transition",
    "message": "这条投递已经被撤回，不能再发邀约。",
    "details": { "current_status": "withdrawn" }
  }
}
```

`message` 写给 agent 看：说清楚发生了什么，能做什么。错误码有 `unauthorized`、`forbidden_scope`、`not_found`、`validation_failed`、`invalid_transition`、`duplicate_application`、`quota_exceeded`、`job_not_open`。

`validation_failed` 的 `details` 里逐个列出出错的字段和原因，agent 可以据此改正后重试。

## 技术选型

| 部分 | 选择 | 原因 |
|---|---|---|
| 语言和框架 | Rust、axum、tokio | |
| 数据库 | SQLite，开 WAL | 单机单文件，备份就是复制文件 |
| 数据库访问 | sqlx | 编译期检查 SQL |
| 全文搜索 | SQLite FTS5，trigram 分词 | 默认分词器不切分中文，trigram 能做子串匹配 |
| MCP | rmcp，Streamable HTTP，挂在 `/mcp` | 官方 Rust SDK |
| 接口文档 | utoipa 生成 OpenAPI | 从代码生成，不会和实现脱节 |
| 文件 | PDF 存本地目录 | 数据库里只存路径和哈希 |
| 日志 | tracing，每个请求带请求编号 | |

trigram 分词至少要 3 个字符才能命中。搜“后端”这类两个字的词时，退回到对标题和技能标签做 `LIKE` 匹配。

仓库只放代码。数据库文件、PDF 目录、GitHub 应用的密钥都在服务器上，不进仓库。

### 部署

一个二进制文件，一个数据目录，前面放 Caddy 或 nginx 做 HTTPS。配置走环境变量：监听地址、数据目录、对外的基础地址、GitHub 应用的编号和密钥、四个限额。

## 演示数据

演示期间所有数据都是模拟的。

- 岗位：参考腾讯校招、DeepSeek 招聘页的公开岗位，改写成约 30 条，`source_url` 指向参考的原页面。
- 公司：名称后加“（演示）”，如“腾讯（演示）”。服务一旦部署到公网，任何人都能看到这些岗位，名称上必须能看出它不是真的。
- 求职者：5 到 10 份虚构简历，不用真人信息。
- 招聘者：由你自己扮演，所以这些岗位都可以投，也都会有人回应。

数据由一个导入命令写进服务器的数据库。种子文件不进仓库。

## 技能包

仓库里放一个技能包，两种身份共用。内容：

- 怎么连接：MCP 地址，或设备码登录的步骤。
- 求职者一侧：怎么把一份 PDF 或 Markdown 简历整理成 `profile_update` 的入参；搜索时先用硬条件过滤，再自己读详情判断；投递前把 `custom_resume` 和备注给人看一遍。
- 招聘者一侧：怎么把一段岗位描述整理成 `job_create` 的入参；实习岗位记得填每周天数和最短月数。
- 轮询：什么时候调 `events_poll`，间隔多久。
- 规矩：简历里只写资料里有的事实；被拒绝后不重复投；遇到 `quota_exceeded` 就停，不重试。

## 验收

开两个 Claude Code 会话，都装上技能包，完成下面的流程并录屏：

1. 会话 A 以招聘者身份登录，创建公司，发布一个日常实习岗位。
2. 会话 B 以求职者身份登录，上传简历，按“北京、日常实习、每周 4 天”搜索，找到这个岗位并投递。
3. 会话 A 轮询到新投递，查看详情，发出带 3 个可选时间的邀约。
4. 会话 B 轮询到邀约，接受并选一个时间。
5. 会话 A 读到求职者的手机和邮箱。会话 B 读到公司的联系邮箱。

全程只有两次 GitHub 授权需要人操作。

## 以后再做

- 微信登录和实名。需要企业主体。
- 公司认证。
- 服务端的“每次确认”：由服务端给人发确认链接。
- 自由对话：硬条件通过后，双方 agent 限定轮数的对话。
- 回调通知。
- 一家公司多个招聘者。
