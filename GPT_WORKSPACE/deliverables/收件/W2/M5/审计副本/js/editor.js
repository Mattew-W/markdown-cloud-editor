// editor.js —— 可复用的编辑器界面模块（M5 W2）
// 约定：
// - 不导入演示数据，不自动绑定不存在的 DOM；
// - 不维护 token、同步状态机、API 或 localStorage（由 M1 同步控制器接管）；
// - 预览唯一插入路径：marked.parse → DOMPurify.sanitize → innerHTML；
//   在真实渲染库注入前，本模块只使用 textContent 显示正文，禁止以
//   identity 净化器把用户内容直接写入 innerHTML。

export function createEditor({
  titleInput,
  contentInput,
  previewElement,
  parseMarkdown,
  sanitizeHtml,
}) {
  if (!titleInput || !contentInput || !previewElement) {
    throw new TypeError(
      "createEditor: titleInput、contentInput、previewElement 均为必填参数"
    );
  }

  const mdParser = typeof parseMarkdown === "function" ? parseMarkdown : null;
  const htmlSanitizer = typeof sanitizeHtml === "function" ? sanitizeHtml : null;

  let inputHandlers = [];
  let destroyed = false;

  function renderPreview() {
    const content = contentInput.value;
    if (mdParser && htmlSanitizer) {
      // 阶段2 起：真实 marked → 真实 DOMPurify → innerHTML
      const html = htmlSanitizer(mdParser(content));
      previewElement.innerHTML = html;
    } else {
      // 阶段1：渲染库接入前，预览区显示正文原文，不把用户内容当 HTML 执行
      previewElement.textContent = content;
    }
  }

  function notify() {
    if (destroyed) return;
    const payload = { title: titleInput.value, content: contentInput.value };
    inputHandlers.slice().forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("editor onInput callback error:", err);
      }
    });
  }

  function handleTitleInput() {
    notify();
  }

  function handleContentInput() {
    renderPreview();
    notify();
  }

  titleInput.addEventListener("input", handleTitleInput);
  contentInput.addEventListener("input", handleContentInput);

  return {
    getValue() {
      return { title: titleInput.value, content: contentInput.value };
    },

    // 加载文档：更新输入与预览，但不触发 onInput（加载不算用户编辑）。
    setValue({ title, content }) {
      titleInput.value = title ?? "";
      contentInput.value = content ?? "";
      renderPreview();
    },

    // 订阅输入事件：标题或正文 input 后回调一次，载荷为完整 {title, content}。
    // 返回 unsubscribe 函数。
    onInput(callback) {
      if (typeof callback !== "function") {
        throw new TypeError("onInput: 需要函数参数");
      }
      inputHandlers.push(callback);
      let subscribed = true;
      return function unsubscribe() {
        if (!subscribed) return;
        subscribed = false;
        inputHandlers = inputHandlers.filter((cb) => cb !== callback);
      };
    },

    // 移除本实例全部事件监听与订阅，避免重复初始化多次触发。
    destroy() {
      if (destroyed) return;
      destroyed = true;
      titleInput.removeEventListener("input", handleTitleInput);
      contentInput.removeEventListener("input", handleContentInput);
      inputHandlers = [];
    },
  };
}
