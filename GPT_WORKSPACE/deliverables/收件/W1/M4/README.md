# M4 (文档 API 与并发业务) W1 收件归档

- **模块职责**：文档输入校验、文档 CRUD 业务逻辑、版本乐观锁与并发冲突控制。
- **当前状态**：⚠️ **已收件，审计不达标；代码级问题已由 M1 修正并复验，练习本体仍待 M4 返工**（2026-10-23 微信文件夹直传 `markdown-cloud-editor`；审计报告见 [M4_W1审计报告_20261024.md](M4_W1审计报告_20261024.md)——未做 validation_demo 练习本体、参数擅自改为正式值、缺检查记录/交付说明、夹带 target 312.8 MB 与空 .git、与主仓库 document 层重复实现且 fmt/lint 门禁不过；其 6/6 测试经复跑属实、chars/bytes 校验口径正确）
- **修正版**：`M4_W1修正版/`（2026-10-24 M1 修正 + 五道门禁复验全绿：fmt ✅ / clippy ✅（lint 头内置）/ test 25/25 ✅ / doc ✅ / run 19/19 ✅；含 `检查记录.md` 与 `交付说明.txt`，待 M4 填个人信息并重跑核对）。**注意：修正版只解决代码级问题（413 映射、trim 持久化、错误码、时间戳、命名、lint 合规），不替代任务书要求的 `validation_demo` 练习本体（100/100 000 练习参数 + 9 类用例）——该项仍须 M4 本人返工。**
- **归档位置**：`extracted/markdown-cloud-editor/`（原件，已排除 target/ 与空 .git/，原始微信目录未改动）
- **W1 练习目标**：独立 Rust 小程序 `validation_demo`，校验文档输入：
  - 标题去掉首尾空白，空标题转为“未命名文档”；
  - 标题最多 100 个 Unicode 字符（使用 `chars().count()`）；
  - 正文允许为空，最多 100,000 个 UTF-8 字节（使用 `.len()`）；
  - 规则参数集中为常量，方便主项目对接。
- **原始任务书**：未随本归档镜像；任务要求摘要见审计报告 §2。

---

## 交付前风险预警（来自 M3/M5/M6 豆包经验反思）

组员使用弱 AI（如豆包）生成 Rust 代码时，极易踩入以下陷阱，需特别提醒：
1. **字符数 vs 字节数混淆**：
   - 标题是 **Unicode 字符数**（`chars().count()`），不能用 `.len()`（否则 34 个汉字就会被误判超长）；
   - 正文是 **UTF-8 字节数**（`.len()`），不能用 `chars().count()`（否则十万字符的大文本会极耗内存）。
2. **全角空白处理**：
   - 首尾 trim 建议使用 Rust 标准库 `trim()`，测试需覆盖全角中文空格 `\u3000`。
3. **单体代码与单测缺失**：
   - 不要只在 `main()` 里通过 `println!` 打印肉眼看，必须包含独立的 `#[cfg(test)]` 单元测试。

---

## 针对 M4 的强化版提示词（可直接发给组员使用）

```markdown
你是一位严谨的 Rust 后端开发工程师。请在当前 M4_W1 文件夹内建立名为 validation_demo 的 Cargo 项目，完成文档输入校验练习。

### 硬性技术要求（不可偏离）：
1. 规则参数必须提取为顶层公有常量：
   - `pub const MAX_TITLE_CHARS: usize = 100;`
   - `pub const MAX_BODY_BYTES: usize = 100_000;`
   - `pub const DEFAULT_TITLE: &str = "未命名文档";`
2. 核心校验函数必须设计为纯函数：
   - 签名建议：`pub fn validate_document(title: &str, content: &str) -> Result<ValidatedDocument, ValidationError>`
   - 标题处理：先调用 `.trim()` 去除首尾空白；若修剪后为空，自动回退为 DEFAULT_TITLE；若 Unicode 字符数 `title.chars().count() > MAX_TITLE_CHARS`，返回明确错误。
   - 正文处理：允许空字符串；检查 UTF-8 字节长度 `content.len() > MAX_BODY_BYTES`，若越界返回字节数超长错误。
3. 必须编写真实的 Rust 单元测试（#[cfg(test)]）：
   - 覆盖 7 种测试用例：正常中文标题、全空格标题、恰好 100 字符标题、101 字符标题（超长报错）、空正文、恰好 100,000 字节正文、100,001 字节正文（超长报错）。
4. 在 main.rs 中执行上述用例并打印格式清晰的运行报告。
5. 辅助我实际执行 `cargo run` 和 `cargo test`，把控制台真实的命令和输出写入《检查记录.md》。禁止伪造命令输出，禁止出现“比如 Chrome 130”等模板占位符。
```
