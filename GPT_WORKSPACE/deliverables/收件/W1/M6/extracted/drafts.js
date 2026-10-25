const STORAGE_KEY = "markdown-editor-demo:M6:W1";
const editorEl = document.getElementById('editor');
const msgEl = document.getElementById('msg');

// 显示提示
function showMsg(text) {
    msgEl.innerText = text;
}

// 保存草稿：内容 + 保存时间
function saveDraft() {
    const content = editorEl.value;
    const draft = {
        content: content,
        savedAt: Date.now()
    };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
        showMsg(`✅保存成功，保存时间：${new Date().toLocaleString()}`);
    } catch (e) {
        if(e.name === 'QuotaExceededError'){
            showMsg("❌存储失败：浏览器本地空间不足");
        }else{
            showMsg(`❌保存出错：${e.message}`);
        }
    }
}

// 读取草稿
function loadDraft() {
    // 如果输入框已有文字，先确认
    if(editorEl.value.trim() !== ""){
        if(!confirm("当前输入框有内容，读取草稿会覆盖，确定继续吗？")){
            return;
        }
    }
    let raw;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    }catch(e){
        showMsg("❌浏览器localStorage不可用");
        return;
    }
    if(!raw){
        showMsg("暂无本机草稿");
        return;
    }
    try{
        const draft = JSON.parse(raw);
        editorEl.value = draft.content;
        showMsg(`✅读取成功，上次保存：${new Date(draft.savedAt).toLocaleString()}`);
    }catch(err){
        showMsg("❌草稿内容格式损坏，无法读取");
    }
}

// 清除草稿
function clearDraft() {
    try{
        localStorage.removeItem(STORAGE_KEY);
        editorEl.value = "";
        showMsg("✅本机草稿已清除");
    }catch(e){
        showMsg(`❌清除失败：${e.message}`);
    }
}

// 绑定按钮事件
document.getElementById('btnSave').addEventListener('click', saveDraft);
document.getElementById('btnLoad').addEventListener('click', loadDraft);
document.getElementById('btnClear').addEventListener('click', clearDraft);