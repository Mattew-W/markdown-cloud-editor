vendor/ —— 运行依赖本地托管目录（交付后预览不依赖 CDN）

M5 W2 阶段1：暂无第三方库，本目录为空。

M5 W2 阶段2：将放入官方浏览器构建（不自行编写同名简化替代库）：
- vendor/marked/      marked 12.x 浏览器构建
- vendor/dompurify/   DOMPurify 3.3.x 浏览器构建
并记录精确版本、官方来源链接与许可证。
