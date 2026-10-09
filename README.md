# MarkSync

一个 Chrome 扩展,自动同步你在 6 个平台的**收藏与点赞新增**,攒成一个待看清单,专治"刷到就收藏、收藏就吃灰"。

纯本地小工具:数据只存在你自己浏览器,不含 AI、不上传任何服务器、不需要注册账号。

## 支持平台

| 平台 | 抓取内容 |
|---|---|
| 小红书 | 收藏、点赞 |
| 抖音 | 收藏、喜欢 |
| YouTube | 喜欢、稍后观看 |
| X (Twitter) | 书签、点赞 |
| TikTok | 收藏、点赞 |
| Instagram | 收藏、点赞 |

## 功能

- **后台自动同步**(间隔可配),发现新增 → 角标 + 系统通知提醒
- **分体同步按钮**:直接点「同步」全量同步;点下拉箭头可单平台同步,菜单里显示每个平台的上次同步时间
- **平台开关**:设置里勾选要同步的平台/内容,取消勾选的跳过
- **一键导出**全部清单为 CSV(Excel 直接打开,含来源/标题/作者/链接/状态/时间)
- **网络预检**:同步前先探网络,没就绪就每 3 分钟自动重试(治电脑刚唤醒 / 网络刚恢复)
- **未登录提醒**:某平台没登录时,弹窗给出该平台的登录入口
- **中 / 英 / 日 三语**:界面跟随浏览器语言自动切换
- **版本自检**:有新版本时在弹窗顶部提示,点击跳转 Release 页
- **首次同步只建基线**:各平台的历史存量不会被当成「新增」灌进清单

## 首次同步的行为

首次同步做的是**建立基线**，不是把历史存量搬进来。

原因：这个工具的卖点是「从安装那一刻起，不再让新收藏吃灰」。如果把攒了两年的
几百条旧账全当成「新增」倒进清单，结果就是角标显示几千、通知弹「有 3847 条新收藏」、
清单长到没法看——等于没有重点。

具体行为（每个数据源单独算）：

| | 首次同步 | 之后每次 |
|---|---|---|
| 入库条数 | 最多 `FIRST_RUN_KEEP`（默认 30）条 | 只入真正新增的 |
| 状态 | `read`（灰的） | `new`（未读） |
| 角标 | 不增加，从 0 开始 | 累计未读数 |
| 通知 | **不弹** | 弹 |

采集到的**全部** id 都会记入 `seen`（包括没入库的那部分），所以这批旧条目
之后不会再冒出来当「新增」。

想改这个阈值：`background.js` 顶部的 `FIRST_RUN_KEEP`。
想把历史全部导进来：删掉扩展重装，或点设置里的「清空清单并重新全量导入」。

## 无感原理(简)

- **小红书**:网页是 SSR,收藏数据内嵌在页面 `__INITIAL_STATE__`,后台带 cookie fetch 直取,零窗口
- **抖音 / TikTok**:列表接口带签名,不逆向签名,改用最小化后台窗口(你看不见)+ 页面钩子拦截响应 / 读 DOM
- **YouTube**:喜欢走页面内嵌 `ytInitialData` 后台直取;稍后看因登录态需第一方,用最小化窗口读
- **X**:最小化窗口读书签 / 点赞页 DOM(`data-testid` 稳定)
- **Instagram**:收藏读 Saved 页 DOM;点赞用 `declarativeNetRequest` 改 UA 调 `feed/liked` 接口

## 安装

### 从网站下载（推荐）

打开 **https://getmarksync.pages.dev/** （或 [GitHub Pages 备用站](https://wumaohua233.github.io/marksync/)），点下载按钮，然后：

1. **解压 zip**，得到一个 `marksync` 文件夹
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选中那个 `marksync` 文件夹
4. 在浏览器登录你要用的平台网页版
5. 点插件图标 →「同步」

> ⚠️ **不要把 zip 直接拖进 `chrome://extensions`。**
> Chrome 确实支持拖 zip，但它会到**解压根目录**找 `manifest.json`
> （`extensions/browser/zipfile_installer.cc`），而我们的 zip 顶层是 `marksync/` 文件夹，
> 所以只会报「无法加载扩展程序…Could not unzip extension for install」。
>
> 这一层同名文件夹是故意的：不加它，用户手动解压时会把一堆文件撒在下载目录里。
> 代价就是拖拽安装用不了——只能走「加载已解压」那条路。

> 下载按钮指向的是**同源**的 `dl/marksync-v*.zip`，不经过 GitHub。
> 直连 GitHub 不稳的网络下，这是能不能装上的关键。

### 或者 git clone（以后更新更方便）

```bash
git clone https://github.com/wumaohua233/marksync.git ~/marksync
```

然后按上面的第 2、3 步加载 `~/marksync` 文件夹。

## 更新

Chrome 不允许非商店扩展自更新(Windows/macOS 从 Chrome 33/44 起封掉了 `crx` 外部安装),所以更新需要你手动做一次。但**扩展会自己检查新版本**,有新版会在弹窗顶部提示。

**方式 A — 命令行**(clone 安装的用这个):

```bash
cd ~/marksync && git pull
```

Chrome 会监视已解压目录的文件变化并**自动重新加载**,不用回扩展页点刷新。

**方式 B — 手动覆盖**:

下载新 zip,解压后**覆盖到同一个文件夹**。同样会自动重载。

> 更新不会动你的数据——清单和已读记录存在浏览器里,和扩展文件夹无关。

## 扩展 ID 与签名密钥

扩展的 unpacked ID 默认是**从文件夹绝对路径**哈希出来的。那意味着用户把 `marksync`
文件夹换个位置、改个名，或更新时解压到了 `marksync (1)`，**ID 就变了，`chrome.storage`
里的清单读不到 → 用户会以为数据丢了**，而且是静默的，不报错。

所以 `manifest.json` 里加了一个固定的 `key`，ID 锁死为：

```
jdnlmjjgbfhphdnkecajlfjgeepelicb
```

这个 ID 已经用 Chrome 自己打包出的 CRX 反算验证过（从 CRX3 头部挖出公钥 →
SHA256 → 前 16 字节按 0-15 映射成 a-p）。

| | 位置 | 能不能公开 |
|---|---|---|
| **公钥** | `manifest.json` 的 `key` 字段 | ✅ 本来就要随扩展分发 |
| **私钥** | `~/.marksync/extension-key.pem`（600） | ❌ 绝对不要进仓库 |
| 私钥备份 | GitHub Secret `EXTENSION_PRIVATE_KEY` | 用于以后签名 CRX |

私钥丢了**不会导致扩展挂掉**（ID 只靠 `key` 字段推导），但以后就没法签出同 ID 的 CRX 了。
建议再加一份离线备份。

> 用 Chrome 打包同 ID 的 CRX：
> `chrome --pack-extension=<dir> --pack-extension-key=~/.marksync/extension-key.pem`

## 开发

```bash
# 校验三种语言包的一致性、占位符合法性（CI 也会跑）
python3 scripts/check_i18n.py

# 打一个干净的发布包到 dist/
bash scripts/pack.sh
```

### 部署

站点是 `docs/` 目录下的纯静态文件，**没有构建步骤**。两个都免费，同时可以开着：

| 平台 | 地址 | 配置 |
|---|---|---|
| GitHub Pages | `wumaohua233.github.io/marksync/` | 仓库 Settings → Pages → 分支 `main` / 目录 `/docs` |
| Cloudflare Pages | `getmarksync.pages.dev` | 构建命令**留空**，输出目录填 `docs` |

> 子域名为什么不是 `marksync.pages.dev`：那个已经被占用了，Cloudflare 会退而给 `marksync-468.pages.dev`。
> 选 `getmarksync` 是为了拿到一个干净好记的地址。以后上自定义域名的话这个就不重要了。

Cloudflare Pages 会读 `docs/_headers`（缓存与安全头），且把 `docs/` 内容发布在**根路径**——地址里不会多一层 `/marksync/`。

`docs/404.html` 两个平台都会用到：Cloudflare Pages 靠它才能对未知路径返回 **404 而不是兕底成首页**（否则 `/dl/已删除的版本.zip` 会下载到一个 HTML 文件），GitHub Pages 则把它当自定义 404 页。

### 发行机制

推一个 `v*` tag 后，`.github/workflows/release.yml` 会：

1. 校验 tag 与 `manifest.json` 的 `version` 一致
2. 跑语言包校验，打包出 `dist/marksync-vX.Y.Z.zip`
3. 建 GitHub Release（归档、留版本历史）
4. **把 zip 镜像到 `docs/dl/`，并写 `docs/version.json`（版本号 + 大小 + sha256）**，然后提交

第 4 步是关键：网站的下载按钮和**扩展的更新检查**都优先读同源文件，
读不到才回退到 GitHub。两个平台都是推 `main` 就自动重建，所以镜像一提交，站上就是新版本了。

> `docs/dl/` 里只保留最新一个 zip，历史版本在 Release 里。
>
> `version.json` 刻意放在根目录而不是 `docs/dl/`：Cloudflare Pages 的 `_headers` 对
> 重叠规则是**拼接**而非覆盖，`/dl/*` 的 long-cache 会把清单一起带上，
> 导致扩展永远读到旧版本。详见 `docs/_headers` 里的注释。

### 文字工作流

所有界面文案都在 `_locales/<lang>/messages.json`,代码里通过 `t("key")` 取用。
目前支持 `zh_CN` / `en` / `ja`,默认语言 `zh_CN`。

- **加文案**:三个语言文件都要加,`$1` `$2` 占位符必须一一对应,否则 `check_i18n.py` 会报错
- **HTML 里的静态文案**用 `data-i18n="key"` 标记,`applyI18n()` 会自动替换;
  需要保留标签的用 `data-i18n-html`
- 改动后跑一遍 `scripts/check_i18n.py`,它会揪出漏翻、多余、占位符错位的 key

### 发版

1. 改 `manifest.json` 里的 `version`
2. 提交并打 tag:`git tag v0.2.0 && git push --tags`
3. GitHub Actions 自动校验语言包、打包、建 Release、镜像到 `docs/dl/`

> tag 和 `manifest.json` 的版本号必须一致，不一致 CI 会直接失败——否则扩展内的更新检查会永远认为「有新版本」。

## 隐私

所有数据(收藏列表、已读状态、设置)只保存在本地 `chrome.storage`,**不上传、不共享**。

不放心可以自己核验:全仓库搜索 `fetch(`,除了 6 个平台和一处用于探测网络连通性的百度 favicon,没有任何指向第三方的请求。
(唯一的例外是版本检查——它读 `getmarksync.pages.dev/version.json`，只拿一个公开的版本号，
不发送任何本地数据。全部外部请求就是这 7 个域名，`manifest.json` 里一目了然。)

扩展只访问上表所列平台的域名,抓取的是**你自己账号**的收藏 / 点赞。

## 免责声明

个人玩具项目,随平台页面结构变化可能失效。仅供学习交流,请遵守各平台的服务条款。

## 许可证

[GPL-3.0](LICENSE) —— 可自由使用、修改、分发,但衍生作品也必须以 GPL-3.0 开源。
