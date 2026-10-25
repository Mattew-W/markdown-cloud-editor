//! M3_W1 密码校验演示（优化版 v2）
//!
//! 演示目标：
//!   1. 同一个密码用 Argon2id 加盐哈希后存储，不存明文；
//!   2. 正确密码能验证通过，错误密码验证失败；
//!   3. 损坏的哈希字符串返回可读错误，而不是程序崩溃；
//!   4. 同一密码连续哈希两次，结果不同但都能验证（随机盐）。
//!
//! 只使用虚构练习密码，不对应任何真实账号。
//!
//! 运行：`cargo run`（演示） / `cargo test`（单元测试）

use password_demo::password::{
    Argon2Params, PasswordError, PasswordPolicy, hash_password, verify_password,
};

/// 虚构练习密码，非真实账号凭据。
const DEMO_PASSWORD: &str = "Correct-Horse-Battery-Staple";
/// 虚构的错误密码。
const WRONG_PASSWORD: &str = "wrong-password-123";
/// 故意构造的损坏哈希串：盐字段含中文，PHC 格式要求 base64 字母表。
const CORRUPTED_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$很坏的盐$完全不对的哈希";

fn main() {
    let params = Argon2Params::default();

    println!("========== M3_W1 密码校验演示（v2） ==========\n");
    println!("Argon2id 参数：m={} KiB, t={}, p={}, 输出长度={} 字节\n",
        params.memory_kib, params.iterations, params.parallelism, params.output_len);

    // 案例 1：正确密码验证成功
    println!("【案例 1】正确密码 vs 正确哈希");
    let hash1 = match hash_password(DEMO_PASSWORD, &params) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("哈希生成失败：{e}");
            std::process::exit(1);
        }
    };
    println!("  生成的哈希字符串：\n  {hash1}");
    match verify_password(DEMO_PASSWORD, &hash1) {
        Ok(()) => println!("  结果：通过\n"),
        Err(e) => println!("  结果：出错：{e}\n"),
    }

    // 案例 2：错误密码验证失败
    println!("【案例 2】错误密码 vs 正确哈希");
    match verify_password(WRONG_PASSWORD, &hash1) {
        Ok(()) => println!("  结果：错误密码竟然通过了\n"),
        Err(PasswordError::PasswordMismatch) => println!("  结果：错误密码被正确拒绝\n"),
        Err(e) => println!("  结果：出错：{e}\n"),
    }

    // 案例 3：损坏的哈希字符串——必须返回错误，不能 panic
    println!("【案例 3】正确密码 vs 损坏的哈希字符串");
    println!("  损坏的哈希：{CORRUPTED_HASH}");
    match verify_password(DEMO_PASSWORD, CORRUPTED_HASH) {
        Ok(()) => println!("  结果：损坏哈希竟然验证通过\n"),
        Err(PasswordError::InvalidHashFormat(m)) => {
            println!("  结果：解析失败，返回可读错误：{m}\n")
        }
        Err(e) => println!("  结果：出错：{e}\n"),
    }

    // 案例 4：同一密码连续哈希两次，字符串不同但都能验证
    println!("【案例 4】同一密码哈希两次（随机盐演示）");
    let hash_a = hash_password(DEMO_PASSWORD, &params).expect("哈希生成不应失败");
    let hash_b = hash_password(DEMO_PASSWORD, &params).expect("哈希生成不应失败");
    println!("  第一次哈希：{hash_a}");
    println!("  第二次哈希：{hash_b}");
    println!("  两个字符串是否相等？{}", hash_a == hash_b);
    println!(
        "  用原密码验证第一次哈希：{}",
        if verify_password(DEMO_PASSWORD, &hash_a).is_ok() { "通过" } else { "失败" }
    );
    println!(
        "  用原密码验证第二次哈希：{}",
        if verify_password(DEMO_PASSWORD, &hash_b).is_ok() { "通过" } else { "失败" }
    );
    println!();

    // 案例 5（新增）：密码策略检查，不合格时列出原因
    println!("【案例 5】密码策略检查（弱密码被拦截）");
    let policy = PasswordPolicy::default();
    for candidate in ["Abcdef12", "short", "abcdefgh", "12345678"] {
        let violations = policy.check(candidate);
        if violations.is_empty() {
            println!("  「{candidate}」：通过");
        } else {
            let reasons: Vec<&str> = violations.iter().map(|v| v.message.as_str()).collect();
            println!("  「{candidate}」：不通过（{}）", reasons.join("；"));
        }
    }
    println!();

    println!("========== 演示结束 ==========");
    println!("说明：随机盐让每个用户的哈希字符串都不一样，");
    println!("即使两个用户密码相同，存进数据库的字符串也不同；");
    println!("验证时盐会从哈希字符串里一起解析出来，所以不需要单独存盐。");
    println!("注意：验证时采用哈希串自带的算法与参数，");
    println!("因此日后调整全局 Argon2id 参数也不会让历史哈希失效。");
}
