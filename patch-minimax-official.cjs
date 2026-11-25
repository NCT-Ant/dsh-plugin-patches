// patch-minimax-official.cjs
//
// 给 @q253595422/dsh-imagegen-video@1.35.0 增加 MiniMax 官方视频协议族（family: minimax-official）。
//
// 为什么需要：
//   MiniMax 官方已下线旧接口 POST /v1/videos（现在返回
//   {"base_resp":{"status_code":2013,"status_msg":"invalid params, POST /v1/videos is no longer supported"}}），
//   插件内置的 minimax（MiniMax-H3）族走的就是这条已作废的路径，视频生成必然失败。
//   MiniMax 现行接口是三步：
//     POST /v1/video_generation                       提交，返回 { task_id, base_resp }
//     GET  /v1/query/video_generation?task_id=xxx     轮询，返回 { status, file_id, base_resp }
//     GET  /v1/files/retrieve?file_id=xxx             取 { file: { download_url } }
//   另外 MiniMax 用 "Fail" 表示失败、只给 file_id 不给直链，都需要额外适配。
//
// 本脚本改动的 8 个位置（全部是先精确匹配、匹配数必须为 1 才替换，匹配不到就整体中止）：
//   1. ENTRIES["minimax-official"]        新增协议族条目（modes/resolutions/aspectRatios/durations）
//   2. describeVideoModel()               把 Hailuo / T2V / I2V / S2V 归入 minimax-official
//   3. VIDEO_PATHS["minimax-official"]    提交 /video_generation、轮询 /query/video_generation?task_id={id}
//   4. submitBody()                       按模型名归一化参数（Hailuo 不支持 720P、1080P 与 10s 互斥等），
//                                         并组装 first_frame_image / last_frame_image / subject_reference
//   5. readPoll() 失败状态词              加 "fail"
//   6. readPoll() 提取 file_id            新增 { kind: "done-file", fileId }
//   7. pollUntilDone() 处理 done-file     用 /files/retrieve 换 download_url 后再下载
//   8. POLL_POLICY["minimax-official"]    5 秒轮询、30 分钟超时
//
// 用法（本机 Node 不在 PATH，用绝对路径）：
//   & "C:\Users\28232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
//     patch-minimax-official.cjs
// 可选参数：第一个参数可指定目标 dist 文件路径（默认读 desktop profile 下的安装位置）。
//   node patch-minimax-official.cjs "D:\somewhere\@q253595422\dsh-imagegen-video\lib\index.js"
//
// 备份：写入前自动在同目录生成 index.js.bak-<yyyymmddHHMMSS>，回滚就是把它复制回 index.js。
// 幂等：检测到文件里已有 "minimax-official" 即视为已打过，直接退出；要重新应用加 --force。
//
// 打完补丁后需要重载插件才能生效：
//   plugin_manager set_plugin  target: "include:imagegen"  enabled: false → 再 true
//
// 注意：插件升级/重装会覆盖 lib/index.js，补丁随之丢失，重装后重跑本脚本即可。

const fs = require("fs");
const path = require("path");

const DEFAULT_TARGET = path.join(
  process.env.USERPROFILE || "C:\\Users\\28232",
  ".dsh", "profiles", "desktop", "node_modules",
  "@q253595422", "dsh-imagegen-video", "lib", "index.js"
);

const p = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : DEFAULT_TARGET;
const force = process.argv.includes("--force");

if (!fs.existsSync(p)) {
  console.error("目标文件不存在：" + p);
  console.error("请确认已安装 @q253595422/dsh-imagegen-video@1.35.0，或把 dist 文件路径作为第一个参数传入。");
  process.exit(2);
}

let s = fs.readFileSync(p, "utf8");

if (!force && s.includes('"minimax-official"')) {
  console.log("已检测到 minimax-official，补丁似乎已应用，跳过。需要强制重跑请加 --force");
  process.exit(0);
}

const L = (...lines) => lines.join("\n");

function rep(old, neo, label) {
  const n = s.split(old).length - 1;
  if (n !== 1) throw new Error(label + ": expected 1 occurrence, got " + n);
  s = s.replace(old, neo);
  console.log("patched: " + label);
}

// 1. ENTRIES: new minimax-official entry before qihang
const entriesOld = L(
  "\tqihang: {",
  "\t\tlabel: \"qihang\","
);
const entriesNew = L(
  "\t\"minimax-official\": {",
  "\t\tlabel: \"minimax-official\",",
  "\t\tlabelZh: \"MiniMax 官方\",",
  "\t\tknown: true,",
  "\t\tmodes: [",
  "\t\t\t\"text\",",
  "\t\t\t\"image\",",
  "\t\t\t\"keyframe\",",
  "\t\t\t\"reference\"",
  "\t\t],",
  "\t\tresolutions: [",
  "\t\t\t\"720P\",",
  "\t\t\t\"768P\",",
  "\t\t\t\"1080P\"",
  "\t\t],",
  "\t\taspectRatios: [",
  "\t\t\t\"16:9\",",
  "\t\t\t\"9:16\",",
  "\t\t\t\"1:1\",",
  "\t\t\t\"4:3\",",
  "\t\t\t\"3:4\",",
  "\t\t\t\"21:9\"",
  "\t\t],",
  "\t\tdurations: [",
  "\t\t\t6,",
  "\t\t\t10",
  "\t\t],",
  "\t\tsupportsSeed: false,",
  "\t\trequiresReference: false",
  "\t},",
  entriesOld
);
rep(entriesOld, entriesNew, "ENTRIES.minimax-official");

// 2. describeVideoModel: classify Hailuo / T2V / I2V / S2V as minimax-official
const descOld = "\tif (/^minimax[-_.]?h3(?:$|[-_.])/i.test(id)) return {";
const descNew = L(
  "\tif (/^(?:minimax[-_.]?)?(?:hailuo|t2v|i2v|s2v)(?:$|[-_.])/i.test(id)) return {",
  "\t\tfamily: \"minimax-official\",",
  "\t\t...ENTRIES[\"minimax-official\"]",
  "\t};",
  descOld
);
rep(descOld, descNew, "describeVideoModel.minimax-official");

// 3. VIDEO_PATHS
const pathsOld = L(
  "\tqihang: {",
  "\t\tsubmit: \"/videos/generations\",",
  "\t\tstatus: \"/tasks/{id}\"",
  "\t}",
  "};"
);
const pathsNew = L(
  "\t\"minimax-official\": {",
  "\t\tsubmit: \"/video_generation\",",
  "\t\tstatus: \"/query/video_generation?task_id={id}\"",
  "\t},",
  pathsOld
);
rep(pathsOld, pathsNew, "VIDEO_PATHS.minimax-official");

// 4. submitBody branch
const bodyOld = "\tif (familyName === \"comemoe\") {";
const bodyNew = L(
  "\tif (familyName === \"minimax-official\") {",
  "\t\tconst wireModel = (request.upstream ?? request.model).trim();",
  "\t\tconst isHailuo23 = /hailuo[-_.]?2[-_.]?3/i.test(wireModel);",
  "\t\tconst isHailuo02 = !isHailuo23 && /hailuo[-_.]?0?2/i.test(wireModel);",
  "\t\tconst normalized = normalizeVideoResolution(wireModel, request.resolution);",
  "\t\tlet shotSeconds = seconds;",
  "\t\tif (shotSeconds !== 6 && shotSeconds !== 10) shotSeconds = shotSeconds >= 8 ? 10 : 6;",
  "\t\tlet shotRes = normalized === \"1080P\" || normalized === \"768P\" ? normalized : \"720P\";",
  "\t\tif ((isHailuo23 || isHailuo02) && shotRes === \"720P\") shotRes = \"768P\";",
  "\t\tif (shotRes === \"1080P\" && shotSeconds === 10) shotRes = \"768P\";",
  "\t\tif (shotRes === \"1080P\") shotSeconds = 6;",
  "\t\tconst body = {",
  "\t\t\tmodel: request.upstream ?? request.model,",
  "\t\t\tprompt: request.prompt,",
  "\t\t\tprompt_optimizer: false,",
  "\t\t\taigc_watermark: false,",
  "\t\t\tduration: shotSeconds,",
  "\t\t\tresolution: shotRes",
  "\t\t};",
  "\t\tif (request.mode === \"reference\") {",
  "\t\t\tif (references.primary !== void 0) body.subject_reference = [{",
  "\t\t\t\ttype: \"character\",",
  "\t\t\t\timage: [dataUrlOf(references.primary)]",
  "\t\t\t}];",
  "\t\t} else if (request.mode === \"keyframe\") {",
  "\t\t\tif (references.all[0] !== void 0) body.first_frame_image = dataUrlOf(references.all[0]);",
  "\t\t\tif (references.all[1] !== void 0 && isHailuo02) body.last_frame_image = dataUrlOf(references.all[1]);",
  "\t\t} else if (references.primary !== void 0) body.first_frame_image = dataUrlOf(references.primary);",
  "\t\treturn body;",
  "\t}",
  bodyOld
);
rep(bodyOld, bodyNew, "submitBody.minimax-official");

// 5. readPoll: MiniMax reports failures as "Fail"
const failOld = L("\t\t\"failed\",", "\t\t\"error\",");
const failNew = L("\t\t\"failed\",", "\t\t\"fail\",", "\t\t\"error\",");
rep(failOld, failNew, "readPoll.fail-status");

// 6. readPoll: expose file_id
const urlOld = L("\tconst url = [", "\t\tpayload.output_url,");
const urlNew = L(
  "\tconst fileId = typeof payload.file_id === \"string\" ? payload.file_id.trim() : \"\";",
  urlOld
);
rep(urlOld, urlNew, "readPoll.fileId");

const doneOld = L(
  "\t\tif (typeof url !== \"string\") return {",
  "\t\t\tkind: \"done-content\","
);
const doneNew = L(
  "\t\tif (typeof url !== \"string\" && fileId !== \"\") return {",
  "\t\t\tkind: \"done-file\",",
  "\t\t\tfileId",
  "\t\t};",
  doneOld
);
rep(doneOld, doneNew, "readPoll.done-file");

// 7. pollUntilDone: resolve file_id -> download_url
const pollOld = "\t\t\tif (outcome.kind === \"done-content\") return {";
const pollNew = L(
  "\t\t\tif (outcome.kind === \"done-file\") {",
  "\t\t\t\tconst retrieveUrl = baseUrl + \"/files/retrieve?file_id=\" + encodeURIComponent(outcome.fileId);",
  "\t\t\t\tconst fileBudget = requestSignal(signal, SUBMIT_TIMEOUT_MS);",
  "\t\t\t\ttry {",
  "\t\t\t\t\tconst filePayload = await getJson({",
  "\t\t\t\t\t\t...statusAttempt,",
  "\t\t\t\t\t\tphase: \"video-file\",",
  "\t\t\t\t\t\turl: displayUrl(retrieveUrl)",
  "\t\t\t\t\t}, retrieveUrl, upstream.apiKey, fileBudget.signal);",
  "\t\t\t\t\tconst download = typeof filePayload?.file?.download_url === \"string\" ? filePayload.file.download_url.trim() : \"\";",
  "\t\t\t\t\tif (download !== \"\") return {",
  "\t\t\t\t\t\tsource: {",
  "\t\t\t\t\t\t\tkind: \"url\",",
  "\t\t\t\t\t\t\turl: download",
  "\t\t\t\t\t\t},",
  "\t\t\t\t\t\t...outcome.duration === void 0 ? {} : { duration: outcome.duration },",
  "\t\t\t\t\t\t...outcome.poster === void 0 ? {} : { poster: outcome.poster }",
  "\t\t\t\t\t};",
  "\t\t\t\t\tconst failure = new VideoGenError(errorTextOf(filePayload, \"视频已完成但取不到下载地址\"), \"video-download-failed\");",
  "\t\t\t\t\trecordVideoFailure(statusAttempt, failure, { requestExcerpt: excerptOf({",
  "\t\t\t\t\t\ttaskId,",
  "\t\t\t\t\t\tfileId: outcome.fileId",
  "\t\t\t\t\t}) });",
  "\t\t\t\t\tthrow failure;",
  "\t\t\t\t} finally {",
  "\t\t\t\t\tfileBudget.dispose();",
  "\t\t\t\t}",
  "\t\t\t}",
  pollOld
);
rep(pollOld, pollNew, "pollUntilDone.done-file");

// 8. POLL_POLICY
const policyOld = L(
  "\tminimax: {",
  "\t\tintervalMs: 5e3,",
  "\t\tdeadlineMs: 18e5",
  "\t},"
);
const policyNew = L(
  "\tminimax: {",
  "\t\tintervalMs: 5e3,",
  "\t\tdeadlineMs: 18e5",
  "\t},",
  "\t\"minimax-official\": {",
  "\t\tintervalMs: 5e3,",
  "\t\tdeadlineMs: 18e5",
  "\t},"
);
rep(policyOld, policyNew, "POLL_POLICY.minimax-official");

// 写入前备份
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backup = p + ".bak-" + stamp;
fs.copyFileSync(p, backup);
console.log("backup: " + backup);

fs.writeFileSync(p, s, "utf8");
console.log("written " + p + " (" + fs.statSync(p).size + " bytes)");
console.log("接下来在插件管理器里对 include:imagegen 做一次 false → true 重载。");
