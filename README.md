# 📜 PaperLink · 双人手写通讯

> 把"会喝墨的日记"升级为**两人共写一本日记**——A 落笔的每一帧，按选定模式流式到 B 的纸上，像隔着信纸看对方写。
> 完整方案见 [SPEC.md](./SPEC.md)。

技术栈：**Cloudflare Workers + KV + Durable Object**，纯静态前端（无构建步骤）。
手写引擎、溶解动画、毛玻璃 UI 嫁接自 [tom-riddles-diary](https://github.com/zhx-111111/tom-riddles-diary)（Riddle 网页版）。

---

## ✨ 功能一览

| 模块 | 说明 |
| --- | --- |
| 两种通讯模式 | ✉️ **寄信**（默认）：停笔→喝墨→发送，对端打开信页逐笔同速重放，支持**暂停 / 重播**；🌊 **实时镜像**（实验功能）：落笔即见，逐笔/逐点流同步 |
| 强制信纸同步 | 对方切换主题/横竖屏/屏幕比例，本端信纸即时跟随（含未解锁彩蛋纸） |
| 对话大厅 | 书架式卡片（封面=信纸缩略），9 位邀请码创建/加入，每账户最多 5 个对话，重命名/删除 |
| 未读限制 | 对方未查看完前**最多可发 3 页**（可调 `pending_page_limit`），已读回执实时放行 |
| 在线状态 | 绿点"在线" / 红点"离线"，多端互斥（新设备登录踢旧设备） |
| 账户面板 | 昵称/头像（6 选 1）本地化存储，兑换码彩蛋，退出/注销/销毁日记本 |
| 彩蛋体系 | E1 星夜 / E2 樱花 / E3 玫瑰金墨水 / E4 金箔图标 / E5 头像框 / E6 墨迹渐隐 / **RT 实时镜像（兑换码开启）** |
| 信纸模板 | 管理页上传 CSS 片段（+ 背景图）共创信纸，服务端校验作用域与注入 |
| 管理后台 | 实时在线人数、应用参数、兑换码批量生成/CSV、模板管理、房间诊断与休眠清理 |

---

## 🚀 部署（Cloudflare Workers）

部署零预配置：**所有运行变量已在 `wrangler.jsonc` 中预设**，KV 存储库部署后再到控制台手动绑定即可。

### 方式一：CF 控制台关联 GitHub（推荐，推送即部署）

1. Cloudflare Dashboard → **Workers & Pages** → **Create Worker** → **Connect to Git**，选中本仓库；
2. 构建设置：框架 `Workers`，构建命令 `npm install`，部署命令 `npx wrangler deploy`；
3. 首次部署成功后，**绑定 KV 存储库**：
   - 先创建 KV：**Storage & Databases → KV → Create namespace**（建议名 `paperlink-kv`）；
   - 回到 Worker → **Settings → Bindings → Add → KV Namespace**，变量名必须填 **`PAPERLINK_KV`**；
   - 绑定后自动生效，无需重新部署（再次推送也不受影响）。
4. **设置 Secrets**（Settings → Variables and Secrets）：
   - `PL_JWT_SECRET`：会话签名密钥（**强烈建议**，不设则用内置默认值）；
   - `ADMIN_PASSWORD`：管理页密码（默认 `paperlink2026`，**务必修改**）；
   - `SECRET_TURNSTILE`：可选，Cloudflare Turnstile 服务端密钥；不配置则注册免人机验证。
5. （可选）Custom Domains 绑定自己的域名。

> ⚠️ 注意：如果以后改用 **wrangler CLI** 部署（`npx wrangler deploy`），CLI 会按 `wrangler.jsonc` 同步绑定——届时请把控制台里创建的 KV id 填入文件中 `kv_namespaces` 的注释行，否则 CLI 部署会移除控制台绑定。控制台 Git 部署则无此问题。

### 方式二：wrangler CLI

```bash
git clone https://github.com/zhx-111111/paperlink.git
cd paperlink
npm install
npx wrangler login
npx wrangler deploy        # 首次部署（DO migrations 自动执行）
```

之后同样在 CF 控制台绑定 `PAPERLINK_KV`、设置 Secrets；或把 KV id 写入 `wrangler.jsonc` 后由 CLI 管理绑定。

### Vars（已预设，可在控制台修改）

`default_theme` / `idle_timeout_ms` / `keep_pages` / `dormant_after_hour` / `page_ttl_days` / `archive_after_pages` / `max_pts_per_page` / `cursor_sync_interval_ms` / `max_stroke_width` / `turnstile_site_key`（可选，前端 Turnstile widget key）——全部 snake_case，见下表。

---

## 🔧 参数（管理页可调，覆盖 vars）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `allow_register` | 开 | **是否开放注册**（关闭后 /join 拒收新用户） |
| `realtime_allowed` | 开 | 实时镜像总开关（实验功能，用户另需兑换码 RT） |
| `pending_page_limit` | 3 | 对方未读完前最多可发送的页数（1–10） |
| `keep_pages` | 10 | 每对话保留最近 N 页，超出 FIFO 遗忘（5–50） |
| `dormant_after_hour` | 24 | 房间无活跃超时（小时）→ 删信页；双倍超时彻底删房间 |
| `page_ttl_days` | 30 | 信页 KV TTL（天） |
| `max_pts_per_page` | 5000 | 单页笔迹点提示上限 |
| `cursor_sync_interval_ms` | 200 | 光标/逐点流同步节流 |
| `idle_timeout_ms` | 2500 | 新信横幅自动展开的空闲判定 |
| `max_stroke_width` | 5.5 | 压感笔宽上限（1.5–12） |
| `default_theme` | tom | 默认信纸 |

---

## 🗝 管理后台（/admin）

- **实时在线人数**：总在线 + 分房间明细，每 10 秒刷新（3 分钟无心跳的记录自动剔除）；
- **运行诊断**：KV/Secrets 状态、会话/房间/信页/模板/兑换码计数、房间列表、一键清理休眠房间；
- **兑换码**：按彩蛋批量生成（含实验功能 RT），CSV 导出；
- **信纸模板**：上传 `.css`（≤50KB，仅允许作用于 `.page-paper`，拒绝 `@import`/外链 `url()`/脚本注入）+ 可选背景图（≤500KB），启用后所有人主题栏可见。

---

## 💡 生产化设计（方案 → 上线之间解决的问题）

1. **KV 免费额度保护**：
   - 实时笔迹只走 WebSocket 广播，**不落 KV**；实时模式本身设为兑换码解锁的实验功能，控制使用面；
   - 房间活跃时间先写 DO storage，**5 分钟/断线时才回写 KV**（原方案 30s 一写，单房日写近 3000 次）；
   - 在线计数仅在人数变化或 60s 心跳时写入；昵称/头像/主题偏好等用户信息全部本地化（`localStorage`），KV 只存跨设备必需数据。
2. **注册开关**：`allow_register` 管理页参数，配合 Turnstile 双保险。
3. **限流与防刷**：注册（8 次/分/同 IP）、邀请码试错（20 次/分/同 IP）、提交（1.2s 冷却/用户）、WS 事件（60 事件/秒/连接丢弃）、提交载荷 ≤2.5MB。
4. **发送节流阀**：未读 3 页上限防止单方刷屏，同时压缩信页 KV 体积。
5. **休眠清理**：24h 无活跃删信页保元数据，48h 彻底删除，管理页可手动清扫。
6. **已知取舍**：WS token 走 URL query（浏览器 WebSocket 无法设自定义头），请启用 HTTPS；内存限流为单实例尽力而为。

---

## 🏗 结构

```
├── wrangler.jsonc          # Workers + assets + KV + DO(RoomDO) + migrations
├── src/
│   ├── index.js            # 路由：注册登录 / 房间 / 信件 / 兑换码 / 模板 / 管理
│   ├── roomdo.js           # Durable Object：WS 广播、在线计数、实时门槛校验
│   ├── config.js           # 参数、主题、彩蛋目录
│   └── util.js             # token(HMAC)、邀请/兑换码、校验、CSS 安全校验
└── public/
    ├── index.html          # 书写房（工具栏/主题栏/书信集/重放控制/发送栏）
    ├── join.html           # 注册 / 加入（Turnstile）
    ├── hall.html           # 对话大厅（书架）
    ├── me.html             # 账户面板（兑换码/销毁）
    ├── admin.html          # 管理后台
    ├── css/paperlink.css
    ├── js/                 # room / join / hall / me / admin / shared / inkpad
    ├── icons/              # SVG symbol + 180/192/512 PNG
    └── fonts/              # Dancing Script + 马善政楷体（中文手写）
```

---

## 📖 玩法

1. `/join` 注册（昵称 + 头像），创建对话拿到 9 位邀请码，交给 TA；
2. TA 用邀请码加入，两人共写一本日记；
3. **寄信模式**：写满一页点「发送」，墨迹被喝掉，信飞进对方书信集——TA 打开时笔迹由无到有逐笔浮现，可暂停/重播；
4. **实时镜像**（兑换码解锁）：⇄ 切换后落笔即见，横竖屏与信纸样式强制同步；
5. 对方未读完 3 页前不能再寄——等 TA 读；
6. 彩蛋用兑换码在「我的」页解锁。

---

*"I open at the close."* —— 本项目以 MIT 协议发布。
