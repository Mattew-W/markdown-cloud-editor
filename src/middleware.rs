//! 请求追踪 ID 中间件。
//!
//! 每个请求进入时生成（或沿用客户端传入的）UUID v4，写入请求扩展，
//! 并在响应头 `X-Request-Id` 中回传。错误响应体里的 `error.request_id`
//! 取自同一 ID，便于用户报障时定位具体请求。
//!
//! 对应项目规范 §06：错误结构必须包含 `error.request_id`。

use actix_web::body::MessageBody;
use actix_web::dev::{ServiceRequest, ServiceResponse};
use actix_web::{Error, HttpMessage};
use uuid::Uuid;

use crate::error::{REQUEST_ID_HEADER, REQUEST_ID_HEADER_LOWERCASE};

/// 请求扩展中保存追踪 ID 的键。
pub const REQUEST_ID_KEY: &str = "request_id";

/// 生成新的请求追踪 ID。
#[must_use]
pub fn new_request_id() -> String {
    Uuid::new_v4().to_string()
}

/// 判断上游传入的追踪 ID 是否可安全沿用。
///
/// 只接受可见 ASCII 的「字母、数字、连字符、下划线、点、冒号」，
/// 长度 1–200。放宽到任意 ASCII 会让含空格的值被采纳，
/// 进而污染日志与错误响应；收紧则可能拒绝某些代理的自定义 ID 格式。
fn is_valid_inbound_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// 从请求扩展中取出当前请求的追踪 ID。
///
/// 线程局部值初始为空串，表示"当前不在任何请求上下文中"。
/// 此时返回 [`REQUEST_ID_UNKNOWN`] 而非空串——错误响应体必须始终能给出可读的
/// 追踪标识，不能是 `""`。
#[must_use]
pub fn current_request_id() -> String {
    REQUEST_ID
        .try_with(|cell| cell.borrow().clone())
        .ok()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| REQUEST_ID_UNKNOWN.to_owned())
}

/// 请求 ID 缺失时的占位值。
pub const REQUEST_ID_UNKNOWN: &str = "unknown";

// 用 `thread_local!` + `RefCell`：String 不是 Copy，且需要整体替换语义。
// 注意：这里**不能**再加 `const { ... }` 初始化块——
// clippy 的 missing_const_for_thread_local 见到该块仍会报错（宏展开前不可见）。
thread_local! {
    static REQUEST_ID: std::cell::RefCell<String> = std::cell::RefCell::new(String::new());
}

/// 在给定作用域内设置当前请求的追踪 ID（仅同步闭包）。
///
/// 【重要】本函数**不可**用于异步处理器：若闭包返回 `Future`，
/// 作用域会在返回瞬间恢复，而 `Future` 的轮询发生在作用域之外——
/// 此时处理器内 `current_request_id()` 取不到值，
/// 错误体会序列化成 `request_id: "unknown"`，与响应头的真实 ID 不一致。
///
/// 这正是本模块原先的缺陷。异步路径现由 [`RequestIdFuture`] 在
/// **每次 poll** 前后分别设置与恢复。
///
/// 本函数保留用于：① 单元测试构造受控作用域；② 将来可能的同步处理器。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn with_request_id<F, R>(id: &str, f: F) -> R
where
    F: FnOnce() -> R,
{
    REQUEST_ID.with(|cell| {
        let previous = cell.borrow().clone();
        id.clone_into(&mut *cell.borrow_mut());
        let result = f();
        *cell.borrow_mut() = previous;
        result
    })
}

/// 把追踪 ID 的作用域延伸到 `Future` 的**每一次 poll**。
///
/// 解决如下问题：原实现写的是
/// `with_request_id(&id, || service.call(req)).await`——
/// 闭包同步返回 `Future` 后 `with_request_id` 就已恢复 TLS，
/// 而 `.await` 驱动 Future 轮询发生在作用域之外。异步处理器因此取不到 ID，
/// 错误体里 `request_id` 序列化成 `unknown`，而响应头却是真实 ID，两者不一致。
///
/// 本包装器在每次 `poll` 前写入 TLS、poll 结束后恢复，
/// 使处理器及其全部 `.await` 子调用都能读到同一个 ID，
/// 且不会在并发请求之间互相污染。
struct RequestIdFuture<F> {
    /// 用 `Box` 固定，使 `inner` 自身可安全获得 `Pin<&mut F>`，
    /// 从而**无需 unsafe** 即可投影（本项目规范 §10 要求审慎使用 unsafe，
    /// 这里直接规避）。
    inner: std::pin::Pin<Box<F>>,
    request_id: String,
}

impl<F> RequestIdFuture<F> {
    fn new(inner: F, request_id: String) -> Self {
        Self {
            inner: Box::pin(inner),
            request_id,
        }
    }
}

impl<F, T> std::future::Future for RequestIdFuture<F>
where
    F: std::future::Future<Output = T>,
{
    type Output = T;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        // `Self` 整体被 pin，但 `inner` 已是 `Pin<Box<F>>`，
        // 取 `&mut` 不会移动它，因此此处只需结构体本身不被移动的保证。
        let this = self.get_mut();

        REQUEST_ID.with(|cell| {
            let previous = cell.borrow().clone();
            this.request_id.clone_into(&mut *cell.borrow_mut());
            let polled = this.inner.as_mut().poll(cx);
            *cell.borrow_mut() = previous;
            polled
        })
    }
}

/// actix-web 中间件：为每个请求附加追踪 ID。
#[derive(Debug, Clone, Copy, Default)]
pub struct RequestIdLayer;

impl<S, B> actix_web::dev::Transform<S, ServiceRequest> for RequestIdLayer
where
    S: actix_web::dev::Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>
        + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = RequestIdService<S>;
    type Future = std::future::Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        std::future::ready(Ok(RequestIdService {
            service: std::sync::Arc::new(service),
        }))
    }
}

/// `RequestIdLayer` 的内部服务。
pub struct RequestIdService<S> {
    service: std::sync::Arc<S>,
}

impl<S, B> actix_web::dev::Service<ServiceRequest> for RequestIdService<S>
where
    S: actix_web::dev::Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>
        + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future =
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>>>>;

    actix_web::dev::forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let service = std::sync::Arc::clone(&self.service);

        // 沿用上游代理传入的合法 X-Request-Id，否则新生成，保证全链路一致。
        let incoming = req
            .headers()
            .get(REQUEST_ID_HEADER)
            .and_then(|v| v.to_str().ok())
            .filter(|v| is_valid_inbound_id(v))
            .map_or_else(new_request_id, ToOwned::to_owned);

        req.extensions_mut()
            .insert(RequestIdValue(incoming.clone()));

        Box::pin(async move {
            let request_id = incoming.clone();
            // 把 ID 的作用域延伸到 Future 的每次 poll：
            // 若只写 `with_request_id(&id, || service.call(req)).await`，
            // 闭包在返回 Future 的瞬间就恢复 TLS，`.await` 轮询发生在作用域外，
            // 异步处理器构造 AppError 时会取到 `unknown`，
            // 导致响应头（真实 ID）与错误体（unknown）不一致。
            let result = RequestIdFuture::new(service.call(req), request_id.clone()).await;
            match result {
                Ok(mut response) => {
                    // 写入请求时用静态小写名（from_static 要求全小写且编译期已知），
                    // 查询时用原始大小写形式（headers().get 需匹配线上规范名）。
                    if let Ok(value) = actix_web::http::header::HeaderValue::from_str(&request_id) {
                        response.headers_mut().insert(
                            actix_web::http::header::HeaderName::from_static(
                                REQUEST_ID_HEADER_LOWERCASE,
                            ),
                            value,
                        );
                    }
                    Ok(response)
                }
                Err(e) => Err(e),
            }
        })
    }
}

/// 存入请求扩展的追踪 ID 值。
#[derive(Debug, Clone)]
pub struct RequestIdValue(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 新请求id为合法uuid_v4() {
        let id = new_request_id();
        assert_eq!(id.len(), 36);
        assert!(Uuid::parse_str(&id).is_ok(), "不是合法 UUID：{id}");
    }

    #[test]
    fn 每次生成互不相同() {
        let a = new_request_id();
        let b = new_request_id();
        assert_ne!(a, b);
    }

    #[test]
    fn 未安装中间件时回退占位值() {
        // 错误响应体必须始终能给出可读追踪标识，故不能是空串。
        assert_eq!(current_request_id(), REQUEST_ID_UNKNOWN);
    }

    #[test]
    fn 作用域内取到传入的请求id() {
        let captured = with_request_id("abc-123", current_request_id);
        assert_eq!(captured, "abc-123");
    }

    #[test]
    fn 作用域结束后恢复原值() {
        // 防止请求之间串号：A 请求的 ID 泄漏到 B 请求的错误响应里。
        with_request_id("first", || ());
        with_request_id("second", || ());
        assert_eq!(current_request_id(), REQUEST_ID_UNKNOWN);
    }
}
