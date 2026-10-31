# vendor/ 第三方库版本与来源记录（M5 W2 阶段2）

运行依赖全部本地托管，交付后预览不依赖 CDN。

| 库 | 精确版本 | 文件 | 来源 | 许可证 |
|---|---|---|---|---|
| marked | 12.0.2 | vendor/marked/marked.min.js | 官方 npm 包 marked@12.0.2 中的浏览器构建（UMD），仓库 https://github.com/markedjs/marked | MIT |
| DOMPurify | 3.3.3 | vendor/dompurify/purify.min.js | 官方 npm 包 dompurify@3.3.3 中的 dist/purify.min.js，仓库 https://github.com/cure53/DOMPurify | Apache-2.0 OR MPL-2.0 |

获取方式：`npm pack marked@12.0.2 dompurify@3.3.3` 后从官方压缩包提取浏览器构建（与 CDN 发布的为同一官方文件）。
文件头注释已核验：marked 头部为 "marked v12.0.2 - a markdown parser"，DOMPurify 头部为 "DOMPurify 3.3.3"。

使用方式：index.html 以经典 `<script>` 顺序引入这两个文件，提供全局 marked / DOMPurify；
业务模块（js/demo.js、js/editor.js）不挂载 window 全局变量。
