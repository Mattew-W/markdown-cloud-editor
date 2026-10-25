//! M3_W1 密码校验演示小程序
//!
//! 演示目标：
//!   1. 同一个密码用 Argon2id 加盐哈希后存储，不存明文；
//!   2. 正确密码能验证通过，错误密码验证失败；
//!   3. 损坏的哈希字符串返回错误，而不是程序崩溃；
//!   4. 同一密码连续哈希两次，得到不同字符串，但都能验证通过——
//!      原因是每次哈希都使用随机生成的盐（salt）。
//!
//! 只使用虚构练习密码，不对应任何真实账号。

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;

/// 为密码生成 Argon2id 哈希字符串（PHC 格式，含算法、参数、盐、哈希值）。
///
/// 每次调用都会用 OsRng 生成一个全新的随机盐，因此即使是同一个密码，
/// 两次生成的字符串也完全不同。
fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default(); // 默认即 Argon2id 算法
    let hash = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

/// 校验输入密码是否与给定哈希字符串匹配。
///
/// - 密码正确：返回 Ok(true)
/// - 密码错误：返回 Ok(false)
/// - 哈希字符串本身损坏 / 格式不对：返回 Err（调用方需要处理，不能 panic）
fn verify_password(password: &str, hash_str: &str) -> Result<bool, argon2::password_hash::Error> {
    let parsed = PasswordHash::new(hash_str)?; // 损坏的字符串在这里解析失败
    match Argon2::default().verify_password(password.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false), // 密码不匹配
        Err(e) => Err(e), // 其他错误（参数不支持等）继续向上抛
    }
}

fn main() {
    // 注意：这只是练习用的虚构密码，不要用真实密码。
    let real_password = "Correct-Horse-Battery-Staple";
    let wrong_password = "wrong-password-123";

    println!("========== M3_W1 密码校验演示 ==========\n");

    // 案例 1：正确密码验证成功
    println!("【案例 1】正确密码 vs 正确哈希");
    let hash1 = hash_password(real_password).expect("首次哈希失败");
    println!("  生成的哈希字符串：\n  {}", hash1);
    match verify_password(real_password, &hash1) {
        Ok(true) => println!("  结果：✅ 正确密码验证通过\n"),
        Ok(false) => println!("  结果：❌ 意外失败\n"),
        Err(e) => println!("  结果：⚠️ 出错：{}\n", e),
    }

    // 案例 2：错误密码验证失败
    println!("【案例 2】错误密码 vs 正确哈希");
    match verify_password(wrong_password, &hash1) {
        Ok(true) => println!("  结果：❌ 错误密码竟然通过了？？\n"),
        Ok(false) => println!("  结果：✅ 错误密码被正确拒绝\n"),
        Err(e) => println!("  结果：⚠️ 出错：{}\n", e),
    }

    // 案例 3：损坏的哈希字符串——必须返回错误，不能 panic
    println!("【案例 3】正确密码 vs 损坏的哈希字符串");
    let corrupted = "$argon2id$v=19$m=19456,t=2,p=1$很坏的盐$完全不对的哈希";
    println!("  损坏的哈希：{}", corrupted);
    match verify_password(real_password, corrupted) {
        Ok(true) => println!("  结果：❌ 损坏哈希竟然验证通过？？\n"),
        Ok(false) => println!("  结果：✅ 损坏哈希被判定为不匹配\n"),
        Err(e) => println!("  结果：✅ 解析失败，返回可读错误：{}\n", e),
    }

    // 案例 4：同一密码连续哈希两次，字符串不同但都能验证
    println!("【案例 4】同一密码哈希两次（随机盐演示）");
    let hash_a = hash_password(real_password).expect("第二次哈希失败");
    let hash_b = hash_password(real_password).expect("第三次哈希失败");
    println!("  第一次哈希：{}", hash_a);
    println!("  第二次哈希：{}", hash_b);
    println!("  两个字符串是否相等？{}", hash_a == hash_b);
    let ok_a = verify_password(real_password, &hash_a).unwrap_or(false);
    let ok_b = verify_password(real_password, &hash_b).unwrap_or(false);
    println!("  用原密码验证第一次哈希：{}", if ok_a { "✅ 通过" } else { "❌ 失败" });
    println!("  用原密码验证第二次哈希：{}", if ok_b { "✅ 通过" } else { "❌ 失败" });
    println!();

    println!("========== 演示结束 ==========");
    println!("说明：随机盐让每个用户的哈希字符串都不一样，");
    println!("即使两个用户密码相同，存进数据库的字符串也不同；");
    println!("验证时盐会从哈希字符串里一起解析出来，所以不需要单独存盐。");
}
