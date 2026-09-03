// 代行舰队测试:模拟「旧机A + 新机B」全场景,真实凭证+真实飞书云盘
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
const LIB = "/mnt/d/PROJECT/dsh-lark-bridge/lib/types/sync"
const { runBotCommand, readCloudArbitration, claimIfActiveStale } = await import(`${LIB}/bot-command.js`)
const { ensureDeviceId } = await import(`${LIB}/migrate.js`)
const { FeishuCloud } = await import(`${LIB}/feishu-cloud.js`)
const { writeSettings, readSettings } = await import(`${LIB}/settings-store.js`)

const env = Object.fromEntries(readFileSync(process.env.FLEET_ENV ?? "", "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/\r$/, "")]))
const creds = { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET }
const cloud = new FeishuCloud(creds)
let pass = 0, fail = 0
const ok = (cond, label) => { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + label) }

function mkMachine(tag) {
  const home = mkdtempSync(path.join(os.tmpdir(), `fleet-${tag}-`))
  const harnessHome = path.join(home, "dsh-home")
  mkdirSync(path.join(harnessHome, "profiles/web"), { recursive: true })
  writeFileSync(path.join(harnessHome, "profiles/web/package.json"), JSON.stringify({
    dependencies: { "@moyu-good/dsh-lark-bridge": "^0.6.0", "@deepseek-ai/cordis": "^4.0.1" },
    dsh: { profile: { bundles: ["@moyu-good/dsh-lark-bridge"] } },
  }))
  const ctx = { home, harnessHome, form: "web", profile: "web", bridgeVersion: "0.6.0-e2e", credentials: creds, runCommand: async () => {} }
  return { home, harnessHome, ctx }
}
const wipe = (m) => rmSync(m.home, { recursive: true, force: true })

await cloud.removeByName("dsh-lark-bridge-arbitration.json")
console.log("── 场景1: 旧机A导出到飞书云盘 ──")
const A = mkMachine("A")
await writeSettings({ appId: "cli_scathach", appSecret: "sk-real-secret-9999", locale: "zh" }, A.home)
const exp = await runBotCommand("/bot export include-secrets --to-feishu", A.ctx)
ok(exp.reply.includes("已上传飞书云空间"), "A 导出并上传云盘")
ok(exp.reply.includes("明文凭证"), "提示含明文凭证警告")
ok((await cloud.getJson("dsh-lark-bridge-migrate.json")) !== null, "云端迁移文件存在")

console.log("── 场景2: 新机B从云盘导入 ──")
const B = mkMachine("B")
const preview = await runBotCommand("/bot import --from-feishu", B.ctx)
ok(preview.reply.includes("导入预览"), "B 拿到预览")
ok(preview.reply.includes("appSecret"), "预览指出需补录凭证")
const applied = await runBotCommand("/bot import --from-feishu apply", B.ctx)
ok(applied.reply.includes("导入执行完毕"), "B 执行导入")
const bSettings = await readSettings(B.home)
ok(bSettings.appId === "cli_scathach" && bSettings.locale === "zh", "B 设置就位 (appId+locale)")
ok(bSettings.appSecret === "sk-real-secret-9999", "include-secrets 明文 secret 随迁移就位")

console.log("── 场景3: B activate 接管,云端仲裁指向B ──")
const act = await runBotCommand("/bot activate", B.ctx)
console.log("ACT.REPLY:", act.reply); ok(act.reply.includes("云端仲裁已更新"), "B activate 写云端仲裁")
const arb1 = await readCloudArbitration(B.ctx)
ok(arb1 !== null && arb1.activeDeviceId === (await ensureDeviceId(B.home)).deviceId, "仲裁活跃端 = B")

console.log("── 场景4: A(未退位)收到消息场景→被仲裁退避,不抢权 ──")
const aIdentity = await ensureDeviceId(A.home)
ok(arb1.activeDeviceId !== aIdentity.deviceId, "仲裁活跃端 ≠ A")
const arbForA = await readCloudArbitration(A.ctx)
ok(await claimIfActiveStale(A.ctx, arbForA) === false, "A 不竞选(B 在线新鲜)")

console.log("── 场景5: B 掉线超时→A 自动竞选接管 ──")
// 把 B 的 presence 线改成 10 分钟前(模拟掉线), A 新鲜
const stale = JSON.parse(await cloud.getJson("dsh-lark-bridge-arbitration.json"))
stale.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString()
stale.devices[arb1.activeDeviceId].lastSeen = Date.now() - 10 * 60_000
await cloud.putJson("dsh-lark-bridge-arbitration.json", JSON.stringify(stale))
const arbStale = await readCloudArbitration(A.ctx)
const claimed = await claimIfActiveStale(A.ctx, arbStale)
ok(claimed === true, "A 竞选接管成功")
const arb2 = await readCloudArbitration(A.ctx)
ok(arb2.activeDeviceId === aIdentity.deviceId, "云端仲裁活跃端已切回 A")

console.log("── 场景6: A retire/activate 生命周期 ──")
const retired = await runBotCommand("/bot retire", A.ctx)
ok(retired.reply.includes("已退位"), "A 退位")
const devices = await runBotCommand("/bot devices", A.ctx)
ok(devices.reply.includes("已退位"), "台账显示退位状态")
ok(devices.reply.includes("LAPTOP") || devices.reply.includes("dev-"), "台账含设备身份")
const reactivated = await runBotCommand("/bot activate", A.ctx)
ok(reactivated.reply.includes("重新激活"), "A 重新激活")

console.log(`═══ 代行舰队测试: ${pass} 过 / ${fail} 败 ═══`)
await cloud.removeByName("dsh-lark-bridge-migrate.json")
await cloud.removeByName("dsh-lark-bridge-arbitration.json")
console.log("云端测试文件已清理")
wipe(A); wipe(B)
process.exit(fail === 0 ? 0 : 1)
