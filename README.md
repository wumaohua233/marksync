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

## 无感原理(简)

- **小红书**:网页是 SSR,收藏数据内嵌在页面 `__INITIAL_STATE__`,后台带 cookie fetch 直取,零窗口
- **抖音 / TikTok**:列表接口带签名,不逆向签名,改用最小化后台窗口(你看不见)+ 页面钩子拦截响应 / 读 DOM
- **YouTube**:喜欢走页面内嵌 `ytInitialData` 后台直取;稍后看因登录态需第一方,用最小化窗口读
- **X**:最小化窗口读书签 / 点赞页 DOM(`data-testid` 稳定)
- **Instagram**:收藏读 Saved 页 DOM;点赞用 `declarativeNetRequest` 改 UA 调 `feed/liked` 接口

## 安装

### 从网站下载（推荐）

打开 **https://wumaohua233.github.io/marksync/** ，点下载按钮，然后：

1. 解压 zip，得到一个 `marksync` 文件夹
2. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选中那个 `marksync` 文件夹
4. 在浏览器登录你要用的平台网页版
5. 点插件图标 →「同步」

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
| Cloudflare Pages | `marksync.pages.dev` | 构建命令**留空**，输出目录填 `docs` |

Cloudflare Pages 会读 `docs/_headers`（缓存与安全头），且把 `docs/` 内容发布在**根路径**——地址里不会多一层 `/marksync/`。

### 发行机制

推一个 `v*` tag 后，`.github/workflows/release.yml` 会：

1. 校验 tag 与 `manifest.json` 的 `version` 一致
2. 跑语言包校验，打包出 `dist/marksync-vX.Y.Z.zip`
3. 建 GitHub Release（归档、留版本历史）
4. **同时把 zip 镜像到 `docs/dl/` 并提交**，并生成 `docs/dl/latest.json`（版本号 + 大小 + sha256）

第 4 步是关键：网站的下载按钮优先读**同源**的 `dl/latest.json`，
读不到才回退到 GitHub API，再回退到 Releases 页面。
两个平台都是推 `main` 就自动重建，所以镜像一提交，站上就是新版本了。

> `docs/dl/` 里只保留最新一个 zip，历史版本在 Release 里。

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
(唯一的例外是版本检查——它会读 `api.github.com` 上本仓库的 Release 信息,只读取公开的版本号,不发送任何本地数据。不需要可以在 `manifest.json` 里去掉这条 host 权限。)

扩展只访问上表所列平台的域名,抓取的是**你自己账号**的收藏 / 点赞。

## 免责声明

个人玩具项目,随平台页面结构变化可能失效。仅供学习交流,请遵守各平台的服务条款。

## 许可证

[GPL-3.0](LICENSE) —— 可自由使用、修改、分发,但衍生作品也必须以 GPL-3.0 开源。
