/**
 * drafts.js —— M6 W1 返工版（v2）
 *
 * 修复依据：GPT_WORKSPACE/deliverables/收件/W1/M6/M6_W1_审核记录.md 第四节
 * 本文件是对M6 组员 W1 交件 drafts.js 的修复版本，仅改 F2/F3/F4/F5/F7/F10 六处，
 * 不改变本周练习范围（仍是 localStorage 演示，不是云同步）。
 *
 * 已修：
 *   F7  补 export，可被 <script type="module"> 具名导入
 *   F2  统一错误分类函数，SecurityError 一律映射中文文案（三条路径一致）
 *   F3  加类型校验：content 非字符串或 savedAt 非法一律走"格式损坏"分支
 *   F4  confirm 移到草稿存在性判断之后，无草稿不再弹窗
 *   F5  confirm 取消时明确提示"已取消读取"，不残留旧的"✅读取成功"
 *   F10 三个按钮在 index.html 中显式加 type="button"
 *
 * 仍未做（属正式项目范畴，不在 W1 范围）：
 *   - 草稿键不含 user_id / doc_id / edit_session_id（正式项目须重写，见规范 §08:374）
 *   - 草稿记录缺 base_version / title / local_revision（规范 §08:376）
 *   - 仍直接操作 DOM（正式项目 drafts.js 应为零 DOM 纯逻辑层，规范 §05:217）
 *
 * 文案约定：本地草稿一律称"本机草稿"或"本地备份"，
 * 不得出现"已保存"/"已同步"等暗示云端落库的措辞（规范 §08:349）。
 */

const STORAGE_KEY = "markdown-editor-demo:M6:W1";

const editorEl = document.getElementById("editor");
const msgEl = document.getElementById("msg");

/** 显示提示 */
function showMsg(text) {
  msgEl.innerText = text;
}

/**
 * F2 修复：统一存储错误分类。
 * 之前 saveDraft/clearDraft 对 SecurityError 走 else 分支直接透出 e.message
 * （浏览器原始英文 "The operation is insecure."），与 loadDraft 的中文文案不一致。
 * 现在三条路径共用本函数。
 *
 * @param {unknown} error 捕获到的异常
 * @returns {string} 面向用户的中文提示
 */
function describeStorageError(error) {
  const name = error && error.name;

  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return "❌本地备份失败：浏览器本地空间不足，请清理后重试";
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return "❌本地备份失败：浏览器本地存储不可用（可能处于隐私模式或以 file 协议打开）";
  }
  return "❌本地备份失败：本地存储访问出错";
}

/**
 * F3 修复：校验草稿记录结构。
 * 之前只 catch JSON.parse 的语法错误，导致 content 非字符串时被静默接受
 * （123 → "123"、null → ""、对象 → "[object Object]"），
 * savedAt 缺失时仍显示"✅读取成功，上次保存：Invalid Date"。
 *
 * @param {unknown} raw localStorage 中的原始字符串
 * @returns {{ok: true, draft: {content: string, savedAt: number}} | {ok: false}}
 */
function parseDraft(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "json" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "shape" };
  }
  if (typeof parsed.content !== "string") {
    return { ok: false, reason: "content" };
  }
  if (!Number.isFinite(parsed.savedAt)) {
    return { ok: false, reason: "savedAt" };
  }
  return { ok: true, draft: { content: parsed.content, savedAt: parsed.savedAt } };
}

/**
 * 保存草稿到本机：正文 + 保存时间。
 * 仅本地备份，不代表云端已保存。
 */
function saveDraft() {
  const content = editorEl.value;
  const draft = {
    content: content,
    savedAt: Date.now(),
  };

  let raw;
  try {
    raw = JSON.stringify(draft);
  } catch (error) {
    showMsg("❌本地备份失败：草稿内容无法序列化");
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch (error) {
    showMsg(describeStorageError(error));
    return;
  }
  showMsg(`✅已备份到本机（仅本机，非云同步），保存时间：${new Date(draft.savedAt).toLocaleString()}`);
}

/**
 * 读取本机草稿。
 * F4：先判断草稿是否存在，再决定是否需要覆盖确认。
 * F5：用户取消时明确提示，不残留上一条"✅读取成功"。
 */
function loadDraft() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    showMsg(describeStorageError(error));
    return;
  }

  if (!raw) {
    showMsg("暂无本机草稿");
    return;
  }

  // F4：草稿确认存在后，才对已有输入发起覆盖确认。
  if (editorEl.value !== "") {
    const confirmed = confirm("当前输入框有内容，读取草稿会覆盖，确定继续吗？");
    if (!confirmed) {
      showMsg("已取消读取，输入框内容未变");
      return;
    }
  }

  const result = parseDraft(raw);
  if (!result.ok) {
    showMsg("❌草稿内容格式损坏，无法读取");
    return;
  }

  editorEl.value = result.draft.content;
  showMsg(`✅已读取本机草稿，上次保存：${new Date(result.draft.savedAt).toLocaleString()}`);
}

/** 清除本机草稿 */
function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    showMsg(describeStorageError(error));
    return;
  }
  editorEl.value = "";
  showMsg("✅本机草稿已清除");
}

// 绑定按钮事件
document.getElementById("btnSave").addEventListener("click", saveDraft);
document.getElementById("btnLoad").addEventListener("click", loadDraft);
document.getElementById("btnClear").addEventListener("click", clearDraft);

// F7 修复：补具名导出，便于 <script type="module"> 导入。
// 注意：DOM 绑定仍在模块顶层副作用中执行，import 本模块即会绑定按钮。
export { saveDraft, loadDraft, clearDraft, describeStorageError, parseDraft };
