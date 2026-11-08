//! Gemini 3.8 Flash Edition 服务端入口主程序

use actix_cors::Cors;
use actix_files as fs;
use actix_web::middleware::Logger;
use actix_web::{App, HttpServer, web};
use gemini_markdown_cloud_editor::middleware::RateLimiter;
use gemini_markdown_cloud_editor::{
    AppState, Config, DatabaseKind, DbPool, configure_app, run_migrations,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::sqlite::SqlitePoolOptions;
use std::path::Path;
use tracing::info;

#[actix_web::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,actix_web=info")),
        )
        .init();

    info!("🚀 正在启动 Gemini 3.8 Flash Markdown Cloud Editor...");

    let config = Config::from_env().map_err(|e| {
        tracing::error!("配置加载失败: {e}");
        e
    })?;

    info!("📦 数据库模式: {:?}", config.database_kind);
    let db = match config.database_kind {
        DatabaseKind::Sqlite => {
            let pool = SqlitePoolOptions::new()
                .max_connections(10)
                .connect(&config.database_url)
                .await?;
            DbPool::Sqlite(pool)
        }
        DatabaseKind::Postgres => {
            let pool = PgPoolOptions::new()
                .max_connections(20)
                .connect(&config.database_url)
                .await?;
            DbPool::Postgres(pool)
        }
    };

    info!("🔄 正在执行数据库迁移与契约验证...");
    run_migrations(&db).await?;
    info!("✅ 数据库迁移成功！");

    let app_state = AppState::new(config.clone(), db);
    let rate_limiter = RateLimiter::new(5, 60); // 5 请求 / 60 秒

    let bind_addr = config.bind_addr.clone();
    info!("🌐 服务已就绪，正在监听: http://{}", bind_addr);
    info!(
        "🤖 Gemini AI 模式: {}",
        if config.gemini_api_key.is_some() {
            "在线 API 模式"
        } else {
            "本地离线高保真模拟模式"
        }
    );

    let state_data = web::Data::new(app_state);
    let limiter_data = web::Data::new(rate_limiter);

    HttpServer::new(move || {
        let cors = Cors::permissive();

        let app = App::new()
            .wrap(Logger::default())
            .wrap(cors)
            .app_data(state_data.clone())
            .app_data(limiter_data.clone())
            .configure(configure_app);

        // 如果存在 static 目录，挂载静态页面服务
        if Path::new("static").exists() {
            app.service(fs::Files::new("/", "static").index_file("index.html"))
        } else if Path::new("gemini-3.8-flash-version/static").exists() {
            app.service(
                fs::Files::new("/", "gemini-3.8-flash-version/static").index_file("index.html"),
            )
        } else {
            app
        }
    })
    .bind(&bind_addr)?
    .run()
    .await?;

    Ok(())
}
