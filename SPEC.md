# 📜 PaperLink · 双人手写通讯 完整方案（修订终稿）

> **一句话定位**：把 Riddle 的"会喝墨的日记"升级为"两人共写一本日记"——A 落笔的每一帧，按选定模式流式到 B 的纸上，像隔着信纸看对方写。
>
> **技术嫁接**：直接复用 Riddle 的 `inkpad.js`（笔迹+压感+溶解）、`hand.js`（手写渲染）、`diary.css`（主题）、`admin.html`（管理页框架）、`prompts.js` 改造成通讯协议；Cloudflare Pages + KV + Durable Object 部署链路原样继承。

---

## 一、两种通讯模式（核心）

| 模式 | 触发 | 行为 | 信纸同步 |
|---|---|---|---|
| **🌊 实时镜像** | 默认 / 模式开关选"实时" | A 每写完**一笔**(pointerup)，笔迹立即经 WS 发 B，B 端按 A 的 `durationMs` **同速重放**；A 书写过程 B 实时可见 | **强制同步**——A 切到任何主题/彩蛋信纸，B 即时跟随切换为同款（即使 B 未解锁该彩蛋也强制渲染） |
| **✉️ 寄信(发送)模式** | A 写完点"发送" | 本地 `pad.dissolve`（墨迹被喝掉，复用 Riddle）→ 整页笔迹+主题+墨色提交 → B 端**全过程镜像**：从"墨迹浮现"开始逐笔重放整页 | 同上，**强制同步** |

- **模式切换**：右下浮动栏"下一页"旁新增 `btn-mode` 图标（双向箭头 ⇄），tooltip"切换实时/寄信"；当前模式写入 `localStorage`，进房时广播 `mode_change`。
- **默认**：新房间默认"寄信模式"（更接近原著"停笔→喝墨→回信"的仪式感）；老用户可一键切实时。

---

## 二、账户与对话模型

### 2.1 注册 / 登录（`/join`，Cloudflare Turnstile）

1. 居中毛玻璃卡片（380px / 18px 圆角），顶部新应用图标（见 §四）。
2. 字段：昵称(2–16 字)、头像(6 选 1，预设手写风圆形 56px)、**邀请码(可选)**、**Turnstile 人机验证 widget**。
3. 提交：`POST /api/auth/register{nick,avatar,code?,turnstileToken}` → 服务端用 `secret=SECRET_TURNSTILE` + `response` 调 `https://challenges.cloudflare.com/turnstile/v0/siteverify` 校验；失败返 403。
4. 成功：`sessionStorage.pl_token` + KV `sessions/{sid}{nick,avatar,roomCode,lastSeen}`。
5. Secrets 新增：`SECRET_TURNSTILE`（服务端校验密钥，CF Dashboard 获取）。

### 2.2 对话大厅（核心）

6. **每个账户同时最多 5 个对话**（KV 存 `conversations_by_user/{sid}:[cid...]`，数组上限 5）。
7. 达到 5 个时创建新对话 → 弹"请先删除一个旧对话" → 跳转大厅。
8. **应用图标旁新增"对话大厅"按钮**（header 右二，书本堆叠 SVG），点击进入 `/hall`。
9. **对话大厅页**（`/hall`）：
   - 顶部搜索栏：圆角胶囊输入框，占位**"请输入 9 位邀请码"**（格式 `/^[A-Za-z]\d{8}$/`，与创建码同源）；非 9 位仅本地过滤已有对话。
   - 下方网格：每个对话是一张**"书"形卡片**——封面为对话当前信纸主题缩略，书名处显示**对话名**，右下角页数+未读角标；点击进入该对话书写页。
   - 卡片右上"⋯"菜单：重命名 / 删除（删除需确认，清该对话 pages+归档）。
10. **创建房间**：无邀请码进入 → `genInviteCode()` 生成 9 位码 → 新建 `rooms/{code}{host,guest:null,name:"对话1",createdAt,lastActiveAt,mode}`；**创建时可填"对话名"，不填则按该用户已有对话数自动命名"对话1"~"对话5"**（检测空缺补位）。
11. **加入房间**：填邀请码 → 校验存在且 guest 空 → 写入 guest=sid，双方跳书写页。
12. **满房**：guest 已存在 → 返 `{error:"room_full"}`，提示"该日记本已有两位主人"。
13. 邀请码显示：书写页 header 中部"邀请码：K38472091"（点复制 →"已复制 ✓"1.5s）。

### 2.3 账户面板（`/me`，header 头像点击）

14. 头像+昵称(inline 编辑，保存广播 `nick_update`/`avatar_update`)+ 当前房间邀请码(复制)+ "退出房间"+"注销"+"销毁日记本"(删房间+pages+会话，GDPR 风格)。
15. 多端互斥：同 sid 新设备登录 → 旧设备收 `kicked` →"已在别处登录"→ 清 token。

---

## 三、信纸 / 书写区 / 工具栏

### 3.1 主题与强制同步

16. 复用 Riddle 4 套：`tom`/`parchment`/`midnight`/`letter`；彩蛋套（§七）未解锁时普通用户看不到，但**实时/寄信模式下 A 用彩蛋纸 → B 强制同步渲染同款**（"强制同步"优先级最高）。
17. 主题切换：右上浮动栏 4–6 个小圆点，当前描边高亮；切换广播 `theme_change`，对端即时跟随。
18. 页脚无限延伸（Riddle 修改）：`min-height` 随内容增长，顶部 `padding-top` 防与顶栏重合，自定义细窄滚动条。

### 3.2 工具栏按钮精确定位（右下浮动栏，距边 16px，竖排 gap 10px）

| # | 按钮 | 图标 | 功能 |
|---|---|---|---|
| 19 | `btn-next-page` | 书页翻页 ▶| | 新开本地空白页 |
| 20 | `btn-eraser` | 橡皮 | 切换擦除模式，cursor 变圆 |
| 21 | `btn-undo` | ↺ | 撤销上一笔 |
| 22 | `btn-clear`(🗑) | 垃圾桶 | **一键全屏清除橡皮擦**——确认后发 `clear_all` → 对端镜像整页清除（B 页同 `pad.dissolve` 清空） |
| 23 | `btn-fullscreen` | 四角箭头 | 全屏（图标互换，复用 Riddle） |
| 24 | `btn-fade` | 半透圆圈 | 15% 透明度（复用 Riddle，复位旁） |
| 25 | `btn-mode` | ⇄ | 实时/寄信切换 |
| — | 布局 | — | `position:fixed; right:16px; bottom:16px; flex-direction:column`；横屏改 `bottom:auto; top:50%; translateY(-50%)` |

### 3.3 发送栏（寄信模式）

27. 底部发送栏(高 56px，书写态显示)：左"取消"(灰)、中"停笔即就绪 · 点发送"、右**"发送"主按钮**(胶囊 高40/宽≥96/圆角20/`--brand` 紫 `#7a5cff`)。

### 3.4 笔迹（复用 Riddle inkpad + hand）

28. Pointer Events 主 + Touch 备份；DPR≤3；坐标映射 `getCanvasPoint`；Catmull-Rom→Cubic Bezier + 法线偏移变宽填充（无锯齿）；压感 1.5–5.5px（管理页可调上限 12）；同速重放按 A 的 `durationMs`。

---

## 四、品牌 / 图标 / 应用名

29. 应用名 `PaperLink · 两人共写一本日记`，短名 `PaperLink`(manifest)。
30. 主图标：半开皮革日记本+鹅毛笔+墨滴（双人意象：封面两侧各一行手写字）；**纯 SVG `<symbol>` 内联**（继承 Riddle 不用外部图），`public/icons/icon.svg` + 192/512png + apple-touch。
31. 调色随主题；品牌色 `--brand:#7a5cff`；加载屏 `#app-loading` 墨滴下落 CSS 动画 2s 淡出；错误页复用 Riddle `glass-card`+⚠三角。
32. UI 字体系统栈（Apple 风）+ Dancing Script(英)+ Ma Shan Zheng(中回退)。

---

## 五、实时事件 / 消息 / 冲突处理

### 5.1 WS 事件

33. `stroke` / `drawing` / `erase` / `undo` / `clear_all` / `theme_change` / `mode_change` / `cursor` / `nick_update` / `avatar_update` / `ping`。
34. 笔迹帧：`{t:"stroke",page,id,pts:[{x,y,p,t}...],color,durationMs}`；擦除 `{t:"erase",ids}` 或区域；`clear_all` 整页清除镜像。
35. 默认"逐笔"(pointerup 后发一整笔)；设置项可切"逐点流"（更实时 / 更耗流）。

### 5.2 寄信模式

36. A 点发送 → 本地 `pad.dissolve` → `page_commit`(笔迹+主题+墨色+ts) → DO 存 KV → 广播 `new_page` → B 书信集顶部推入，**B 打开该页时从"墨迹浮现"逐笔全过程重放**（对端重放节奏 = A 原 `durationMs`）。
37. 书页式消息：每封"信"= 一页；B 书信集按时间正序书册，swipe/◀▶翻页；每页卡片顶部发件人头像+昵称+"3 分钟前"+信纸缩略+"打开此页"。

### 5.3 冲突处理

38. A 发时 B 书写：B 不中断，顶部横幅"A 寄来一页新信"(计数)+ 书信集静默入页；B 写完点发送/取消后横幅可"现在查看"；B 空闲 2.5s 无输入则横幅自动展开预览。
39. A 连续发多条：DO 按序，B 空闲逐页轻弹；B 书写中仅横幅"+N 页新信"；设置项"新信到达"：① 横幅+计数(默认) ② 自动展开最新 ③ 仅红点角标。
40. A/B 同时发：DO 按 ts 排序；同人连续页合并为"连续页"。
41. 离线：A 发时 B 离线 → DO 缓存 KV → B 重连拉取未读队列依次重放；B 上线 DO 推送"对方暂未在线，信会等 TA 回来"。

---

## 六、KV 存储优化

### 6.1 用户信息共享本地存储（回应"KV 不够"）

42. **用户信息不入/少入 KV**：昵称/头像/主题偏好/对话列表/未读计数/邀请码缓存 **全部存浏览器 `localStorage` + `sessionStorage`**（仅 `pl_token`+`sid`+`lastSeen` 走 KV 用于在线校验）。
43. KV 只持久化"跨设备/服务端必需"：`rooms/{code}`、`pages/{pid}`(笔迹，体积大户)、`conversations/{cid}`、`redemptions/{code}`、`sessions/{sid}`(仅 sid→lastSeen 映射，不含昵称)。
44. 效果：N 个用户 × 5 对话 × 多页笔迹，**昵称/头像/偏好零 KV 占用**，KV 仅承载笔迹+房间元数据，容量压力大幅下降。

### 6.2 笔迹精简 + 自动遗忘（可调参数）

45. 单页笔迹点 >5000 提示"写得太满，建议翻页"，可抽样精简。
46. **同一对话仅保留最近 10 页，超出自动遗忘最早页**（与 Riddle 20 轮 FIFO 同源；**"10"为可调参数 `keep_pages`，默认 10，管理页可调 5–50**）；遗忘页 `pages/{pid}` 删 KV，对话 `pageIds` 移出（不归档，直接丢笔迹以省空间；元数据 7 天 TTL）。
47. 笔迹提交前 `simplifyPts(pts,tol=1.2)`(Douglas-Peucker) 压缩；超过 50 页对话触发归档最早 30% 页（仅笔迹 JSON+缩略，`archived` 标记，懒加载）。
48. **房间无活跃超时**：`lastActiveAt` 超 **24 小时** → 标 `dormant` → 删 `pages`(释放 KV) → 保留元数据 7 天可 revive；**超 24 小时彻底删除**。
49. 心跳：WS 每 60s `ping` → DO 更新房间+会话 `lastActiveAt`；单房间 pages 总 >5MB → 强制归档最早 30%。

### 6.3 KV 键空间

50. `rooms/{code}` / `sessions/{sid}`(轻量) / `pages/{pid}`(TTL 30 天) / `conversations/{cid}` / `messages/{mid}`(索引) / `conversations_by_user/{sid}`(最多 5 cid) / `redemptions/{code}` / `audit/{id}`(7 天)。

---

## 七、兑换码 / 彩蛋 / 信纸模板

### 7.1 兑换码

51. 格式 `PL-XXXX-XXXX`(8 位字母数字分组)；`/me` 底部"兑换码"输入+兑换按钮 → `POST /api/redeem` → 校验未使用 → 解锁彩蛋写入 `sessions/{sid}.unlockedEggs`。
52. 彩蛋目录：E1 星夜信纸 / E2 樱花信纸 / E3 玫瑰金墨水 / E4 金箔墨迹图标 / E5 "共写 N 页"头像框 / E6 墨迹 3 秒渐隐。

### 7.2 管理页 · 信纸模板文件上传（无 AI）

53. **管理页去掉全部 AI 参数**，仅保留：应用参数 / 账户·会话 / 彩蛋·模板 / 诊断。
54. **新增"信纸模板"模块**：每条模板 = 一个**可上传的 CSS 片段文件**（用户/运营自行编写样式）+ 可选**背景图片上传**。
   - 上传区：拖拽/点击上传 `.css` 文件（服务端校验：仅允许 CSS 变量/选择器作用在 `.page-paper` 及其子元素，拒绝 `@import`/`url()` 外链/JS 注入；大小 ≤ 50KB）+ 可选背景图(`.png/.jpg` ≤ 500KB，转 base64 内联或存 KV `template_assets/{id}`)。
   - 模板结构：`{id, name, css, bgImageId|null, inkColor, createdAt, enabled}`；启用后在主题切换栏多出一个"自定义"缩略点。
   - 笔迹色 `inkColor` 可固定或"随主题"；用户上传模板即视为一种"彩蛋"，写入解锁列表。
55. 管理页"彩蛋/运营"：彩蛋目录 CRUD + **兑换码批量生成导出 CSV** + **信纸模板上传/启用/删除/预览**。
56. 管理页变量命名沿用 Riddle 全小写 snake_case；诊断 `/api/setup` + `/api/admin/diag`（DO 实例/在线 WS/KV 读写计数/各房间页数）。

---

## 八、API 端点（中文说明）

| # | 端点 | 说明 |
|---|---|---|
| 57 | `POST /api/auth/register{nick,avatar,code?,turnstileToken}` | 注册/建房或加入，返 `{token,sid,room?}` |
| 58 | `POST /api/auth/login{sid}` / `POST /api/auth/logout{sid}` | 续期 / 注销 |
| 59 | `POST /api/room/create{sid,name?}` | 建房，name 缺省按用户对话数命名"对话1"~"对话5" |
| 60 | `POST /api/room/join{sid,code}` | 加入，返 `{room}` 或 `room_full/not_found` |
| 61 | `POST /api/room/leave{sid}` / `GET /api/room/:code` | 离开 / 房间元信息 |
| 62 | `WS /api/ws?sid=&room=` | Durable Object，收发 §5.1 事件 |
| 63 | `POST /api/page/commit{sid,room,page}` | 广播+存 KV |
| 64 | `GET /api/conversation/:cid?since=` | 书信集（离线补齐） |
| 64b | `POST /api/page/read{sid,pid}` | 已读回执 |
| 65 | `POST /api/redeem{sid,code}` / `POST /api/template/upload`(multipart,管理鉴权) | 兑换彩蛋 / 上传信纸模板 |
| 66 | `GET/PUT /api/admin/config` / `POST /api/admin/reload` / `GET /api/setup` / `GET /api/debug[/kv]` | 管理页 + 诊断（继承 Riddle） |

---

## 九、安全 / 隐私

67. `pl_token`=SID+HMAC(HttpOnly+SameSite=Strict)；Turnstile 服务端校验；昵称长度/字符白名单；邀请码正则；笔迹 pts 上限；WS 单 sid >60 事件/秒节流；邀请码错误 >20/min 触发 Turnstile；`kicked` 多端互斥；数据销毁接口；管理页 SHA-256+HttpOnly Cookie+同 IP 5 次失败锁 5 分钟（Riddle 已有）；密钥仅 CF Secrets。

---

## 十、部署（继承 Riddle CF Pages 流程）

68. 结构：`public/` + `src/`(纯 JS 无需构建)+ `wrangler.jsonc`；`package.json` 加 `"build":"echo 'No build step needed'"`。
69. CF Pages：Framework=None，Build=`npm run build`，Output=`public`。
70. Secrets：`SECRET_TURNSTILE`、`ADMIN_PASSWORD`、`ADMIN_TOKEN`、`PL_JWT_SECRET`（会话签名）。
71. Bindings：`PAPERLINK_KV`(KV，`pl_*` 前缀)+ `ROOM_DO`(Durable Object，`wrangler.jsonc` 配 `durable_objects.bindings`+`migrations`)。
72. Vars(snake_case 预设 8 项)：`default_theme` / `idle_timeout_ms` / `keep_pages`(默认 10) / `dormant_after_hour`(24) / `page_ttl_days`(30) / `archive_after_pages`(50) / `max_pts_per_page`(5000) / `cursor_sync_interval_ms`(200)。

---

## 十一、新建意补充

73. **"喝墨"全过程镜像**（寄信模式）：B 打开信时，笔迹从纸面**由无到有逐笔浮现**，完整复刻 A 书写节奏+速度，比单纯"显示一张图"更具仪式感。
74. **强制信纸同步**：实时/寄信双模式均强制 B 跟随 A 信纸（含未解锁彩蛋纸），保证两人"共写一本"的视觉一致。
75. **对话即书**：每个对话是一本书（卡片封面=当前信纸缩略+对话名），大厅以"书架"呈现，强化日记本隐喻。
76. **用户信息本地化**：昵称/头像/偏好存 `localStorage`，KV 仅存服务端必需，显著降低 KV 容量压力（直接回应"用户过多 KV 不够"）。
77. **可调遗忘(10 页)**：默认保留最近 10 页、超出遗忘旧页（参数可调 5–50），与 Riddle 的 FIFO 同源，自动控 KV 体积。
78. **一键全屏清除(橡皮)**：`btn-clear` 改为"整页清除并镜像到对端"，保留 Riddle 的 dissolve 动画。
79. **信纸模板上传**：管理页支持上传自定义 CSS+背景图生成新信纸（用户可自写样式），拓展彩蛋体系为"用户共创主题"。
80. **Turnstile 注册人机验证**：防止邀请码枚举/批量注册，CF 原生免费，与 Riddle 的安全风格一致。
81. **对话名自动编号**：不填默认"对话1"~"对话5"，降低创建 friction。
82. **寄信模式默认不勾选"带样式"**（§104 修订）：默认仅发笔迹、B 以自己主题渲染；A 可在发送弹层手动勾选"连同信纸样式"。

---

## 十二、分阶段路线图

- **P0(奠基 1–2d)**：Riddle 仓库复制为 `paperlink`；重品牌/图标/部署验证（build+Vars+KV 跑通）。
- **P1(账户+大厅 2–3d)**：`/join`+Turnstile、邀请码(字母+8 数字)、房间 CRUD+对话名、session KV、`/hall` 书架+搜索+5 上限。
- **P2(实时笔迹 3–4d)**：DO WS 广播 stroke/erase/undo/clear_all/theme/cursor；同速重放；浮动栏(下一页/橡皮/撤销/clear/全屏/fade/mode)。
- **P3(寄信+消息 2–3d)**：page_commit+寄信全过程镜像；书页消息+已读/送达；发送选项(默认不带样式)；冲突处理。
- **P4(KV 策略 1–2d)**：笔迹简化+10 页遗忘+归档+TTL+24h 退化删除；用户信息共享本地。
- **P5(彩蛋+模板+管理 2d)**：兑换码+彩蛋；管理页(无 AI)+信纸模板 CSS/图片上传+兑换码 CSV。
- **P6(打磨 1–2d)**：PWA/无障碍/翻页音效/审计日志/全量测试/CF Pages 正式部署。

---

> 本文档可直接作为 `paperlink` 仓库的 `SPEC.md` 落地。所有参数用中文说明，无 AI 项，管理页模板上传为文件上传，注册启用 Cloudflare Turnstile，笔迹同速对端重放，默认保留近 10 页/超出遗忘(可调)，一键清除=全屏橡皮擦(镜像)，用户信息本地化以优化 KV 占用。
