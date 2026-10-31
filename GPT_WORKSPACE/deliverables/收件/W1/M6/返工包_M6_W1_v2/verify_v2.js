/**
 * verify_v2.js —— 返工包 v2 的实测验证脚本
 *
 * 目的：逐条验证 M6_W1_审核记录.md 第四节列出的 F2/F3/F4/F5/F7/F10 是否真的修好了。
 * 手法：真实 headless Chromium（非 mock DOM），异常用 addInitScript 注入原生 DOMException。
 *
 * 运行：node verify_v2.js
 */
const path = require("path");
const { chromium } = require(path.join("[本机路径已脱敏]", "node_modules", "playwright"));

const SUBJECT = path.join(__dirname, "返工包_M6_W1_v2");
const BASE = "http://127.0.0.1:9123";

const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${name}\n      ${detail}`);
}

(async () => {
  const browser = await chromium.launch();

  // ---------- 套件 1：正常路径 + F4/F5/F7 ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/index.html`);

    // F7：ES Module 具名导入
    const importResult = await page.evaluate(async () => {
      try {
        const m = await import("./drafts.js");
        return { ok: true, names: Object.keys(m).sort() };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    });
    check(
      "F7",
      "ES Module 具名导入",
      importResult.ok && importResult.names.includes("saveDraft") && importResult.names.includes("loadDraft"),
      `导入结果=${JSON.stringify(importResult)}`
    );

    // S1 保存
    const s1 = await page.evaluate(() => {
      const ta = document.getElementById("editor");
      ta.value = "111";
      document.getElementById("btnSave").click();
      return {
        msg: document.getElementById("msg").innerText,
        stored: localStorage.getItem("markdown-editor-demo:M6:W1"),
      };
    });
    check(
      "S1",
      "保存后文案区分本地/云端",
      s1.msg.includes("已备份到本机") && s1.msg.includes("非云同步") && !s1.msg.includes("✅保存成功"),
      `msg=${JSON.stringify(s1.msg)}`
    );
    check("S1b", "存储内容含 content 与 savedAt", /"content":"111"/.test(s1.stored) && /"savedAt":\d+/.test(s1.stored), `stored=${s1.stored}`);

    // S2 刷新后读取
    await page.reload();
    const s2 = await page.evaluate(() => {
      const before = document.getElementById("editor").value;
      document.getElementById("btnLoad").click();
      return { before, after: document.getElementById("editor").value, msg: document.getElementById("msg").innerText };
    });
    check("S2", "刷新后读取回填", s2.before === "" && s2.after === "111" && s2.msg.includes("已读取本机草稿"), `before=${JSON.stringify(s2.before)} after=${JSON.stringify(s2.after)} msg=${JSON.stringify(s2.msg)}`);

    // F4：无草稿时不弹 confirm
    const f4 = await page.evaluate(() => {
      let asked = 0;
      const orig = window.confirm;
      window.confirm = (m) => { asked++; return orig(m); };
      localStorage.removeItem("markdown-editor-demo:M6:W1");
      document.getElementById("editor").value = "已有内容";
      document.getElementById("btnLoad").click();
      const noDraftMsg = document.getElementById("msg").innerText;
      const askedNoDraft = asked;
      // 现在放回草稿，再点读取 → 应该弹 confirm
      localStorage.setItem("markdown-editor-demo:M6:W1", JSON.stringify({ content: "草稿内容", savedAt: Date.now() }));
      document.getElementById("btnLoad").click();
      window.confirm = orig;
      return { askedNoDraft, askedWithDraft: asked, noDraftMsg, finalValue: document.getElementById("editor").value };
    });
    check(
      "F4",
      "无草稿时不弹覆盖确认",
      f4.askedNoDraft === 0 && f4.noDraftMsg === "暂无本机草稿" && f4.askedWithDraft === 1,
      `无草稿时弹窗数=${f4.askedNoDraft} msg=${JSON.stringify(f4.noDraftMsg)}；有草稿时弹窗数=${f4.askedWithDraft}`
    );

    // F5：取消读取 → 明确提示 + 内容不变
    const f5 = await page.evaluate(() => {
      let answered = false;
      window.confirm = () => { answered = true; return false; };
      document.getElementById("editor").value = "我的输入";
      document.getElementById("btnLoad").click();
      const r = { msg: document.getElementById("msg").innerText, value: document.getElementById("editor").value };
      window.confirm = () => true;
      return r;
    });
    check(
      "F5",
      "取消读取有明确提示且内容不变",
      f5.msg === "已取消读取，输入框内容未变" && f5.value === "我的输入" && !f5.msg.includes("已读取本机草稿"),
      `msg=${JSON.stringify(f5.msg)} value=${JSON.stringify(f5.value)}`
    );

    // F6：纯空白输入应弹确认（v1 用 trim 导致不弹）
    const f6 = await page.evaluate(() => {
      let asked = 0;
      window.confirm = () => { asked++; return false; };
      document.getElementById("editor").value = "   ";
      document.getElementById("btnLoad").click();
      return asked;
    });
    check("F6", "纯空白输入也触发覆盖确认", f6 === 1, `confirm 弹窗数=${f6}（v1 因 trim 判空为 0）`);

    check("SUITE1", "套件1 无未捕获异常", errors.length === 0, errors.length ? errors.join(" | ") : "无 pageerror");

    await ctx.close();
  }

  // ---------- 套件 2：F3 损坏内容类型校验 ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/index.html`);

    const cases = [
      ["{{{"],
      ["null"],
      ['{"content":123}'],
      ['{"content":null}'],
      ['{"content":{"a":1}}'],
      ['{"content":"abc"}'],
      ['{"content":"abc","savedAt":"not-a-date"}'],
      ['"纯字符串"'],
    ];
    const out = [];
    for (const [raw] of cases) {
      const r = await page.evaluate((v) => {
        localStorage.setItem("markdown-editor-demo:M6:W1", v);
        document.getElementById("editor").value = "";
        document.getElementById("btnLoad").click();
        return { msg: document.getElementById("msg").innerText, value: document.getElementById("editor").value };
      }, raw);
      out.push({ raw, ...r });
    }
    const allRejected = out.every((o) => o.msg.includes("格式损坏") && o.value === "");
    check(
      "F3",
      "所有损坏/异常结构一律走格式损坏分支且不写入输入框",
      allRejected,
      out.map((o) => `${o.raw} → msg=${JSON.stringify(o.msg)} value=${JSON.stringify(o.value)}`).join("\n      ")
    );
    check("SUITE2", "套件2 无未捕获异常", errors.length === 0, errors.length ? errors.join(" | ") : "无 pageerror");
    await ctx.close();
  }

  // ---------- 套件 3：F2 存储异常三路径文案一致 ----------
  {
    // 3a 存储不可用（SecurityError）——三条路径都应走中文文案
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const boom = () => {
        const e = new DOMException("The operation is insecure.", "SecurityError");
        throw e;
      };
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          return { getItem: boom, setItem: boom, removeItem: boom, key: boom, clear: boom, length: 0 };
        },
      });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/index.html`);

    const f2 = await page.evaluate(() => {
      const out = {};
      document.getElementById("btnSave").click();
      out.save = document.getElementById("msg").innerText;
      document.getElementById("btnLoad").click();
      out.load = document.getElementById("msg").innerText;
      document.getElementById("btnClear").click();
      out.clear = document.getElementById("msg").innerText;
      return out;
    });
    const zh = (s) => s.includes("浏览器本地存储不可用") && !s.includes("insecure");
    check(
      "F2a",
      "存储不可用：三条路径均为中文文案且不含浏览器原始英文",
      zh(f2.save) && zh(f2.load) && zh(f2.clear),
      `save=${JSON.stringify(f2.save)}\n      load=${JSON.stringify(f2.load)}\n      clear=${JSON.stringify(f2.clear)}`
    );
    check("SUITE3a", "套件3a 无未捕获异常", errors.length === 0, errors.length ? errors.join(" | ") : "无 pageerror");
    await ctx.close();

    // 3b 配额耗尽
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => {
      const quota = () => {
        const e = new DOMException("Quota exceeded.", "QuotaExceededError");
        throw e;
      };
      const real = window.localStorage;
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          return {
            getItem: (k) => real.getItem(k),
            setItem: quota,
            removeItem: (k) => real.removeItem(k),
            key: (i) => real.key(i),
            clear: () => real.clear(),
            length: real.length,
          };
        },
      });
    });
    const page2 = await ctx2.newPage();
    const errors2 = [];
    page2.on("pageerror", (e) => errors2.push(e.message));
    await page2.goto(`${BASE}/index.html`);
    const q = await page2.evaluate(() => {
      document.getElementById("editor").value = "内容";
      document.getElementById("btnSave").click();
      return document.getElementById("msg").innerText;
    });
    check("F2b", "配额耗尽：显示空间不足且不崩溃", q.includes("空间不足") && errors2.length === 0, `msg=${JSON.stringify(q)}`);
    await ctx2.close();
  }

  // ---------- 套件 4：F10 button type + 中文输入 ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`);
    const f10 = await page.evaluate(() =>
      ["btnSave", "btnLoad", "btnClear"].map((id) => ({ id, type: document.getElementById(id).getAttribute("type") }))
    );
    check("F10", "三个按钮均显式 type=button", f10.every((b) => b.type === "button"), JSON.stringify(f10));

    const zh = await page.evaluate(() => {
      const ta = document.getElementById("editor");
      ta.value = "# 中文标题\n\n这是**加粗**与 emoji 🚀\n- 列表一\n- 列表二";
      document.getElementById("btnSave").click();
      const s = document.getElementById("msg").innerText;
      ta.value = "";
      document.getElementById("btnLoad").click();
      return { saveMsg: s, readBack: ta.value, readMsg: document.getElementById("msg").innerText };
    });
    check(
      "ZH",
      "中文+emoji 往返无损",
      zh.readBack === "# 中文标题\n\n这是**加粗**与 emoji 🚀\n- 列表一\n- 列表二" && zh.readMsg.includes("已读取本机草稿"),
      `saveMsg=${JSON.stringify(zh.saveMsg)} readMsg=${JSON.stringify(zh.readMsg)} readBack=${JSON.stringify(zh.readBack)}`
    );
    await ctx.close();
  }

  await browser.close();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n${"=".repeat(60)}\n总计 ${results.length} 项，通过 ${pass}，失败 ${fail}`);
  console.log(`"=".repeat(60)}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("脚本异常:", e);
  process.exit(2);
});
