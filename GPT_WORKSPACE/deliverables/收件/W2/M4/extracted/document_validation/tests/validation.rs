//! M4 W2 边界测试，测试 ID 与阶段提示词 T1～T12 一一对应。
//! 创建标题走 `normalize_create_title`，正文走 `validate_content`，更新走 `validate_update`。

use document_validation::DEFAULT_TITLE;
use document_validation::{
    normalize_create_title, validate_content, validate_title, validate_update, ValidationError,
    MAX_BODY_BYTES, MAX_TITLE_CHARS,
};

// T1 正常中文标题带首尾空白 → 返回去空白标题。
#[test]
fn t1_normal_title_is_trimmed() {
    let result = validate_title("  中文标题  ");
    assert_eq!(result.unwrap(), "中文标题");
}

// T2 创建 None（省略标题）→ 默认标题。
#[test]
fn t2_create_none_uses_default() {
    let result = normalize_create_title(None);
    assert_eq!(result.unwrap(), DEFAULT_TITLE);
}

// T3 创建 Some 空串 → EmptyTitle。
#[test]
fn t3_create_some_empty_string_is_rejected() {
    let result = normalize_create_title(Some(""));
    assert_eq!(result, Err(ValidationError::EmptyTitle));
}

// T4 全角/普通空白 → EmptyTitle，创建和更新都覆盖。
#[test]
fn t4_blank_titles_rejected_on_create_and_update() {
    // 创建：普通空白
    assert_eq!(
        normalize_create_title(Some("   ")),
        Err(ValidationError::EmptyTitle)
    );
    // 创建：全角空格、不换行空格、制表符混合
    assert_eq!(
        normalize_create_title(Some("\u{3000}\u{a0}\t")),
        Err(ValidationError::EmptyTitle)
    );
    // 创建：纯全角空格
    assert_eq!(
        normalize_create_title(Some("\u{3000}")),
        Err(ValidationError::EmptyTitle)
    );
    // 更新：普通空白
    assert_eq!(
        validate_update("   ", "正文"),
        Err(ValidationError::EmptyTitle)
    );
    // 更新：全角空白
    assert_eq!(
        validate_update("\u{3000}\n", "正文"),
        Err(ValidationError::EmptyTitle)
    );
}

// T5 255 个汉字 → 通过。
#[test]
fn t5_title_255_chars_allowed() {
    let title = "中".repeat(MAX_TITLE_CHARS);
    assert_eq!(title.chars().count(), 255);
    let result = validate_title(&title);
    let accepted = result.unwrap();
    assert_eq!(accepted.chars().count(), 255);
}

// T6 256 个汉字 → TitleTooLong { actual: 256, max: 255 }。
#[test]
fn t6_title_256_chars_rejected() {
    let title = "中".repeat(256);
    let result = validate_title(&title);
    assert_eq!(
        result,
        Err(ValidationError::TitleTooLong {
            actual: 256,
            max: MAX_TITLE_CHARS
        })
    );
}

// T7 空正文 → 通过。
#[test]
fn t7_empty_content_allowed() {
    assert_eq!(validate_content(""), Ok(()));
}

// T8 262144 字节正文 → 通过。
#[test]
fn t8_content_262144_bytes_allowed() {
    let content = "a".repeat(MAX_BODY_BYTES);
    assert_eq!(content.len(), 262144);
    assert_eq!(validate_content(&content), Ok(()));
}

// T9 262145 字节正文 → ContentTooLarge { actual: 262145, max: 262144 }。
#[test]
fn t9_content_262145_bytes_rejected() {
    let content = "a".repeat(262145);
    assert_eq!(
        validate_content(&content),
        Err(ValidationError::ContentTooLarge {
            actual: 262145,
            max: MAX_BODY_BYTES
        })
    );
}

// T10 多字节正文 "中".repeat(87381) + "a" 恰好 262144 字节通过，再加一个 a 拒绝。
#[test]
fn t10_multibyte_body_boundary() {
    let text = "中".repeat(87381) + "a";
    assert_eq!(text.len(), 262144, "构造样例必须恰好 262144 字节");
    assert_eq!(validate_content(&text), Ok(()));

    let plus_one = text + "a";
    assert_eq!(plus_one.len(), 262145);
    assert_eq!(
        validate_content(&plus_one),
        Err(ValidationError::ContentTooLarge {
            actual: 262145,
            max: MAX_BODY_BYTES
        })
    );
}

// T11 更新 "  标题  " 确实返回 "标题"，且正文首尾空白原样保留。
#[test]
fn t11_update_returns_trimmed_title_and_preserves_body() {
    let body = "  正文\n\t";
    let doc = validate_update("  标题  ", body).unwrap();
    assert_eq!(doc.title, "标题");
    assert_eq!(doc.content, body);
}

// T12 长标题前后加空白：先 trim 再计数。
#[test]
fn t12_trim_before_counting_long_title() {
    let at_limit = "  ".to_string() + &"中".repeat(255) + "  ";
    let accepted = validate_title(&at_limit).unwrap();
    assert_eq!(accepted.chars().count(), 255);

    let over_limit = "  ".to_string() + &"中".repeat(256) + "  ";
    assert_eq!(
        validate_title(&over_limit),
        Err(ValidationError::TitleTooLong {
            actual: 256,
            max: MAX_TITLE_CHARS
        })
    );
}
