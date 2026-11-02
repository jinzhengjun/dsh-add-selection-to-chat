# dsh-add-selection-to-chat

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的文档预览里选中文字，**右击即可把「文件名 + 行号 + 原文」追加到当前会话的输入框**。

DSH 的右击菜单是 Electron 原生菜单，硬编码在主进程里，文件预览正文又是不可编辑区域，所以只剩一个「复制」。这个插件在渲染进程补齐了那一项：不换窗口、不用复制粘贴，选区带着出处直接进对话框。

在预览里选中文字后右击，菜单多出一项：

```
campus.html · 第 11-17 行      ← 选区信息
＋ 添加到对话框                 ← 本插件提供
```

## 插入的内容

```
campus.html（第 11-17 行）
#info {
    position: absolute; top: 16px; left: 16px;
    color: #fff; font-size: 13px; line-height: 1.7;
    ...
}
```

第一行是出处（**文件名 + 1 基起止行**），第二行起是选中原文。字段缺失时按表格降级，**从不编造**：

| 情况 | 输出 |
| --- | --- |
| Markdown 正文（渲染后无逐行标记） | `notes.md` 单独一行，不写行号 |
| 预览头取不到路径 | 只输出 `（第 a-b 行）` |
| 路径与行号都没有 | 不加头，直接原文 |

## 特性

- **追加，不覆盖**：插入点是草稿末尾（不是陈旧光标），一次可撤销的编辑，已有草稿与引用 chip 不受影响。
- **目标以眼睛为准**：会话取自屏幕上真实渲染的输入框（`data-conversation-session`），不是「目录里以为的当前会话」。
- **不可用时说明原因**：没有输入框、输入框被锁定、正在提交时，菜单项置灰并给出提示，绝不写错会话。
- **不打扰原生菜单**：只拦截预览正文内的右击；聊天记录、侧栏、输入框上的右击行为完全不变。
- **零依赖、零构建**：一个手写的客户端 bundle，不引第三方库，不需要打包步骤。

## 安装

要求：DSH `0.2.1-rc.5`（开发与测试所用版本）。桌面端与 Web 端均可使用。

### 方式一：界面安装（推荐）

侧栏 **插件 → 添加插件**，填入 Git 地址或本地绝对路径，确认后在**已安装**里打开它的开关，重启 DSH。

```
git+https://github.com/<你的用户名>/dsh-add-selection-to-chat.git
```

或本地仓库目录的绝对路径：

```
D:\path\to\dsh-add-selection-to-chat
```

### 方式二：脚本安装（本地目录）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做的是插件管理器同样的两步：`dsh plugin --profile <p> add <目录>` 记下 profile 依赖（`link:`），再把包名追加到 `dsh.profile.bundles` 选中该层。

### 方式三：手动（了解原理时用）

```powershell
# 本地目录：pnpm 会记成 link:，等价于 manager 的「本地绝对路径」安装
dsh plugin --profile desktop add "D:/path/to/dsh-add-selection-to-chat"
```

然后到 **插件 → 已安装** 打开它——命令行只加依赖，**选中这一层**才是让它生效的那一步。

> 装完必须**重启 DSH**：插件行在启动时组合，客户端 bundle 在启动时快照。

## 使用

1. 在右侧栏打开任意文本 / 代码 / Markdown / Office 文件；
2. 选中一段文字；
3. 右击 → **添加到对话框**；
4. 光标自动回到输入框，接一句你的问题即可发送。

## 实现要点

**1. 为什么是自绘菜单而不是加一项到原生菜单**

原生菜单在主进程 `webContents.on("context-menu")` 里逐条构造，渲染进程加不进去。而页面里对 `contextmenu` 调 `preventDefault()` 后，Chromium 不再向主进程发出那次菜单请求——所以自绘菜单可以独占，不会出现两个菜单叠在一起。

**2. 插入走官方输入动作面，不碰 DOM 文本**

```js
const shell = ctx.conversation.input.shell(sessionId); // 屏幕上那块输入框对应的会话
const captured = shell.actions.captureInsertion();     // 只为了拿 draftRev
const end = shell.projection.detectText.length;        // 草稿末尾（detect 坐标）
shell.actions.insertText(payload, { start: end, end, draftRev: captured.draftRev });
```

`insertText` 只在 `draftRev` 未变时落一次可撤销编辑；版本变了返回 `false`，插件提示「草稿刚被改动，请重试」，不会写坏草稿。

**3. 行号来自渲染器自己的坐标系**

- 纯文本：每行是 `[data-textpreview-line="N"]`，N 为 1 基行号（与 DSH 内部 `#L24` 跳转同一空间）；
- 代码：`[data-code-preview]` → `[data-code-block-content]` 内每行一个 `.line`，取序号 + 1；
- 跨行选区取两端的最小/最大行号。

**4. 依赖的 DOM 契约**

`[data-textpreview-body]`（预览正文）、`[data-textpreview-path]`（预览头的路径，是正文的**兄弟节点**）、`[data-conversation-region="chat"]` / `[data-composer-card]` / `[data-composer-input]`（输入框）、`[data-conversation-session]`（会话 id）。

DSH 升级若改了这些标记，插件会退化为「菜单不出现」或「只带文件名不带行号」，不会破坏界面；改常量即可。

## 已知限制

- **PDF / HTML 预览**里的选区取不到：它们渲染在 iframe 内，父文档的 `getSelection()` 与 `contextmenu` 都无法跨文档。这两类仍走原生菜单。
- **不能插到草稿中间**：右击预览必然让输入框失焦，其光标只是旧址；固定追加到末尾是刻意取舍。
- 选区会做轻度规范化：`CRLF → LF`、去掉结尾空白与空行。
- 未发布到 npm（`package.json` 里 `private: true`）；如需发布请自行移除该字段并补齐 `repository`。

## 排错

| 现象 | 处理 |
| --- | --- |
| 右击没有「添加到对话框」 | 确认 **插件 → 已安装** 里已启用且版本在重启后加载；Web 端刷新页面 |
| 菜单项是灰的 | 灰字已说明原因：没有输入框 / 输入框不可编辑 / 正在发送 |
| 点击后提示「草稿刚被改动」 | 编辑器版本在插入瞬间变化，再点一次即可 |
| 插入成功但没看到 | 内容追加在草稿末尾，滚动输入框到底部 |
| 插件列表里看不到它 | 说明只写了 patch、没登记 profile 依赖；改用界面安装或 `install.ps1` |
| 文件名缺失但行号正常 | 预览头没有暴露路径（非本地文件或该渲染器不带 header） |

## 开发

```powershell
node --check client.js
node test/smoke.mjs
```

`test/smoke.mjs` 用最小 DOM 桩加载**真实** bundle（不 mock 业务逻辑），覆盖：

- bundle 注册、客户端服务声明、dispose 后失效；
- 无选区不拦截原生菜单；预览外的右击完全不介入；
- payload 逐字断言：纯文本 `campus.html（第 12-14 行）`、代码 `app.ts（第 1-2 行）`、无行号渲染器 `notes.md`；
- 目标会话取自渲染中的输入框（Session 目录里故意放另一个「当前会话」）；
- 插入点为草稿末尾（`captureInsertion` 返回的光标故意停在中间）；
- 提交中 / 不可编辑 / 无输入框三种置灰状态，且置灰项不产生插入。

改完 `client.js` 后重启 DSH 即可生效（客户端 bundle 在启动时快照）；本地用 `link:` 安装时不必重新安装。

## 目录结构

```
.
├── package.json        # dsh.bundle / dsh.client 声明
├── cordis.patch.yml    # bundle 层：插入插件行
├── index.js            # Host 半侧（空 apply，浏览器半侧承担全部行为）
├── client.js           # 浏览器半侧：右击菜单 + 出处格式化 + 插入
├── locale/{zh,en}.json # 插件管理器的标题与描述
├── icon.svg            # 插件管理器图标
├── install.ps1         # 本地安装（dsh plugin add + 选中 bundle 层）
├── uninstall.ps1       # 卸载
└── test/smoke.mjs      # 离线冒烟测试
```

## License

[MIT](LICENSE)

---

## English

**dsh-add-selection-to-chat** adds an "Add to chat" item to the right-click menu of DSH's document preview. Selecting text and right-clicking appends

```
campus.html（第 11-17 行）
<the selected text>
```

to the composer of the Session that is actually on screen — one undoable edit at the end of the draft, never at a stale caret, and disabled with a reason when that composer is absent, locked or submitting.

Install it from **Plugins → Add plugin** in DSH with the Git URL or a local absolute path, enable the bundle, then restart DSH. No build step, no runtime dependencies.

Limitations: selections inside PDF/HTML previews (rendered in iframes) stay on the native menu, and text is always appended rather than inserted at the caret. The plugin relies on current DSH DOM markers and degrades to "no menu" / "no line numbers" if they are renamed.
