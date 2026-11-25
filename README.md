# dsh-plugin-patches

给两个已发布的 DeepSeek Harness 插件打「兼容性补丁」的小脚本合集。

这两个脚本都是**对已安装插件包内 `lib/index.js` 做精确文本替换**，不是独立插件、不能用插件管理器安装，也不产出 bundle。用之前先备份（脚本会自动备份），出问题用备份回滚即可。

| 脚本 | 目标包 | 目标版本 | 解决什么 |
| --- | --- | --- | --- |
| `patch-minimax-official.cjs` | `@q253595422/dsh-imagegen-video` | `1.35.0` | MiniMax 官方 `/v1/videos` 已下线，插件内置的 minimax 视频协议族失效；补上新的 `minimax-official` 协议族 |
| `repair-dsh-at-file.cjs` | `dsh-at-file` | `0.6.3` | 新宿主移除了 `settingsNamespace`、typert codec 要求 `create()`，导致插件加载报错；补两处兼容 |

---

## 1. patch-minimax-official.cjs

### 问题

`@q253595422/dsh-imagegen-video` 里的 `minimax`（MiniMax-H3）视频协议族走的是：

```
POST /v1/videos
```

但 MiniMax 官方已经下线这条接口，现在调用会返回：

```json
{"base_resp":{"status_code":2013,"status_msg":"invalid params, POST /v1/videos is no longer supported"}}
```

现行接口是三段式：

| 用途 | 请求 |
| --- | --- |
| 提交任务 | `POST /v1/video_generation` → `{ task_id, base_resp }` |
| 轮询任务 | `GET /v1/query/video_generation?task_id=xxx` → `{ status, file_id, base_resp }` |
| 取下载地址 | `GET /v1/files/retrieve?file_id=xxx` → `{ file: { download_url } }` |

还有两个差异：MiniMax 用 `Fail` 表示失败（插件只认 `failed`/`error`），并且轮询结果只给 `file_id` 不给直链，需要再换一次 `download_url`。

### 补丁做了什么

在 `lib/index.js` 里加了协议族 `minimax-official`，共 8 处改动（每处都先精确匹配、要求匹配数恰好为 1，匹配不到会整体中止，不会写出半个补丁）：

1. `ENTRIES["minimax-official"]` —— 新增协议族条目（mode/resolution/aspectRatio/duration 能力表）
2. `describeVideoModel()` —— 把 `Hailuo` / `T2V` / `I2V` / `S2V` 系列归入该族
3. `VIDEO_PATHS["minimax-official"]` —— 提交 `/video_generation`、轮询 `/query/video_generation?task_id={id}`
4. `submitBody()` —— 按模型名归一化参数（Hailuo-2.3/02 不支持 720P、1080P 与 10s 互斥等），并组装 `first_frame_image` / `last_frame_image` / `subject_reference`
5. `readPoll()` —— 失败状态词加 `fail`
6. `readPoll()` —— 提取 `file_id`，产出 `{ kind: "done-file", fileId }`
7. `pollUntilDone()` —— 处理 `done-file`：调 `/files/retrieve` 换 `download_url` 再下载
8. `POLL_POLICY["minimax-official"]` —— 5 秒轮询、30 分钟超时

### 已知能力边界（MiniMax 实测）

| 模型 | 分辨率 | 时长 | 备注 |
| --- | --- | --- | --- |
| `MiniMax-Hailuo-2.3` | 768P / 1080P | 6s / 10s | 1080P 与 10s 互斥；不支持首尾帧 |
| `MiniMax-Hailuo-02` | 512P / 768P / 1080P | 6s / 10s | 1080P 只能 6s；支持首尾帧 |
| `T2V-01` | 720P / 768P / 1080P | 6s / 10s | 纯文生视频 |
| `I2V-01` | 720P / 768P / 1080P | 6s / 10s | 必须提供首帧图 |

`first_frame_image` 接受 data URL base64（`data:image/png;base64,...`），不需要先上传图床。

> 视频模型不会出现在 `GET /v1/models` 里——那里只有聊天模型（MiniMax-M2.7 / M3 等），它们提交视频任务会返回 `2013 incorrect model param input`。

### 用法

```powershell
# 脚本默认改写 desktop profile 下的安装位置，直接跑即可
& "C:\Users\28232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  patch-minimax-official.cjs

# 想指定别的 dist 文件（例如另一份 profile）
& "<node.exe>" patch-minimax-official.cjs "D:\path\to\@q253595422\dsh-imagegen-video\lib\index.js"
```

脚本行为：

- 写入前在**同目录**生成 `index.js.bak-<yyyymmddHHMMSS>` 备份
- 检测到文件里已含 `"minimax-official"` 就判定已打过补丁，直接退出（要强制重跑加 `--force`）
- 任一匹配点找不到即中止，不写文件

打完补丁后在插件管理器里重载插件才生效：

```json
{"action": "set_plugin", "target": "include:imagegen", "enabled": false}
{"action": "set_plugin", "target": "include:imagegen", "enabled": true}
```

---

## 2. repair-dsh-at-file.cjs

### 问题

新版宿主下 `dsh-at-file` 加载失败：

```
dsh-at-file (dsh-at-file): failed to import: SyntaxError:
The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
```

两处 API 漂移：

1. **settings**：`@deepseek-ai/dsh-settings` 不再导出 `settingsNamespace`，`SettingsForms` 也不再提供 `register(namespace, schema, opts)`。
2. **typert**：strict codec 现在要求带 `create()` 工厂（宿主 materialize 时执行 `record.value ??= record.create()`），否则报
   `typert: dsh-at-file#atFile/search result strict codec has no create() factory`。

### 补丁做了什么

1. 删掉 `import { settingsNamespace } from "@deepseek-ai/dsh-settings"`，`AT_FILE_NAMESPACE` 直接等于 `"at-file"`
2. 把 `ctx.settings.register(...)` 换成一份内存版 settings 实现（`get` / `update`）
3. 给 5 处 typert codec 补 `create: () => <同一个 schema>`

### 已知限制

第 2 步是**内存版**实现：`@` 面板里的设置项能读能改，但**改动不会持久化**到 profile 配置文件，重启后回到默认值。

### 用法

```powershell
& "C:\Users\28232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  repair-dsh-at-file.cjs

# 指定目标文件
& "<node.exe>" repair-dsh-at-file.cjs "D:\path\to\dsh-at-file\lib\index.js"
```

脚本行为：

- **幂等**：已打好补丁的文件再跑会打印 `already patched, nothing to do` 并退出 0
- 写入前生成 `index.js.bak-<yyyymmddHHMMSS>` 备份
- 两个补丁点分别独立判断，只补缺失的那一半

打完补丁后在插件管理器里重载：

```json
{"action": "set_plugin", "target": "include:dsh-at-file", "enabled": false}
{"action": "set_plugin", "target": "include:dsh-at-file", "enabled": true}
```

---

## 3. 回滚

两个脚本都在写入前把原文件复制成同目录的 `index.js.bak-<时间戳>`。回滚就是：

```powershell
$dir = "C:\Users\28232\.dsh\profiles\desktop\node_modules\dsh-at-file\lib"
Copy-Item "$dir\index.js.bak-20261125113000" "$dir\index.js" -Force
```

然后在插件管理器里把对应插件关掉再打开。

## 4. 为什么不做成插件

补丁改的是**别人已发布包的内部实现**，没有自己的 `cordis.patch.yml` 和 `client.js`，硬包成一个 bundle 只会得到装不进去或跑不起来的空壳。所以这里保持「脚本 + 文档」的形态。

## 5. 给上游的修复建议

给 `@q253595422/dsh-imagegen-video`：

- 把 `minimax` 协议族的提交/轮询路径换成 `/v1/video_generation` 与 `/v1/query/video_generation?task_id=`
- 轮询结果增加 `file_id` → `/v1/files/retrieve` 的二次解析
- 失败状态词加上 `Fail`
- 按模型区分分辨率/时长约束（Hailuo 系列不支持 720P；1080P 与 10s 互斥）

给 `dsh-at-file`：

- 不再依赖 `settingsNamespace` 与 `ctx.settings.register`，改用新版 settings 服务的配置声明方式
- 所有 strict codec 补上 `create()` 工厂，与当前 typert 契约对齐

## 6. 适用版本与前提

- Node：用本机 Harness 自带的 node（`C:\Users\28232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`），换成你自己机器的路径
- 只验证过 `@q253595422/dsh-imagegen-video@1.35.0` 与 `dsh-at-file@0.6.3`；其它版本上匹配点大概率对不上，脚本会中止而不是改坏文件
- 插件升级或重装会覆盖 `lib/index.js`，补丁随之丢失——**重装后重跑一次脚本**即可

## License

MIT © Benzalkonium chloride
