const demoDocuments = [
  {
    id: "demo-1",
    title: "课程笔记（演示数据）",
    updatedAt: "2026-10-20 14:30",
    content: "# Markdown 语法速记\n\n## 标题\n用 # 号表示标题层级。\n\n## 列表\n- 无序列表用短横线\n- 有序列表用数字\n\n## 代码\n行内代码用反引号 `code`。\n\n> 这是一段引用文字。\n\n**加粗** 和 *斜体* 也很常用。"
  },
  {
    id: "demo-2",
    title: "项目计划（演示数据）",
    updatedAt: "2026-10-21 09:15",
    content: "# 云同步 Markdown 编辑器\n\n## 本周目标\n1. 完成静态页面外观\n2. 三栏布局：列表 / 编辑 / 预览\n3. 预览暂用纯文本展示\n\n## 后续\n- 接入 marked 渲染\n- 接入 DOMPurify 净化\n- 对接后端自动保存"
  },
  {
    id: "demo-3",
    title: "长标题测试用例用于验证文档列表在标题非常长的时候是否能够正确截断而不撑破布局（演示数据）",
    updatedAt: "2026-10-22 10:00",
    content: "# 长文档测试\n\n这篇文档的标题特别长，用来测试：\n- 文档列表是否正确截断\n- 标题输入框是否正常显示\n- 窗口变窄时布局是否稳定\n\n正文部分也可以写很多内容，\n用来测试滚动条是否正常工作。\n\n" + "\n测试滚动用的填充段落。\n".repeat(20)
  }
];

const docListEl = document.getElementById("docList");
const titleInput = document.getElementById("docTitle");
const contentInput = document.getElementById("docContent");
const previewEl = document.getElementById("preview");
const saveBtn = document.getElementById("saveBtn");
const statusText = document.getElementById("statusText");
const docInfo = document.getElementById("docInfo");

let currentDocId = null;
let loadedTitle = "";
let loadedContent = "";

function renderDocList() {
  docListEl.innerHTML = "";
  demoDocuments.forEach((doc) => {
    const li = document.createElement("li");
    li.className = "doc-list-item";
    if (doc.id === currentDocId) {
      li.classList.add("active");
    }
    li.dataset.id = doc.id;

    const titleSpan = document.createElement("div");
    titleSpan.className = "doc-list-item-title";
    titleSpan.textContent = doc.title;

    const metaSpan = document.createElement("div");
    metaSpan.className = "doc-list-item-meta";
    metaSpan.textContent = doc.updatedAt;

    li.appendChild(titleSpan);
    li.appendChild(metaSpan);
    li.addEventListener("click", () => handleDocClick(doc.id));
    docListEl.appendChild(li);
  });
}

function isDirty() {
  return (
    currentDocId !== null &&
    (titleInput.value !== loadedTitle || contentInput.value !== loadedContent)
  );
}

function loadDocument(docId) {
  const doc = demoDocuments.find((d) => d.id === docId);
  if (!doc) return;

  currentDocId = doc.id;
  loadedTitle = doc.title;
  loadedContent = doc.content;
  titleInput.value = doc.title;
  contentInput.value = doc.content;
  updatePreview();
  renderDocList();
  updateDocInfo();
  setStatus("已切换到：" + doc.title, "");
}

function handleDocClick(docId) {
  if (docId === currentDocId) return;

  if (isDirty()) {
    const ok = window.confirm(
      "当前文档有未保存的修改，切换后将丢失这些修改。确定切换吗？"
    );
    if (!ok) return;
  }
  loadDocument(docId);
}

function updatePreview() {
  previewEl.textContent = contentInput.value;
}

function updateDocInfo() {
  if (currentDocId) {
    const doc = demoDocuments.find((d) => d.id === currentDocId);
    docInfo.textContent = doc ? "当前：" + doc.id : "";
  } else {
    docInfo.textContent = "";
  }
}

function setStatus(text, type) {
  statusText.textContent = text;
  statusText.classList.remove("saving", "error");
  if (type) {
    statusText.classList.add(type);
  }
}

titleInput.addEventListener("input", () => {
  setStatus("编辑中（未保存）", "");
});

contentInput.addEventListener("input", () => {
  updatePreview();
  setStatus("编辑中（未保存）", "");
});

saveBtn.addEventListener("click", () => {
  setStatus("演示模式，尚未接入保存", "saving");
  window.setTimeout(() => {
    if (currentDocId) {
      setStatus("就绪", "");
    }
  }, 1500);
});

window.addEventListener("beforeunload", (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

renderDocList();
loadDocument(demoDocuments[0].id);
