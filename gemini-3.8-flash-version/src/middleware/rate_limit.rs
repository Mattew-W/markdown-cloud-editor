//! 基于 IP 的内存滑动窗口限流器 (严格对齐 API 规范 §06)

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// IP 限流记录
struct ClientRecord {
    count: usize,
    window_start: Instant,
}

/// 内存限流管理器
pub struct RateLimiter {
    records: Mutex<HashMap<IpAddr, ClientRecord>>,
    max_requests: usize,
    window_duration: Duration,
}

impl RateLimiter {
    /// 新建限流器
    pub fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            max_requests,
            window_duration: Duration::from_secs(window_secs),
        }
    }

    /// 检查并记录请求。若超限返回剩余等待秒数；若通过返回 None
    pub fn check(&self, ip: IpAddr) -> Option<u64> {
        let mut map = self.records.lock().unwrap();
        let now = Instant::now();

        let record = map.entry(ip).or_insert(ClientRecord {
            count: 0,
            window_start: now,
        });

        if now.duration_since(record.window_start) >= self.window_duration {
            record.count = 1;
            record.window_start = now;
            None
        } else if record.count < self.max_requests {
            record.count += 1;
            None
        } else {
            let elapsed = now.duration_since(record.window_start);
            let remaining = self
                .window_duration
                .saturating_sub(elapsed)
                .as_secs()
                .max(1);
            Some(remaining)
        }
    }
}
