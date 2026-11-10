# dsh-add-selection-to-chat

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的文档预览里选中文字，**右击即可把「文件名 + 行号 + 原文」追加到当前会话的输入框**；在左侧**文件树**里右击文件或文件夹，菜单里多出一项**删除**。

DSH 的右击菜单是 Electron 原生菜单，硬编码在主进程里，文件预览正文又是不可编辑区域，所以只剩一个「复制」。这个插件在渲染进程补齐了那一项：不换窗口、不用复制粘贴，选区带着出处直接进对话框。

文件树用的是 DSH 自己的 `contextMenus` 服务，官方 `file-actions` 只贡献了「另存为…」，没有任何删除入口，而 `workspaceFiles` 是只读的 Remote 命名空间。插件因此自带一个宿主端点（见下文），在菜单里补一项「删除」，文件与文件夹都支持。

在预览里选中文字后右击，菜单多出一项：

```
campus.html · 第 11-17 行      ← 选区信息
＋ 添加到对话框                 ← 本插件提供
```

在文件树里右击 `ssq_model.py` 或某个文件夹，菜单里是：

```
💾 另存为…                     ← DSH 自带
────────────
  删除文件                     ← 本插件提供（红色）
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

第一行是出处（**相对项目根目录的路径 + 1 基起止行**），第二行起是选中原文。根目录取自所插入会话的 `cwd`（渲染会话没有时回退到主视图会话），工作区外的路径保持原样。字段缺失时按表格降级，**从不编造**：

| 情况 | 输出 |
| --- | --- |
| 根目录下的文件 | `campus.html`（根目录下的文件相对后就是文件名本身） |
| 子目录里的文件 | `sub/dir/deep.ts（第 1-2 行）` |
| Markdown 正文（渲染后无逐行标记） | `notes.md` 单独一行，不写行号 |
| 预览头取不到路径 | 只输出 `（第 a-b 行）` |
| 路径与行号都没有 | 不加头，直接原文 |

## 删除文件 / 文件夹

右击文件树里的任意一行（文件或文件夹），选择 **删除文件 / 删除文件夹**，确认后立即删除。

- **先确认再动手**：弹窗写明目标名称；文件夹会注明「以及其中的全部内容」。`Esc` 或「取消」退出，默认焦点在「取消」上。
- **文件夹是递归删除**：`ctx.fs` 没有目录删除，宿主在通过同一套沙箱围栏后递归删除。
- **失败留在弹窗里**：宿主返回的原因（只读、越界、没权限、不存在……）直接显示在弹窗中，条目不会被误删。
- **只删工作区里的东西**：文件树给的是绝对路径，预览给的是相对路径，两种都进菜单；真正的裁决在宿主侧——按会话工作区解析，`../` 越界、工作区根目录本身、工作区外的绝对路径都会被拒，直接 `curl` 端点也绕不过。
- **删除后文件树自动刷新**：文件树监听的就是真实文件系统变化。

### 安全边界

菜单项不是权限。宿主端点在删之前逐条重查：

| 检查 | 被拒时 |
| --- | --- |
| 会话工作区根目录本身 | `workspace-root`，403 |
| 解析后不在工作区内（`danger-full-access` 除外） | `outside-workspace`，403 |
| 文件策略为 `read-only` | `read-only`，403 |
| 目标是符号链接 | `symlink`，400 |
| 目标不存在 / 已删除 | `not-found`，404 |
| 普通文件 | 走 `ctx.fs.deleteFile`（带沙箱围栏与版本簿记） |
| 目录 | `ctx.fs.checkedTarget` 重新规范化并用同一策略围栏后递归删除 |

绝对路径也和工作区一样被围栏住：即便有人直接 `curl` 这个端点，也删不到工作区外的东西。

## 特性

- **追加，不覆盖**：插入点是草稿末尾（不是陈旧光标），一次可撤销的编辑，已有草稿与引用 chip 不受影响。
- **目标以眼睛为准**：会话取自屏幕上真实渲染的输入框（`data-conversation-session`），不是「目录里以为的当前会话」。
- **不可用时说明原因**：没有输入框、输入框被锁定、正在提交时，菜单项置灰并给出提示，绝不写错会话。
- **不打扰原生菜单**：只拦截预览正文内的右击；聊天记录、侧栏、输入框上的右击行为完全不变。
- **删除项走官方菜单服务**：文件树右击菜单由 `ctx.contextMenus` 组合，本插件与「另存为…」并列注册，不劫持 DOM、不覆盖内置菜单。
- **零依赖、零构建**：一个手写的客户端 bundle + 一个只 import `node:fs` 的宿主半侧，不引第三方库，不需要打包步骤。

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

把内容放进对话框：

1. 在右侧栏打开任意文本 / 代码 / Markdown / Office 文件；
2. 选中一段文字；
3. 右击 → **添加到对话框**；
4. 光标自动回到输入框，接一句你的问题即可发送。

删除文件：

1. 在左侧文件树里找到目标；
2. 右击文件或文件夹 → **删除文件 / 删除文件夹**；
3. 确认 → 立即删除，文件树自动刷新。

> 删除只针对左侧文件树里的文件 / 文件夹；右侧预览页和聊天记录里的文件引用不提供删除项。

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

**5. 删除为什么需要一个宿主端点**

浏览器拿不到文件系统，`workspaceFiles` 又只有 `read` / `readBytes` / `stat` / `list` / `changes` 五个只读方法，没有任何删除入口。所以宿主半侧（`index.js`）注册了一条精确路由：

```js
POST /__dsh-add-selection-to-chat/delete
{ "sessionId": "session-…", "path": "sub/dir/ssq_model.py" }
→ { "ok": true, "value": { "path": "…", "absolutePath": "C:\\…", "kind": "file" } }
```

端点只挂在 `webServer` 上，`webServer` 不存在（纯终端组合）时整条路由连同插件一起卸载。路径解析与会话工作区根目录的取法复刻 `workspaceFiles`：live 会话的 `header.cwd` → 持久层 `header.cwd` → 部署兜底。普通文件交给 `ctx.fs.deleteFile`，因此和模型可用的文件工具共用同一套沙箱围栏与版本簿记；目录没有 `ctx.fs` 接口，先用 `ctx.fs.checkedTarget` 把目标重新规范化并按同一策略围栏，再递归删除。

文件系统服务通过守卫式可选查找拿到：`const fs = serviceOf(ctx, 'fs')`，即 `ctx.get('fs')`。壳层给插件的 ctx 是受守卫的 facade——未声明的属性**读取即抛** `cannot get property 'fs' without inject`，而 `ctx.get` 是绕过声明门槛的可选查找（`sessions` / `sandboxPolicy` 走的是同一条路）。裸读 `ctx.fs` 会让每次删除都 500。

**6. 菜单项是注册的，不是画上去的**

文件树用的是 `ctx.contextMenus` 服务，每个 target 类型（`file` / `directory`）由若干 provider 组合，按 `order` 排序：

```js
ctx.contextMenus.register({
  id: 'add-selection-to-chat.delete-file',
  target: 'file',
  order: 400,                    // 官方「另存为…」是 200
  resolve: ({ sessionId, path }) => [/* 删除项 */],
});
```

因此不会出现两个菜单叠在一起，也不会影响 DSH 自带的项；`danger: true` 让菜单把「删除」渲染成红色。

**7. 两个「without inject」陷阱（已踩平）**

壳层给插件的 ctx（client 与 host 两侧都是）是受守卫的 facade：只有插件**声明过注入**的服务才能作为属性读取，否则抛 `cannot get property '<name>' without inject`。本插件踩过两处：

- **client 侧**：`client.js` 的 `exports.inject` 必须包含 `"contextMenus"`（与 `sessions`、`conversation` 并列），`ctx.contextMenus` 才会放行——官方 `file-actions` 注册「另存为…」走的就是 `ctx.inject(["contextMenus", …])` 声明后再用。缺失时属性读取直接 throw，删除项永远注册不上。
- **host 侧**：`index.js` 取文件系统不能裸读 `ctx.fs`，要走守卫式可选查找 `ctx.get('fs')`（即 `serviceOf(ctx, 'fs')`），与 `sessions` / `sandboxPolicy` 的读法一致。

## 已知限制

- **PDF / HTML 预览**里的选区取不到：它们渲染在 iframe 内，父文档的 `getSelection()` 与 `contextmenu` 都无法跨文档。这两类仍走原生菜单。
- **不能插到草稿中间**：右击预览必然让输入框失焦，其光标只是旧址；固定追加到末尾是刻意取舍。
- **删除不进回收站**：直接 `rm`，不可恢复；只有确认弹窗这一道人工闸门。
- **只覆盖左侧文件树**：聊天记录、预览页里的文件引用不提供删除项。
- **符号链接不删**：避免「删链接」意外删到工作区外的目标。
- 选区会做轻度规范化：`CRLF → LF`、去掉结尾空白与空行。
- 未发布到 npm（`package.json` 里 `private: true`）；如需发布请自行移除该字段并补齐 `repository`。

## 排错

| 现象 | 处理 |
| --- | --- |
| 右击没有「添加到对话框」 | 确认 **插件 → 已安装** 里已启用且版本在重启后加载；Web 端刷新页面 |
| 文件树右击没有「删除文件 / 删除文件夹」 | 改完 `client.js` **必须重启 DSH**（宿主路由与客户端 bundle 都是启动时快照）；重启后仍没有，打开 DevTools Console 找 `[add-selection-to-chat]` 开头的日志。正常时会有 `contextMenus acquire: prop:prop=ok`；若属性读取抛 `without inject`，说明 `exports.inject` 缺了 `"contextMenus"`（见「实现要点 7」）。插件还有 `ctx.get` / `ctx.inject` 两条后备路径，每 0.5 s 重试最多 20 s，失败会打一条说明卡在哪一步的 error，把那行发出来即可定位 |
| 删除点了没反应 | 打开 DevTools 看 `POST /__dsh-add-selection-to-chat/delete` 是否 404：404 说明宿主半侧没加载（插件行未启用或未重启），400/403 是守卫在按预期拒绝 |
| 删除提示「cannot get property "fs" without inject」 | 宿主半侧还是旧代码（裸读 `ctx.fs`）：确认重启后宿主行重新加载，或重装插件；新版已改走 `ctx.get('fs')` 可选查找 |
| 删除提示「只能删除工作区内的文件或文件夹」 | 目标不在当前会话工作区内，或该会话文件策略是 `read-only` |
| 菜单项是灰的 | 灰字已说明原因：没有输入框 / 输入框不可编辑 / 正在发送 |
| 点击后提示「草稿刚被改动」 | 编辑器版本在插入瞬间变化，再点一次即可 |
| 插入成功但没看到 | 内容追加在草稿末尾，滚动输入框到底部 |
| 插件列表里看不到它 | 说明只写了 patch、没登记 profile 依赖；改用界面安装或 `install.ps1` |
| 文件名缺失但行号正常 | 预览头没有暴露路径（非本地文件或该渲染器不带 header） |

## 开发

```powershell
node --check client.js
node --check index.js
node test/smoke.mjs   # 选区 → 输入框
node test/delete.mjs  # 文件树删除菜单 + 确认弹窗
node test/host.mjs    # 宿主删除端点与全部守卫
```

`test/smoke.mjs` 用最小 DOM 桩加载**真实** bundle（不 mock 业务逻辑），覆盖：

- bundle 注册、客户端服务声明、dispose 后失效；
- 无选区不拦截原生菜单；预览外的右击完全不介入；
- payload 逐字断言：纯文本 `campus.html（第 12-14 行）`、代码 `app.ts（第 1-2 行）`、无行号渲染器 `notes.md`；
- 目标会话取自渲染中的输入框（Session 目录里故意放另一个「当前会话」）；
- 插入点为草稿末尾（`captureInsertion` 返回的光标故意停在中间）；
- 提交中 / 不可编辑 / 无输入框三种置灰状态，且置灰项不产生插入。

`test/delete.mjs` 驱动同一份真实 bundle 里的菜单 provider 与确认弹窗：两种 target 类型都注册、路径门禁（绝对路径放行——文件树传的就是绝对路径；`.` / 空路径 / 无 Session 不出项）、确认后精确 POST `{sessionId, path}`、被拒时弹窗保留原因、取消与 `Esc` 不发请求。

`test/host.mjs` 在临时目录上跑宿主删除逻辑：文件真被删、文件夹递归删、根目录 / 工作区外绝对路径 / 符号链接 / 不存在四类拒绝、`read-only` 在动手前拒绝。其 ctx 桩用 Proxy 模拟壳层的守卫 facade——未声明属性读取会抛 `without inject`，`fs` 只能经 `ctx.get('fs')` 拿到——保证宿主侧再也不会退化回裸读。

改完 `client.js` 或 `index.js` 后重启 DSH 即可生效（客户端 bundle 与宿主行都在启动时快照）；本地用 `link:` 安装时不必重新安装。

## 目录结构

```
.
├── package.json        # dsh.bundle / dsh.client 声明
├── cordis.patch.yml    # bundle 层：插入插件行
├── index.js            # Host 半侧：删除端点 + 沙箱/工作区守卫
├── client.js           # 浏览器半侧：预览右击菜单 + 文件树删除项 + 确认弹窗
├── locale/{zh,en}.json # 插件管理器的标题与描述
├── icon.svg            # 插件管理器图标
├── install.ps1         # 本地安装（dsh plugin add + 选中 bundle 层）
├── uninstall.ps1       # 卸载
├── diagnose-console.js # 排错用：粘进 DevTools Console 探测模块加载与 contextMenus 状态
└── test/
    ├── dom.mjs         # 两份客户端测试共用的小型 DOM 桩
    ├── smoke.mjs       # 选区 → 输入框
    ├── delete.mjs      # 文件树删除菜单 / 确认弹窗
    └── host.mjs        # 宿主删除端点
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

It also adds **Delete file / Delete folder** to the workspace file tree's right-click menu (DSH's built-in menu there only offers *Save as…*). The client half contributes the item through `ctx.contextMenus` for both the `file` and `directory` targets (the service must be declared in the bundle's `inject` list, or the guarded ctx facade refuses the property read); confirming posts `{ sessionId, path }` — absolute paths from the file tree included — to a small host route, which resolves the path against the Session workspace and re-checks every guard: the workspace root is never deletable, paths must stay inside the workspace, `read-only` refuses, symlinks are refused, regular files go through `ctx.fs.deleteFile` (same sandbox fence as the model-facing file tools) and folders are removed recursively after the same policy fence. The host side reaches the filesystem through the guarded optional lookup (`ctx.get('fs')`), never a bare property read.

Install it from **Plugins → Add plugin** in DSH with the Git URL or a local absolute path, enable the bundle, then restart DSH. No build step, no runtime dependencies.

Limitations: selections inside PDF/HTML previews (rendered in iframes) stay on the native menu, and text is always appended rather than inserted at the caret. Deletes bypass the recycle bin and are only offered from the left file tree. The plugin relies on current DSH DOM markers and the `contextMenus` target kinds; it degrades to "no menu" / "no line numbers" if they are renamed.
