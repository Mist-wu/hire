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

- 网页和 App。唯一的例外是登录时的一个授权确认页，原因见“登录”一节。
- 服务端跑模型。解析简历、给岗位打分都交给用户的 agent。
- 自由对话。双方只通过固定的状态和一段备注交流。
- 公司资质审核。所有公司都标为“未认证”。
- 回调通知。agent 只能轮询。

## 账号、身份和令牌

一个账号对应一个 GitHub 用户。一个账号只能有一种身份，第一次登录时选定，之后不能更改：

| 身份 | 能做什么 | 需要先有 |
|---|---|---|
| 求职者 `candidate` | 维护资料和简历、搜索岗位、投递、回应邀约 | 无 |
| 招聘者 `recruiter` | 维护公司、发岗位、搜索求职者、邀约、拒绝 | 一家公司 |

身份不能兼任，是为了让活跃度和决定比例这些信号可信：同一个人不能自己投自己的岗位、自己邀约自己。想两边都试，要用两个 GitHub 账号。

令牌带权限范围，服务端按范围放行或拒绝。令牌只有账号那种身份的三个范围。客户端也可以明确申请其中几个范围，比如只读。每次请求时，服务端还会按账号的身份再过滤一遍令牌的范围。

| 范围 | 覆盖的动作 |
|---|---|
| `candidate:read` | 看自己的资料和投递、搜索和查看岗位 |
| `candidate:write` | 改资料、传简历、设置简历是否公开、管理订阅、删除资料 |
| `candidate:apply` | 投递、撤回、回应邀约和录用 |
| `recruiter:read` | 搜索和查看求职者、看收到的投递 |
| `recruiter:write` | 改公司、发布、修改和关闭岗位 |
| `recruiter:invite` | 发出邀约和录用、拒绝 |

事件和限额两个接口，任何令牌都能调。

“始终允许、每次确认、禁止”三档由客户端提供，服务端不实现。服务端只保证两件事：每个动作是一个独立的 MCP 工具，令牌没有的范围一律拒绝。

### 登录

有两条路，签出的令牌格式相同。两条路都靠 GitHub 确认身份，hire 自己不存密码。

**（1）MCP 连接器：标准 OAuth。** 服务端实现授权服务器的元数据、动态客户端注册、授权和换令牌四组端点，强制使用 PKCE。流程是：

1. 客户端打开授权地址，服务端直接跳转到 GitHub。
2. GitHub 登录后跳回服务端，服务端显示一个授权确认页。
3. 人在确认页上点授权或拒绝。账号第一次登录时，还要在这一页从求职者和招聘者里选一个。
4. 服务端带着授权码跳回客户端，客户端换令牌。

确认页是 hire 唯一的页面，不能省。客户端可以自行注册，如果没有确认这一步，任何人都能注册一个客户端，再诱导已登录过的用户点一个链接，悄悄拿到他的令牌。确认页上写明是哪个客户端、授权后跳到哪个地址，以及它能做的每一类事。

确认页只能在发起授权的那个浏览器里完成。服务端在第 1 步种一个 cookie，第 2、3 步都要核对它。

令牌拿到的范围按两步算：先取客户端申请的范围，没申请就算全部；再只留账号那种身份的。很多客户端会直接申请服务端支持的全部范围，所以第二步不能省。客户端只申请了另一种身份的范围时，确认页直接说明这个账号是什么身份，不发令牌。

连接器地址只有一个：`/mcp`。工具列表按令牌的范围过滤，求职者和招聘者各看到自己能用的工具。

**（2）命令行和技能包：设备码。** agent 向服务端要一个设备码，并说明要哪些范围，只能是一种身份的。账号已经是另一种身份时，换令牌这一步返回 `access_denied`。服务端转去向 GitHub 申请，把 GitHub 的验证地址和用户码返回给 agent。人在 `github.com/login/device` 输入用户码。agent 轮询换令牌的端点，拿到令牌。这条路不经过 hire 的任何页面。

令牌是随机串，库里只存哈希。访问令牌有效 1 小时，刷新令牌有效 30 天。刷新令牌只能用一次，每次刷新都换一对新的。授权码也只能用一次，5 分钟内有效。

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
| `active_at` | 时间 | 招聘者最近活跃时间，见“活跃度” |

公司不能重名。比较时不区分大小写和全半角，也不看空白，所以“Acme Lab”和“ACMELAB”算同一个名字，用全角字母写的也一样。因为没有认证，重名只会让人分不清谁是谁。公司改名后，名下岗位的搜索文本跟着重算，按新名字能搜到。一家公司只属于创建它的那个账号。通过接口，一个账号只能创建和修改一家公司。演示数据导入时会在一个账号下挂多家公司，这时发布岗位要用 `company_id` 指定是哪一家。

### 岗位 `jobs`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | |
| `company_id` | 字符串 | |
| `title` | 字符串 | 60 字以内 |
| `recruit_type` | 枚举 | 见“招聘类型” |
| `category` | 枚举 | 见“职类” |
| `cities` | 字符串数组 | 至少一个。“北京市”存成“北京”，搜索时也一样处理 |
| `remote` | 布尔 | 是否可远程 |
| `experience` | 枚举 | 见“经验” |
| `degree` | 枚举 | 见“学历”，表示最低要求 |
| `grad_years` | 整数数组 | 面向届别，如 `[2027, 2028]`，可空 |
| `salary_min`、`salary_max` | 整数 | 面议时可空 |
| `salary_unit` | 枚举 | `per_day`（元/天）或 `k_per_month`（千元/月） |
| `salary_negotiable` | 布尔 | |
| `days_per_week` | 整数 | 仅实习，1 到 7 |
| `min_months` | 整数 | 仅实习，最短实习月数 |
| `convertible` | 布尔 | 仅实习，能否转正，可空 |
| `duties` | 文本 | 岗位职责 |
| `requirements` | 文本 | 任职要求 |
| `bonus` | 文本 | 加分项，可空 |
| `skills` | 字符串数组 | 技能标签，最多 15 个 |
| `headcount` | 整数 | 招聘人数，可空。录用人数到了这个数，岗位自动暂停，已经发出的录用也不能再接受 |
| `deadline` | 日期 | 可空。不能填过去的日期；过了这一天，岗位不出现在搜索里，也不能投递和主动邀约 |
| `status` | 枚举 | `open`、`paused`、`closed` |
| `questions` | 对象数组 | 筛选问题，最多 3 个，见“筛选问题” |
| `detail_views` | 整数 | 详情被别人读取的次数，不去重，只在 `job_stats` 里返回 |

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
| `active_at` | 时间 | 是 | 最近活跃时间，见“活跃度” |
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
| `answers` | 对象数组 | 筛选问题的回答，连题目一起存，岗位之后改了问题也不受影响 |
| `decided_at` | 时间 | 招聘者第一次做出决定（邀约或拒绝）的时间，用来算决定比例 |
| `reject_reason` | 枚举 | 招聘者拒绝时选的原因，见“投递状态” |
| `offer` | 对象 | 录用内容：`start_date`、`salary`、`salary_unit`、`reply_by`，都可空 |
| `closed_by` | 枚举 | `candidate`、`recruiter`、`system`，结束时填 |

每次状态变化在 `application_logs` 里记一行：谁、什么时候、从哪个状态到哪个状态、备注。备注 500 字以内。

`invitation` 的字段：`mode`（`online`、`onsite`、`phone`）、`slots`（1 到 5 个可选时间）、`location`（线下地址或会议说明，可空）。

### 订阅 `subscriptions`

求职者保存的一组岗位搜索条件，每个账号最多 5 个。字段：`id`、`name`、`filters`（和岗位搜索的过滤项相同）、`cursor_at`（已经算到哪个发布时间）。

## 活跃度

BOSS 直聘靠“刚刚活跃”“回复率”让求职者避开没人管的岗位。这里给 agent 同样的信号。

| 信号 | 在哪 | 怎么算 |
|---|---|---|
| 招聘者最近活跃时间 | `jobs_search` 的 `recruiter_active_at`，`job_get` 的 `recruiter.active_at` | 账号最近一次主动操作的时间 |
| 决定比例 | `job_get` 的 `recruiter.decision_rate` | 这家公司近 90 天收到的投递里，招聘者邀约或拒绝过的比例。只是查看不算。没有投递时为 `null` |
| 平均决定用时 | `job_get` 的 `recruiter.avg_decision_hours` | 从投递到做出决定的平均小时数 |
| 求职者最近活跃时间 | `candidates_search` 和 `candidate_get` 的 `active_at` | 账号最近一次主动操作的时间 |

两个搜索都有 `active_within_days` 过滤项。

这些信号要防 agent 刷。agent 读一遍投递、挂着轮询都不花力气，所以“已查看”不算做出决定，`events_poll` 和 `quota_get` 不算活跃。其余调用都算，一小时内只写一次库。

## 筛选问题

agent 可以批量投递，这是 agent 平台特有的风险。除了每天 20 次的限额，岗位还可以带最多 3 个筛选问题，投递时必须逐个回答。

- 每个问题有 `text`，可选 `options`（2 到 6 项）。有 `options` 是单选题，回答必须是其中一项；没有是问答题，500 字以内。
- `application_create` 的 `answers` 是字符串数组，顺序和岗位的 `questions` 一致。
- 没答或答错时返回 `validation_failed`，`details.questions` 里带着全部问题，agent 不用再查一次。
- 招聘者主动邀约时不需要回答。

这相当于 Moka 的申请表。它仍然是结构化的一问一答，不是自由对话。

## 订阅

BOSS 直聘用推荐把新岗位推给求职者。这里服务端不打分，改成订阅：求职者保存一组搜索条件，之后有新发布的岗位符合条件时，`events_poll` 里出现一条 `job.matched` 事件。每人最多 5 个订阅。条件存之前先归一化：城市别名统一，技能去重排序，空关键词去掉。换个写法的相同条件不能建两个。

匹配在拉取事件时才算，不在发布岗位时算。每次拉取最多查 5 个订阅，发布岗位不用遍历所有人的订阅。订阅只对创建之后开放的岗位生效：新发布的，以及暂停后重新开放的。每个订阅每次拉取最多写 20 条事件，没写完时 `has_more` 为 true，再拉一次就能拿到剩下的。同一个岗位只通知一次，哪怕它命中了几个订阅，或者暂停后又重开。

## 可见性

简历内容对所有登录用户公开，没有匿名阶段。只有三样东西受保护：手机号、邮箱、PDF 原件。

| 谁在看 | 能看到 |
|---|---|
| 任何招聘者 | 公开简历的全部内容，不含手机、邮箱、PDF |
| 收到投递的招聘者 | 另加这次投递的 `custom_resume` |
| 投递状态为“已接受”“已发录用”“已录用”的招聘者 | 另加手机、邮箱、PDF 下载 |
| 投递状态为“已接受”“已发录用”“已录用”的求职者 | 公司的 `contact_email` |

`resume_public` 关闭时，求职者不出现在搜索结果里。已经收到他投递的招聘者仍然能看他的简历。

PDF 里通常印着手机号，所以它和手机号受同样的保护。

## 投递状态

共 9 个状态，后 4 个是终态。

| 状态 | 含义 |
|---|---|
| `applied` 已投递 | 求职者投了，招聘者还没看 |
| `viewed` 已查看 | 招聘者读过这条投递的详情 |
| `invited` 已邀约 | 招聘者发出了面试邀约 |
| `accepted` 已接受 | 求职者接受了邀约，双方可见联系方式 |
| `offered` 已发录用 | 面试之后，招聘者发出了录用 |
| `hired` 已录用 | 求职者接受了录用 |
| `rejected` 已拒绝 | 招聘者拒绝了投递或撤回了录用，或求职者拒绝了邀约或录用 |
| `withdrawn` 已撤回 | 求职者主动撤回 |
| `closed` 已关闭 | 岗位关闭，系统结束了这条投递 |

允许的变化：

| 从 | 到 | 谁触发 | 怎么触发 |
|---|---|---|---|
| — | `applied` | 求职者 | 投递 |
| — | `invited` | 招聘者 | 主动邀约，跳过前两步 |
| `applied` | `viewed` | 招聘者 | 第一次读投递详情，自动变化 |
| `applied`、`viewed` | `invited` | 招聘者 | 发出邀约 |
| `invited` | `accepted` | 求职者 | 接受，并选一个时间 |
| `invited` | `rejected` | 求职者 | 拒绝邀约 |
| `accepted` | `offered` | 招聘者 | 发出录用 |
| `offered` | `hired` | 求职者 | 接受录用 |
| `offered` | `rejected` | 求职者 | 拒绝录用 |
| 任何非终态 | `rejected` | 招聘者 | 拒绝，必须选原因 |
| 任何非终态 | `withdrawn` | 求职者 | 撤回 |
| `applied`、`viewed`、`invited` | `closed` | 系统 | 岗位被关闭 |

招聘者拒绝时必须从下面选一个原因，求职者能看到：`skills_mismatch`（技能不匹配）、`experience_mismatch`（经历不匹配）、`education_mismatch`（学历或届别不符）、`availability`（到岗时间或每周天数不合适）、`interview_failed`（面试未通过）、`position_filled`（岗位已招满）、`other`（其他）。

关闭岗位只结束还没约上面试的投递。已接受邀约和已发录用的投递继续走完。

其他变化一律返回 `invalid_transition` 错误，并在错误里带上当前状态。

同一对岗位和求职者，上一条投递被拒绝或撤回后 7 天内，双方都不能再发起：求职者不能再投，招聘者不能再主动邀约。因岗位关闭或过期而结束的不受这个限制。已经被这个岗位录用的人，不能再对它发起新的投递。

对已经发出的邀约再发一次邀约，就是改时间。对方还没回应时，状态仍是“已邀约”。对方已经接受时，状态从“已接受”回到“已邀约”，选定的时间清空，等对方重新选；这期间双方看不到联系方式。一条投递最多改 3 次时间。面试时间过了的邀约不能再接受，面试时间最远只能约到 365 天以后。

录用可以带答复期限 `reply_by`。过了这一天，求职者不能再接受，只能拒绝。岗位填了招聘人数、录用人数已经到了的时候，剩下的录用也不能再接受；招聘者加了名额之后才可以。这个判断和改状态在同一条语句里，两个人同时接受最后一个名额时只有一个成功。

每天有一个定时任务清理没人管的投递，改成“已关闭”，给双方各发一条 `application.expired` 事件：

- 投递 30 天没等到决定。
- 邀约给出的时间全过了，还没回应。
- 约好的面试过了 30 天没有结果。
- 录用过了答复期限，或者发出 30 天没回应。

## 事件

每次状态变化，给对方写一条事件。agent 轮询事件接口来了解进展。

| 事件类型 | 发给谁 | 什么时候 |
|---|---|---|
| `application.created` | 招聘者 | 收到新投递 |
| `application.viewed` | 求职者 | 投递被查看 |
| `invitation.created` | 求职者 | 收到邀约 |
| `invitation.updated` | 求职者 | 邀约改了时间 |
| `invitation.accepted` | 招聘者 | 邀约被接受 |
| `offer.created` | 求职者 | 收到录用 |
| `offer.accepted` | 招聘者 | 录用被接受 |
| `application.rejected` | 对方 | 任一方拒绝。招聘者拒绝时带 `reason` |
| `application.withdrawn` | 招聘者 | 求职者撤回 |
| `application.closed` | 求职者 | 岗位关闭 |
| `application.expired` | 双方 | 投递过期 |
| `job.matched` | 求职者 | 订阅命中了新岗位。没有投递编号，带 `job_id` 和 `subscription_id` |

事件带自增序号。服务端给每个账号记着拉到了哪个序号，直接调用就只返回之后的新事件，一次最多 100 条。agent 换了会话不用记序号，也不会把旧事件再报一遍。想重看旧事件时传 `after`，传 0 从头看。服务端的记录只按真正返回过的事件往前挪，传一个很大的 `after` 不会让之后的事件丢掉。事件保留 30 天。

事件里只放投递编号、岗位标题、对方名称和备注。详情让 agent 再调投递详情接口。

建议的轮询间隔写在技能包里：有未结束的投递或有订阅时每 10 分钟一次，否则不轮询。

## 限额

| 对象 | 上限 | 说明 |
|---|---|---|
| 求职者投递 | 每天 20 次 | 撤回不返还。上限写在插入语句的条件里，并发请求也挤不过去 |
| 招聘者主动邀约 | 每个岗位每天 20 次 | 回应投递的邀约不计入 |
| 搜索 | 每分钟 30 次 | 求职者和招聘者相同 |
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

REST 是主体，MCP 工具是同一组处理函数的另一种入口。REST 路径都以 `/v1` 开头。两者由同一份操作注册表生成，OpenAPI 文档（`/v1/openapi.json`）也是。

范围一栏写了两个的，有其中一个就能调用。

### 求职者

| MCP 工具 | REST | 只读 | 范围 |
|---|---|---|---|
| `profile_get` | `GET /me/profile` | 是 | `candidate:read` |
| `profile_update` | `PATCH /me/profile` | 否 | `candidate:write` |
| `resume_upload` | `PUT /me/resume/pdf` | 否 | `candidate:write` |
| `profile_delete` | `POST /me/profile/delete` | 否 | `candidate:write` |
| `application_create` | `POST /applications` | 否 | `candidate:apply` |
| `applications_list` | `GET /applications` | 是 | `candidate:read` |
| `application_withdraw` | `POST /applications/{id}/withdraw` | 否 | `candidate:apply` |
| `invitation_respond` | `POST /applications/{id}/respond` | 否 | `candidate:apply` |
| `offer_respond` | `POST /applications/{id}/offer/respond` | 否 | `candidate:apply` |
| `subscription_create` | `POST /subscriptions` | 否 | `candidate:write` |
| `subscriptions_list` | `GET /subscriptions` | 是 | `candidate:read` |
| `subscription_delete` | `POST /subscriptions/{id}/delete` | 否 | `candidate:write` |

### 招聘者

| MCP 工具 | REST | 只读 | 范围 |
|---|---|---|---|
| `company_get` | `GET /company` | 是 | `recruiter:read` |
| `company_upsert` | `PUT /company` | 否 | `recruiter:write` |
| `job_create` | `POST /jobs` | 否 | `recruiter:write` |
| `job_update` | `PATCH /jobs/{id}` | 否 | `recruiter:write` |
| `job_close` | `POST /jobs/{id}/close` | 否 | `recruiter:write` |
| `job_stats` | `GET /jobs/{id}/stats` | 是 | `recruiter:read` |
| `candidates_search` | `GET /candidates` | 是 | `recruiter:read` |
| `candidate_get` | `GET /candidates/{id}` | 是 | `recruiter:read` |
| `job_applications_list` | `GET /jobs/{id}/applications` | 是 | `recruiter:read` |
| `invitation_create` | `POST /invitations` | 否 | `recruiter:invite` |
| `offer_create` | `POST /applications/{id}/offer` | 否 | `recruiter:invite` |
| `application_reject` | `POST /applications/{id}/reject` | 否 | `recruiter:invite` |

### 求职者和招聘者都有

| MCP 工具 | REST | 只读 | 范围 |
|---|---|---|---|
| `jobs_search` | `GET /jobs` | 是 | `candidate:read` 或 `recruiter:read` |
| `job_get` | `GET /jobs/{id}` | 是 | `candidate:read` 或 `recruiter:read` |
| `application_get` | `GET /applications/{id}` | 否 | `candidate:read` 或 `recruiter:read` |
| `events_poll` | `GET /events` | 是 | 任意 |
| `quota_get` | `GET /quota` | 是 | 任意 |

共 29 个工具。求职者能看到 17 个，其中 8 个只读；招聘者能看到 17 个，其中 9 个只读。

`application_get` 对求职者是只读的，对招聘者不是：招聘者第一次调用时，投递会从“已投递”变成“已查看”，并给求职者发一条事件。它是幂等的，重复调用不再产生变化。工具列表里的只读标记按令牌的身份给出。

另有两个下载 PDF 的地址，只有 REST，没有对应的工具：

- `GET /me/resume/pdf`：求职者下载自己上传的 PDF。
- `GET /applications/{id}/resume.pdf`：招聘者下载求职者的 PDF，投递必须是“已接受”“已发录用”或“已录用”。

几个容易写错的细节：

- `profile_update` 是部分更新，只改传入的字段。数组字段整体替换。专业、城市、简介、手机、邮箱传 `null` 表示清空。简历是否公开也在这里改（`resume_public`）。
- `profile_delete` 删除简历、手机、邮箱、PDF 和订阅，并撤回还没结束的投递。投递记录保留，但里面的定制简历和筛选问题回答会清掉。账号和身份保留，可以重新填资料。
- 所有链接字段只接受 http 和 https 地址。
- `resume_upload` 在 MCP 里接收 base64 内容。在 REST 里除了同样的 JSON，也接收 `multipart/form-data`（字段名 `file`）和直接发送的 PDF 内容。
- `application_create` 的入参是 `job_id`、可选的 `custom_resume`、可选的 `note`，岗位有筛选问题时还要 `answers`。姓名、学校、学历、毕业年份四项填齐后才能投递。
- `invitation_create` 有两种用法：传 `application_id` 是回应投递或改时间，传 `job_id` 加 `candidate_id` 是主动邀约。后一种会新建一条投递。线下面试必须写地址。
- 所有文本入参都不接受换行和制表符之外的控制字符。薪资上限是 10000000。教育、工作和项目经历的结束时间不能早于开始时间。
- `invitation_respond` 的入参是 `accept`（布尔）、接受时必填的 `slot`、可选的 `note`。`slot` 必须是邀约里给出的时间之一。
- `job_close` 会把这个岗位下还没约上面试的投递改成“已关闭”。
- `application_reject` 的 `reason` 必填。
- `job_stats` 返回漏斗：`applied`（求职者投递数）、`viewed`（查看过的）、`decided`（邀约或拒绝过的）、`invited`、`accepted`、`offered`、`hired`（走到过这一步的投递数），另有各状态当前的条数和拒绝原因分布。
- `job_get` 返回的对象里带公司的基本资料，agent 不需要再查一次。
- `jobs_search` 传 `mine=true` 时，列出调用者名下所有状态的岗位，需要 `recruiter:read`。
- 求职者调 `jobs_search` 和 `job_get` 时，结果里带 `my_application`：自己对这个岗位最近一条投递的编号和状态。招聘者调 `candidates_search` 和 `candidate_get` 时同理，带的是自己和这位求职者之间最近的一条。

### 搜索

岗位搜索的过滤项：`q`（关键词）、`recruit_type`、`category`、`city`、`remote`、`degree`、`grad_year`、`days_per_week_max`、`min_months_max`、`salary_min`、`salary_unit`、`skills`、`company_id`、`active_within_days`、`mine`。只返回 `open` 状态、没过截止日期的岗位，`mine=true` 时除外。

求职者搜索的过滤项：`q`、`recruit_type`、`city`、`degree`、`grad_year`、`days_per_week_min`、`skills`、`active_within_days`。只返回公开了简历的求职者。

两个搜索都用游标分页，每页默认 20 条、最多 50 条，岗位按发布时间倒序，求职者按注册时间倒序。修改岗位或资料不改变排位，翻页也不会因此漏掉或重复。服务端不打分。结果里的列表项只含摘要字段，详情另取。

`skills` 传多个时，命中任意一个就算匹配。`q` 里用空格隔开的多个词要全部出现。`degree` 在岗位搜索里表示“我的学历”，返回最低要求不高于它的岗位；在求职者搜索里表示“最低学历”。

`salary_min` 必须和 `salary_unit` 一起传，只匹配同一单位的岗位。两种单位之间不换算。

`days_per_week_max` 遇到没填每周天数的岗位（非实习）按 5 天算。`min_months_max` 不过滤没填最短月数的岗位。

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

全部跑在 Cloudflare 上，没有自己的服务器。

| 部分 | 选择 | 原因 |
|---|---|---|
| 运行环境 | Cloudflare Workers | 不用管进程和证书，演示规模在免费额度内 |
| 语言和框架 | TypeScript、Hono | Workers 上支持最好的组合 |
| 数据库 | D1 | 就是 SQLite，SQL 和本地开发一致 |
| 全文搜索 | SQLite FTS5，trigram 分词 | 默认分词器不切分中文，trigram 能做子串匹配 |
| 文件 | R2 存 PDF | 数据库里只存路径、文件名和大小 |
| 入参校验 | zod | 同一份定义用来校验、生成 MCP 工具的入参说明和 OpenAPI |
| MCP | 自己实现 Streamable HTTP 的无状态子集 | 只需要握手、列工具、调工具三件事，约 150 行，不依赖 Durable Objects |
| OAuth | 自己实现 | 授权码、刷新、设备码共用一张令牌表，约 400 行 |
| 测试 | vitest 加 Cloudflare 的测试插件 | 测试跑在真实的 Workers 运行时里，D1 用本地实例 |

trigram 分词至少要 3 个字符才能命中。搜“后端”这类两个字的词时，退回到对 `search_text` 列做 `LIKE` 匹配。`search_text` 在写入岗位或简历时由服务端拼好。

状态变化用乐观锁保证一致。每条投递有一个随机的 `rev` 字段。改状态、写日志、发事件三条语句放在同一个 batch 里，都以“`rev` 还是我读到的那个值”为条件。两个请求同时改同一条投递时，后到的那个整体不生效，并收到 `invalid_transition`。

MCP 测试里用官方 SDK 的客户端连了一遍，确认握手和工具调用能通。

仓库只放代码。数据库、PDF、GitHub 应用的密钥都在 Cloudflare 上，不进仓库。

### 部署

```bash
npx wrangler d1 migrations apply hire --remote
```

```bash
npx wrangler deploy
```

配置在 `wrangler.jsonc`：D1 和 R2 的绑定、四个限额、一个每天执行一次的定时任务。定时任务清理 30 天前的事件、过期的授权记录和令牌。

GitHub 登录要两个密钥，用 `wrangler secret put` 设置：`GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET`。对应的 GitHub OAuth 应用要把回调地址设成 `<服务地址>/oauth/github/callback`，并勾选 Enable Device Flow。没设密钥时，登录相关的端点返回“未配置”的错误，其余接口不受影响。

本地开发用 `npx wrangler dev`。在 `.dev.vars` 里写 `DEV_LOGIN=1` 会多出一个 `POST /oauth/dev/token` 端点，传一个用户名就能拿到令牌，不经过 GitHub。线上不设这个变量，端点不存在。

## 演示数据

演示期间所有数据都是模拟的。

- 岗位：参考腾讯校招、DeepSeek 招聘页的公开岗位改写，共 31 条，职责和要求是重新写的，薪资是编的。
- 公司：名称后加“（演示）”，如“腾讯（演示）”。服务部署在公网，任何登录的人都能看到这些岗位，名称上必须能看出它不是真的。
- 求职者：8 份虚构简历，不用真人信息。这些账号没有人能登录，只用来演示招聘者搜索。
- 招聘者：两家演示公司都挂在仓库所有者的 GitHub 账号下。他登录后就是这些岗位的招聘者，所以岗位都可以投，也都会有人回应。

数据由 `scripts/seed.mjs` 导入，可以重复执行：

```bash
node scripts/seed.mjs --url <服务地址> --remote
```

脚本用 SQL 写入账号、公司和几个 1 小时有效的临时令牌，然后通过 REST 接口创建岗位和简历，最后删掉临时令牌。岗位和简历走接口，是为了让搜索用的派生字段由服务端自己生成。种子文件 `seed/demo.json` 不进仓库。

## 技能包

技能包在 `skills/hire/SKILL.md`，求职者和招聘者共用。内容：

- 怎么连接：MCP 地址，或设备码登录的步骤。
- 求职者一侧：怎么把一份 PDF 或 Markdown 简历整理成 `profile_update` 的入参；搜索时先用硬条件过滤，再自己读详情判断；投递前把 `custom_resume` 和备注给人看一遍。
- 招聘者一侧：怎么把一段岗位描述整理成 `job_create` 的入参；实习岗位记得填每周天数和最短月数。
- 轮询：什么时候调 `events_poll`，间隔多久。
- 规矩：简历里只写资料里有的事实；被拒绝后不重复投；遇到 `quota_exceeded` 就停，不重试。

## 验收

开两个会话，用两个 GitHub 账号登录（一个账号只能有一种身份），都装上技能包，完成下面的流程并录屏：

1. 会话 A 以招聘者身份登录，创建公司，发布一个日常实习岗位。
2. 会话 B 以求职者身份登录，上传简历，按“北京、日常实习、每周 4 天”搜索，找到这个岗位并投递。
3. 会话 A 轮询到新投递，查看详情，发出带 3 个可选时间的邀约。
4. 会话 B 轮询到邀约，接受并选一个时间。
5. 会话 A 读到求职者的手机和邮箱。会话 B 读到公司的联系邮箱。
6. 会话 A 发出录用，会话 B 接受。会话 A 用 `job_stats` 看这个岗位的漏斗。

全程只有两次 GitHub 授权需要人操作。

## 以后再做

- 微信登录和实名。需要企业主体。
- 公司认证。
- 服务端的“每次确认”：由服务端给人发确认链接。
- 自由对话：硬条件通过后，双方 agent 限定轮数的对话。
- 回调通知。
- 一家公司多个招聘者。
- 招聘者删除公司。现在只能关闭岗位。
