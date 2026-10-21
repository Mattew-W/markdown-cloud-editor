//! 服务启动入口。
//!
//! 启动顺序（任一步失败即退出，不降级运行）：
//!
//! 1. 读取并校验配置 —— 缺少密钥或密钥是占位值时**拒绝启动**
//! 2. 建立数据库连接池并验证连通性
//! 3. 启动 HTTP 服务（阶段 2 起在此执行数据库迁移）
//!
//! 对应项目规范 §09「启动时拒绝缺失密钥或明显占位值」。

use std::io;

use actix_web::{App, HttpServer, web};
use markdown_cloud_editor::{
    Config, configure_app, middleware::RequestIdLayer, routes::auth::AuthConfig, state::AppState,
};
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

/// 进程退出码：配置或依赖不可用。
///
/// 取 sysexits.h 的 `EX_CONFIG`（78），便于脚本区分"配置问题"与"运行崩溃"。
const EXIT_CONFIG_ERROR: i32 = 78;

#[actix_web::main]
async fn main() -> io::Result<()> {
    init_tracing();

    // 1. 配置闸门：不满足安全要求就退出，而不是带着弱密钥继续跑。
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("配置校验失败：{e}");
            eprintln!(
                "请检查 .env（可从 .env.example 复制），确认已设置 DATABASE_URL 与高强度 JWT_SECRET。"
            );
            std::process::exit(EXIT_CONFIG_ERROR);
        }
    };

    tracing::info!(bind_addr = %config.bind_addr, "configuration loaded");

    // 2. 数据库连接池。失败即退出：连不上库的服务无法履行 API 契约。
    let pool = match connect_pool(&config).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("无法连接数据库：{e}");
            std::process::exit(EXIT_CONFIG_ERROR);
        }
    };

    let state = web::Data::new(AppState::new(pool));
    let auth_config = web::Data::new(AuthConfig::from(&config));
    let bind_addr = config.bind_addr.clone();

    tracing::info!(%bind_addr, jwt_ttl_secs = config.jwt_ttl_secs, "starting HTTP server");

    // 3. HTTP 服务。
    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(web::Data::new(config.clone()))
            .app_data(auth_config.clone())
            .wrap(RequestIdLayer)
            .configure(configure_app)
    })
    .bind(&bind_addr)?
    .run()
    .await
}

/// 初始化日志订阅器。
///
/// `RUST_LOG` 未设置时默认 `info`；设置后按其值过滤。
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();
}

/// 建立连接池并验证连通性。
///
/// # Errors
///
/// 连接失败或连通性探测失败时返回底层 [`sqlx::Error`]。
async fn connect_pool(config: &Config) -> Result<sqlx::PgPool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;

    // 立刻探测一次，避免"进程起来了但连不上库"的假就绪状态。
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&pool)
        .await?;

    Ok(pool)
}
