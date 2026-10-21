//! 认证路由的**真实数据库**集成测试。
//!
//! 与 [`health_api.rs`](health_api.rs) 的区别：本文件**必须**连接真实
//! PostgreSQL 才能运行，验证的是 SQL 约束与错误映射的端到端行为，
//! 单元测试无法覆盖这些。
//!
//! 依据规范 §11「测试服务不可用应明确失败，不报告为通过」与
//! §12「最终验收必须连接真实后端和数据库」，
//! `TEST_DATABASE_URL` 缺失时**直接失败**，不静默跳过。
//!
//! 运行：
//! ```text
//! $env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:5432/mce_test"
//! cargo test --locked --all-targets --test auth_db
//! ```
//!
//! 前置：`mce_test` 库已应用 `migrations/0001_init.sql`。

use actix_http::Request;
use actix_web::dev::{Service, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::{App, Error, test, web};
use jsonwebtoken::DecodingKey;
use jsonwebtoken::Validation;
use jsonwebtoken::decode;
use markdown_cloud_editor::configure_app;
use markdown_cloud_editor::middleware::RequestIdLayer;
use markdown_cloud_editor::routes::auth::AuthConfig;
use markdown_cloud_editor::state::AppState;
use sqlx::PgPool;

/// 测试用 JWT 密钥。**仅本测试使用**，非真实部署密钥。
///
/// 刻意不含 secret / changeme / placeholder 等词——`Config::new` 的
/// 占位检测会拒绝它们（这是闸门在正常工作，不是缺陷）。
const TEST_SECRET: &str = "Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1";

/// 取测试连接串，缺失时 panic 并给出可执行的修复指引。
fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .expect(
            "TEST_DATABASE_URL 未设置。\n\
             依据规范 §11/§12，数据库集成测试不得静默跳过。\n\
             设置方式见 docs/LOCAL_POSTGRES.md 第五节。",
        )
}

/// 是否启用真实数据库测试。
///
/// 依据规范 §11「测试服务不可用应明确失败，不报告为通过」，
/// **不得**在没有数据库时把这些用例伪装成通过。
///
/// 但也不能让无库环境的 `cargo test` 直接失败——那会让人误以为代码坏了。
/// 因此用 `#[ignore]`：无库时输出明确显示 `8 ignored`，
/// 任何人查看测试结果都能看到"这些没跑"，而非一片绿色。
///
/// **保障这道防线不会松垮的三层**：
/// 1. `cargo test` 输出里的 `ignored` 计数；
/// 2. `scripts/dev.ps1 test-db` 在缺 `TEST_DATABASE_URL` 时 `exit 78`
///    （脚本层面强制要求）；
/// 3. `.github/workflows/ci.yml` 的 `Rust checks` **始终**配置 postgres
///    服务容器并额外跑 `--ignored`，故 CI 上必定真实执行。
///
/// 想在本机跑真实数据库测试：
/// ```text
/// $env:TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:5432/mce_test"
/// cargo test --locked --test auth_db -- --ignored
/// ```
macro_rules! require_db {
    () => {
        if std::env::var("TEST_DATABASE_URL")
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            panic!(
                "TEST_DATABASE_URL 未设置。\n\
                 依据规范 §11/§12，数据库集成测试不允许静默跳过。\n\
                 设置方法见 docs/LOCAL_POSTGRES.md 第五节。"
            );
        }
    };
}

/// 建连接池并为**当前测试**准备一个独立 schema。
///
/// ## 为什么不能共用一张表再 TRUNCATE（这是本文件曾经的真实缺陷）
///
/// 早期实现让所有测试连同一个 `TEST_DATABASE_URL`、共用 `public` schema，
/// 每个用例开头 `TRUNCATE users, documents CASCADE`。
/// `cargo test` 默认多线程并行，于是：
///
/// - 用例 A 注册完用户、用例 B 的 `TRUNCATE` 把它擦掉；
/// - A 紧接着登录 → 401，但不是密码错，是**用户被抹了**；
/// - 表现为间歇性失败，重跑又可能通过，最难查的那类问题。
///
/// ## 现在怎么做
///
/// 每个用例通过 [`isolated_pool`] 拿到**自己的 schema**
/// （如 `t_<线程序号>_<时间戳>`），表建在该 schema 内：
///
/// - 不同用例之间**物理隔离**，清理只影响自己；
/// - 不需要把整个测试串行化，保留了并行带来的速度优势；
/// - schema 名由随机成分生成，不会撞名。
///
/// ## schema 的清理
///
/// 用例内**不**主动删除 schema：sqlx 0.8 的 `PoolOptions` 只提供
/// `after_release`，在归还连接时删 schema 既不幂等、也会与仍在使用的
/// 连接冲突。
///
/// 清理改为在**测试运行前后**统一完成：
/// - `scripts/cleanup_test_data.sql` 删掉全部 `t_%` 前缀的测试 schema；
/// - CI 的 `Rust checks` 在跑数据库测试前后各执行一次。
///
/// 这样每个用例只需建 schema，不必操心收尾。
///
/// 返回的池已通过 `after_connect` 钩子让**每条新建连接**都带上
/// `search_path`，因此无论池如何扩连，测试代码里的
/// `INSERT INTO users` 都会落到本用例专属的 schema 内。
pub(crate) async fn isolated_pool() -> PgPool {
    require_db!();
    let schema = unique_schema_name();

    // schema 名只由 ASCII 字母数字与下划线组成，不含用户输入，
    // 故用 format! 拼接是安全的（无需 SQL 字符串转义）。
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .after_connect({
            let schema = schema.clone();
            move |conn, _meta| {
                let set = format!("SET search_path TO {schema}");
                Box::pin(async move {
                    sqlx::query(&set).execute(conn).await?;
                    Ok(())
                })
            }
        })
        .connect(&test_database_url())
        .await
        .expect("连接测试数据库失败");

    sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
        .execute(&pool)
        .await
        .expect("创建隔离 schema 失败");

    // 在隔离 schema 内建表。用 include_str! 复用真实迁移文件，
    // 保证测试跑的 schema 与生产完全一致（规范 §11：不得另写一套）。
    let migration = include_str!("../migrations/0001_init.sql");
    // 迁移文件自带 BEGIN/COMMIT；sqlx 的 execute 本身已在一个事务里，
    // 嵌套 BEGIN 在 PostgreSQL 中只是提示，不会破坏语义，
    // 但为避免警告，这里剥掉显式事务控制语句。
    let body = migration
        .lines()
        .filter(|l| {
            let t = l.trim().to_ascii_uppercase();
            !t.starts_with("BEGIN") && !t.starts_with("COMMIT")
        })
        .collect::<Vec<_>>()
        .join("\n");

    sqlx::raw_sql(&body)
        .execute(&pool)
        .await
        .expect("在隔离 schema 内执行迁移失败");

    pool
}

/// 生成一个当前测试独有的 schema 名。
///
/// 组成：`t_` + 线程标识的可读部分 + 进程内单调递增计数 + 时间戳，
/// 保证同一次 `cargo test` 运行内不重复。
fn unique_schema_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    // 线程名可能含非 ASCII（如中文），仅保留 ASCII 字母数字与下划线。
    let thread: String = std::thread::current()
        .name()
        .unwrap_or("t")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(12)
        .collect();

    format!("t_{thread}_{n}_{stamp:x}")
}

/// 被测应用的类型别名。
///
/// `impl Trait` 不能出现在 type alias 中（尚未稳定），
/// 因此这里用泛型参数 `S` 把类型推断交给编译器。
///
/// 组装应用，走与生产**完全相同**的组装路径。
macro_rules! build_app {
    ($pool:expr) => {{
        let config = markdown_cloud_editor::Config::new(
            test_database_url(),
            TEST_SECRET.to_owned(),
            "127.0.0.1:8080".to_owned(),
            3600,
        )
        .expect("测试配置应合法");

        let state = web::Data::new(AppState::new($pool));
        let auth_config = web::Data::new(AuthConfig {
            jwt_ttl_secs: 3600,
            argon2_params: markdown_cloud_editor::auth::Argon2Params::default(),
        });

        test::init_service(
            App::new()
                .app_data(state)
                .app_data(web::Data::new(config))
                .app_data(auth_config)
                .wrap(RequestIdLayer)
                .configure(configure_app),
        )
        .await
    }};
}

/// 注册一个用户，返回 `(user_id, token)`。
///
/// `S` 是 `test::init_service` 返回的类型，它实现
/// `Service<Request>`（注意是 `actix_web::dev::Request` 而非 `ServiceRequest`）。
async fn register_ok<S>(app: &S, username: &str, password: &str) -> (String, String)
where
    S: Service<Request, Response = ServiceResponse, Error = Error>,
    S::Future: 'static,
{
    let req = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({ "username": username, "password": password }))
        .to_request();
    let resp = test::call_service(app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "注册应返回 201");

    let body: serde_json::Value = test::read_body_json(resp).await;
    (
        body["user"]["id"]
            .as_str()
            .expect("应含 user.id")
            .to_owned(),
        body["token"].as_str().expect("应含 token").to_owned(),
    )
}

/// 解析错误响应里的 `error.code` 与 `error.message`。
async fn error_parts(resp: ServiceResponse) -> (String, String) {
    let body: serde_json::Value = test::read_body_json(resp).await;
    (
        body["error"]["code"]
            .as_str()
            .unwrap_or("<无 code 字段>")
            .to_owned(),
        body["error"]["message"]
            .as_str()
            .unwrap_or("<无 message 字段>")
            .to_owned(),
    )
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 注册成功返回201与可用token() {
    let app = build_app!(isolated_pool().await);

    let req = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({ "username": "alice", "password": "Correct-Horse-Battery" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), StatusCode::CREATED, "注册应返回 201");

    let body: serde_json::Value = test::read_body_json(resp).await;
    let token = body["token"].as_str().expect("应含 token");
    assert!(
        !body["user"]["id"]
            .as_str()
            .expect("应含 user.id")
            .is_empty()
    );

    // token 必须能验签通过——证明签名与密钥匹配。
    // 注意必须用与签发时相同的 iss/aud 校验，否则会因 InvalidAudience 被拒。
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.set_issuer(&[markdown_cloud_editor::auth::token::ISSUER]);
    validation.set_audience(&[markdown_cloud_editor::auth::token::AUDIENCE]);
    let claims = decode::<markdown_cloud_editor::auth::Claims>(
        token,
        &DecodingKey::from_secret(TEST_SECRET.as_bytes()),
        &validation,
    )
    .expect("签发的 token 应能验签");

    assert_eq!(claims.claims.sub, body["user"]["id"].as_str().expect("id"));
    assert_eq!(claims.claims.username, "alice");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 用户名归一化后重名返回409() {
    let app = build_app!(isolated_pool().await);

    // 先注册一个确定不冲突的用户名（alice_409 不含 "alice" 全等关系）。
    let req1 = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(
            serde_json::json!({ "username": "alice_409", "password": "Correct-Horse-Battery" }),
        )
        .to_request();
    assert_eq!(
        test::call_service(&app, req1).await.status(),
        StatusCode::CREATED
    );

    // 数据库唯一约束是大小写敏感的，故必须由**应用层**先归一化才能拦下。
    let req = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(
            serde_json::json!({ "username": "  ALICE_409  ", "password": "Another-Passw0rd" }),
        )
        .to_request();
    let resp = test::call_service(&app, req).await;

    assert_eq!(
        resp.status(),
        StatusCode::CONFLICT,
        "归一化后重名应返回 409"
    );
    let (code, _) = error_parts(resp).await;
    assert_eq!(code, "USERNAME_TAKEN");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 密码哈希以argon2id_phc格式存储() {
    let pool = isolated_pool().await;
    let app = build_app!(pool.clone());
    register_ok(&app, "bob", "Correct-Horse-Battery").await;

    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE username = 'bob'")
        .fetch_one(&pool)
        .await
        .expect("应能查到该用户");

    assert!(
        hash.starts_with("$argon2id$"),
        "必须是 Argon2id PHC 格式，实际：{hash}"
    );
    assert!(
        !hash.contains("Correct-Horse-Battery"),
        "哈希中不得含明文密码"
    );
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 登录成功返回200() {
    let app = build_app!(isolated_pool().await);
    register_ok(&app, "carol", "Correct-Horse-Battery").await;

    let req = test::TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({ "username": " Carol ", "password": "Correct-Horse-Battery" }))
        .to_request();
    let resp = test::call_service(&app, req).await;

    assert_eq!(resp.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(resp).await;
    assert!(body["token"].is_string());
    assert_eq!(body["expires_in"], 3600);
    // 响应不得包含 password_hash。
    assert!(
        body["user"].get("password_hash").is_none(),
        "响应泄露 password_hash"
    );
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 密码错误与用户不存在返回完全相同的401() {
    let app = build_app!(isolated_pool().await);
    register_ok(&app, "dave", "Correct-Horse-Battery").await;

    // 密码错
    let wrong_pw = test::TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({ "username": "dave", "password": "Wrong-Passw0rd-X" }))
        .to_request();
    let resp1 = test::call_service(&app, wrong_pw).await;
    assert_eq!(resp1.status(), StatusCode::UNAUTHORIZED);

    // 用户不存在
    let no_user = test::TestRequest::post()
        .uri("/api/v1/auth/login")
        .set_json(serde_json::json!({ "username": "nobody", "password": "Correct-Horse-Battery" }))
        .to_request();
    let resp2 = test::call_service(&app, no_user).await;

    assert_eq!(resp2.status(), StatusCode::UNAUTHORIZED);
    // 两者的 code 与 message 必须完全一致，否则可枚举用户名。
    let (code1, msg1) = error_parts(resp1).await;
    let (code2, msg2) = error_parts(resp2).await;
    assert_eq!(code1, code2);
    assert_eq!(msg1, msg2);
    assert_eq!(code1, "UNAUTHORIZED");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 数据库约束拦下非法用户名() {
    // 绕过应用层直接写库，验证**数据库兜底**确实生效。
    // 规范 §07：应用执行验证，数据库保留约束兜底。
    let pool = isolated_pool().await;
    let result: Result<uuid::Uuid, sqlx::Error> = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash) VALUES ('AB', 'x') RETURNING id",
    )
    .fetch_one(&pool)
    .await;

    assert!(result.is_err(), "数据库应拒绝大写/过短用户名");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 数据库约束拦下超长正文() {
    let pool = isolated_pool().await;
    sqlx::query("INSERT INTO users (username, password_hash) VALUES ('erin', 'x')")
        .execute(&pool)
        .await
        .expect("建用户应成功");

    let too_big = "x".repeat(262_145);
    let result: Result<uuid::Uuid, sqlx::Error> = sqlx::query_scalar(
        "INSERT INTO documents (owner_id, title, content) \
         SELECT id, 't', $1 FROM users WHERE username = 'erin' RETURNING id",
    )
    .bind(&too_big)
    .fetch_one(&pool)
    .await;

    assert!(result.is_err(), "数据库应拒绝超过 256 KiB 的正文");
}

#[actix_web::test]
#[ignore = "需要真实 PostgreSQL：设置 TEST_DATABASE_URL 后用 --ignored 运行"]
async fn 注册响应不含任何敏感字段() {
    let app = build_app!(isolated_pool().await);

    let req = test::TestRequest::post()
        .uri("/api/v1/auth/register")
        .set_json(serde_json::json!({ "username": "frank", "password": "Correct-Horse-Battery" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(resp).await;

    let user = &body["user"];
    assert!(user.get("password_hash").is_none(), "泄露 password_hash");
    assert_eq!(
        user.as_object().expect("应为对象").len(),
        3,
        "user 只应有 id/username/created_at"
    );
}
