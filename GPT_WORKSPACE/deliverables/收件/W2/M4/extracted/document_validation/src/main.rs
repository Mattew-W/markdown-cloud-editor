//! 规则演示（非业务入口）：8 项样例逐项展示输入摘要、预期、实际与 PASS/FAIL。
//! 判定结果由真实调用返回值与预期比较得到；任一项失败则进程以非零码退出。

use document_validation::{
    normalize_create_title, validate_content, validate_title, ValidationError, DEFAULT_TITLE,
};

struct Case {
    name: String,
    input_summary: String,
    expected: String,
    actual: String,
    pass: bool,
}

/// 标题类（`validate_title`）样例。
fn title_case(name: &str, raw: &str, want: Result<&str, ValidationError>) -> Case {
    let result = validate_title(raw);
    let actual = match &result {
        Ok(value) => format!("接受：{value:?}"),
        Err(err) => format!("拒绝：{err}"),
    };
    let expected = match &want {
        Ok(value) => format!("接受：{value:?}"),
        Err(err) => format!("拒绝：{err}"),
    };
    Case {
        name: name.to_string(),
        input_summary: format!("{raw:?}，trim 前 {} 字符", raw.chars().count()),
        expected,
        actual,
        pass: result.as_deref() == want.as_deref(),
    }
}

/// 创建类（`normalize_create_title`）样例。
fn create_case(name: &str, raw: Option<&str>, want: Result<&str, ValidationError>) -> Case {
    let result = normalize_create_title(raw);
    let actual = match &result {
        Ok(value) => format!("接受：{value:?}"),
        Err(err) => format!("拒绝：{err}"),
    };
    let expected = match &want {
        Ok(value) => format!("接受：{value:?}"),
        Err(err) => format!("拒绝：{err}"),
    };
    Case {
        name: name.to_string(),
        input_summary: format!("{raw:?}"),
        expected,
        actual,
        pass: result.as_deref() == want.as_deref(),
    }
}

/// 正文类（`validate_content`）样例。
fn content_case(name: &str, raw: &str, want: Result<(), ValidationError>) -> Case {
    let result = validate_content(raw);
    let actual = match &result {
        Ok(()) => format!("接受：{} 字节合法", raw.len()),
        Err(err) => format!("拒绝：{err}"),
    };
    let expected = match &want {
        Ok(()) => "接受：字节数合法".to_string(),
        Err(err) => format!("拒绝：{err}"),
    };
    Case {
        name: name.to_string(),
        input_summary: format!("{} 字节", raw.len()),
        expected,
        actual,
        pass: result == want,
    }
}

fn main() {
    let title_255 = "中".repeat(255);
    let title_256 = "中".repeat(256);
    let body_262144 = "a".repeat(262_144);
    let body_262145 = "a".repeat(262_145);

    let cases = [
        // 1 正常标题
        title_case("正常标题（含首尾空白）", "  中文标题  ", Ok("中文标题")),
        // 2 创建省略标题
        create_case("创建省略标题 None", None, Ok(DEFAULT_TITLE)),
        // 3 显式空串拒绝
        create_case(
            "创建显式空串 Some(\"\")",
            Some(""),
            Err(ValidationError::EmptyTitle),
        ),
        // 4 255 字符通过
        title_case("255 个汉字标题", &title_255, Ok(&title_255)),
        // 5 256 字符拒绝
        title_case(
            "256 个汉字标题",
            &title_256,
            Err(ValidationError::TitleTooLong {
                actual: 256,
                max: 255,
            }),
        ),
        // 6 空正文通过
        content_case("空正文", "", Ok(())),
        // 7 262144 字节通过
        content_case("262144 字节正文", &body_262144, Ok(())),
        // 8 262145 字节拒绝
        content_case(
            "262145 字节正文",
            &body_262145,
            Err(ValidationError::ContentTooLarge {
                actual: 262145,
                max: 262144,
            }),
        ),
    ];

    let total = cases.len();
    let mut passed = 0usize;
    for (index, case) in cases.iter().enumerate() {
        if case.pass {
            passed += 1;
        }
        println!("[{}] {}", index + 1, case.name);
        println!("    输入: {}", case.input_summary);
        println!("    预期: {}", case.expected);
        println!("    实际: {}", case.actual);
        println!("    {}", if case.pass { "PASS" } else { "FAIL" });
    }

    println!("结果: {passed}/{total} PASS");
    if passed != total {
        std::process::exit(1);
    }
}
