// repair-dsh-at-file.cjs
//
// 给 dsh-at-file@0.6.3 打两处宿主 API 漂移修复。
//
// 为什么需要：
//   新版 DeepSeek Harness 把两处内部 API 改了，而 dsh-at-file 0.6.3 还是按旧接口写的，
//   于是插件加载直接失败：
//     dsh-at-file (dsh-at-file): failed to import: SyntaxError:
//     The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
//
//   漂移一：`@deepseek-ai/dsh-settings` 不再导出 `settingsNamespace`，`SettingsForms` 也不再提供
//           `register(namespace, schema, opts)`；本脚本把注册调用换成一份内存版 settings 实现
//           （get / update），@ 面板设置项可以读写，但改动不再持久化到 profile 配置文件。
//   漂移二：typert 的 strict codec 现在要求带 `create()` 工厂（宿主在 materialize 时调用
//           `record.value ??= record.create()`），否则抛
//           `typert: dsh-at-file#atFile/search result strict codec has no create() factory`。
//           本脚本给 5 处 codec 补上 `create: () => <同一个 schema>`。
//
// 用法（本机 Node 不在 PATH，用绝对路径）：
//   & "C:\Users\28232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
//     repair-dsh-at-file.cjs
// 可选参数：第一个参数可指定目标文件路径（默认读 desktop profile 下的安装位置）。
//
// 幂等：已经打过补丁的文件再跑一次会打印 "already patched, nothing to do" 并退出 0。
//       插件重装/升级会覆盖 lib/index.js，补丁丢失，重装后重跑本脚本即可。
// 备份：实际写入前会在同目录生成 index.js.bak-<yyyymmddHHMMSS>，回滚就是把它复制回 index.js。
//
// 打完补丁后需要在插件管理器里把 include:dsh-at-file 关掉再打开，才会重新加载。

const fs = require('fs')
const path = require('path')

const file = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(
    process.env.USERPROFILE || 'C:\\Users\\28232',
    '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-at-file', 'lib', 'index.js'
  )

if (!fs.existsSync(file)) {
  console.error('not installed: ' + file)
  process.exit(2)
}

const original = fs.readFileSync(file, 'utf8')
const eol = original.includes('\r\n') ? '\r\n' : '\n'
let s = original

const alreadySettings = s.includes('var AT_FILE_NAMESPACE = "at-file";')
const alreadyCodec = s.includes('create: () => atFileSettingsSchema')

if (alreadySettings && alreadyCodec) {
  console.log('already patched, nothing to do')
  process.exit(0)
}

// --- 1. settings namespace registration -> in-memory settings ---
if (!alreadySettings) {
  const importLine = 'import { settingsNamespace } from "@deepseek-ai/dsh-settings";'
  if (s.includes(importLine)) s = s.replace(importLine + eol, '')

  const nsLine = 'var AT_FILE_NAMESPACE = settingsNamespace("at-file");'
  if (!s.includes(nsLine)) { console.error('STEP settings/namespace not found'); process.exit(3) }
  s = s.replace(nsLine, 'var AT_FILE_NAMESPACE = "at-file";')

  const oldFn = [
    'function registerAtFileSettings(ctx) {',
    '  return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });',
    '}'
  ].join(eol)

  const newFn = [
    'function registerAtFileSettings(ctx) {',
    '  let value = {',
    '    enabled: true,',
    '    ignoreFiles: [...DEFAULT_IGNORE_FILES],',
    '    workspaceIgnoreFiles: [],',
    '    ignorePastedMentions: true',
    '  };',
    '  return {',
    '    get: () => value,',
    '    update: async (patch) => {',
    '      value = { ...value, ...patch };',
    '      return value;',
    '    }',
    '  };',
    '}'
  ].join(eol)

  if (!s.includes(oldFn)) { console.error('STEP settings/register not found'); process.exit(3) }
  s = s.replace(oldFn, newFn)
}

// --- 2. typert strict codecs -> add create() factory ---
if (!alreadyCodec) {
  const rules = [
    [/schema: sessionIdSchema(\s*\})/g, 'schema: sessionIdSchema, create: () => sessionIdSchema$1'],
    [/schema: atFileSettingsUpdateSchema(\s*\})/g, 'schema: atFileSettingsUpdateSchema, create: () => atFileSettingsUpdateSchema$1'],
    [/schema: atFileSettingsSchema(\s*\})/g, 'schema: atFileSettingsSchema, create: () => atFileSettingsSchema$1'],
    [/schema: external_exports\.array\(fileEntrySchema\)(\s*\})/g, 'schema: external_exports.array(fileEntrySchema), create: () => external_exports.array(fileEntrySchema)$1']
  ]
  let hits = 0
  for (const [pattern, replacement] of rules) {
    const n = [...s.matchAll(pattern)].length
    if (n > 0) { s = s.replace(pattern, replacement); hits += n }
  }
  if (hits === 0) { console.error('STEP codec sites not found'); process.exit(3) }
  console.log('codec sites patched: ' + hits)
}

// 写入前备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = file + '.bak-' + stamp
fs.copyFileSync(file, backup)
console.log('backup: ' + backup)

fs.writeFileSync(file, s, 'utf8')
console.log('patched ' + file + ' (' + original.length + ' -> ' + s.length + ' bytes)')
console.log('now disable+enable include:dsh-at-file in the plugin manager to reload it')
