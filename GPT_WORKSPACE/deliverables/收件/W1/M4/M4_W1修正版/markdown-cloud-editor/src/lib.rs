//! M4 W1 修正版：文档 DTO 契约 + 业务服务层 + 仓储抽象。
//!
//! 本 crate 是 2026-10-24 审计修正版（M1），相对 M4 原始交付修正了：
//! 413 语义映射、update 路径标题归一化、稳定错误码、时间戳秒级精度、
//! 响应类型命名与 `DeleteDocumentQuery` 缺失、仓储错误分层等问题，
//! 并补齐主 crate 级 lint（missing_docs + pedantic）合规。
//! 修正明细见同目录 `检查记录.md` 与审计报告 §8。
//!
//! 校验规则以 `docs/API.md`（2026-10-21 冻结）为唯一权威：
//! 标题按 Unicode 标量值 1..=255，正文按 UTF-8 字节 ≤ 262 144，
//! 时间戳输出秒级 RFC 3339 UTC 字符串。
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
// 与主仓库 lib.rs 保持同样的两条豁免：模块名重复（DTO 命名惯例）与
// 中文文档中被 doc_markdown 误判为标识符的普通词汇。
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::doc_markdown)]

pub mod dto;
pub mod services;
