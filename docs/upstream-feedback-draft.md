# dsh 上游反馈帖草稿 v2（2026-08-24 升级版）

**状态**：内容定稿，待发。上游 deepseek-ai/deepseek-harness 已关闭 Issues，只能发 Discussions（General 分类）。
**阻塞**：本机 gh 的 fine-grained PAT 无 discussions 写权限。
**发法**：网页打开 https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=general 粘贴下文。

---

## 标题

Contract compatibility must be platform-owned: swappable models + persistent sessions + evolving schemas silently strand users

## 正文

### Summary

Two of dsh's headline strengths — **bring-your-own-model** (provider abstraction) and **persistent sessions** (session-persistence-jsonl) — combine into a systemic gap: tool contracts evolve between releases, sessions outlive releases, and models differ widely in how strictly they follow schemas under in-context pressure. When these collide, the current failure mode is a **silent, unrecoverable loop**, and the actual fix ("start a new session") is tribal knowledge rather than product behavior.

The compatibility burden ends up on the user. We believe it belongs to the platform.

### Evidence: one concrete incident (the pattern, not an edge case)

After upgrading to 0.1.1-rc.2, `bash`/`write` began requiring `description`. A long-lived session (300+ turns) had hundreds of successful calls recorded from the laxer era without that field. Those records act as few-shot demonstrations: any model we tested kept omitting the field because *history shows it working*. Result: every subsequent tool call died with:

```
Error: invalid arguments: missing required property "description"
(error.code = INVALID_ARGS, ToolArgsError)
```

Controlled reproduction — same model, same key, same schema, only history differs:

- Clean history → call includes `"description": "Print final-test"` ✅
- History seeded with successful no-description calls → field omitted ❌ every time

Notable operational detail: nothing reached journald/service logs. We only found the cause by decompressing the zstd session log and diffing call shapes across the restart boundary.

### What we'd love dsh to own

Users swap models freely — that is the point of the provider abstraction — and cannot be expected to audit every model against every schema revision. Suggested directions, cheapest first:

1. **Corrective retry on INVALID_ARGS**: the validator already names the exact violation (`missing required property "description"`). Re-dispatching once with that violation injected as feedback would rescue most calls at negligible cost, for every model, past and future.
2. **Lenient completion for annotation-only fields**: fields like `description` exist for UI display. Defaulting them (e.g., to the command text) keeps validation strict for functional constraints while tolerating display-only gaps.
3. **Contract-change guard for persisted sessions**: fingerprint the tool contracts a session was created under; on mismatch at resume, say so in-band ("this session predates an upgrade, consider /new") instead of letting stale history poison turns invisibly.

### Why this matters beyond one field

Downstream channels (IM bridges, IDE integrations) exist to hide exactly this class of complexity — "simple surface, deep underneath". Every time internal contract churn reaches the end user as a mysterious loop, it breaks the promise the whole ecosystem makes. Platform-absorbed compatibility is what lets model choice stay free.

### Environment

- dsh 0.1.1-rc.2, self-hosted CLI profile (Feishu channel via community bridge)
- Model via OpenAI-compatible gateway (openai-completions wire API); reproduced across models
- Session persistence: session-persistence-jsonl

Full session-log analysis available on request.

---

## v1 存档（窄口径版本：仅 description 字段）

v1 把问题框成「description 缺失导致校验拒绝」，2026-08-24 按用户指示升级为平台级契约兼容问题——用户随时换模型，不可能逐个模型对契约；使用面必须从简，深度留给平台。v1 内容已并入上文 Evidence 节。

## 追加发现（2026-08-24 夜）：interrupt 后缓冲流倒灌 → 会话日志损坏

现象：回合以 `turn/end (reason.kind=interrupted)` 收账（seq=20800）后，
writer 仍把中断前缓冲的 `reasoning-chunks` 批次（seq0=20799）追加进日志——
起点回踩已提交区，下次 resume 报
`corrupt session log: seq gap in committed region at line N (expected 20801, got 20799)`。

复现：飞书桥真实会话（PI_AI_ERROR 重试打断场景），全档仅此一处回踩；
摘除该行后加载恢复正常。判据与修复脚本：三省六部/scripts/session_doctor.py。

建议上游：interrupt 收账时丢弃未 flush 的流式批次缓冲（或对 append 前做
start_seq ≤ watermark 断言）。前向跳号无害已验证，仅回踩致命。
