/**
 * run_tests.mjs —— 生成真实测试日志（TAP 原文，UTF-8）
 *
 * 用途：检查记录与交付说明要贴真实 runner 输出，不能手写摘要。
 * 运行：node run_tests.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// 脚本位于 frontend/ 下，前端根目录就是脚本所在目录本身。
const root = here;

const targets = [
  'js/tests/api.test.js',
  'js/tests/drafts.test.js',
];

// Node 22.22 的 `node --test` 不接受目录参数（会被当模块路径解析），
// 也不接受多个显式文件路径（会被并成一个参数）。用 glob 模式最稳。
const child = spawn(process.execPath, ['--test', 'js/tests/*.test.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

child.on('close', (code) => {
  const header = [
    'M6 W2 前端测试真实执行日志',
    `生成时间: ${new Date().toISOString()}`,
    `Node: ${process.version}`,
    `平台: ${process.platform} ${process.arch}`,
    `命令: node --test "js/tests/*.test.js"`,
    `退出码: ${code}`,
    '='.repeat(72),
    '',
  ].join('\n');

  const footer = [
    '',
    '='.repeat(72),
    `日志结束，退出码 ${code}`,
  ].join('\n');

  const full = header + out + footer;
  const target = path.join(here, 'test-output.log');
  writeFileSync(target, full, 'utf8');

  // 抽取汇总行，便于快速核对
  const summary = full.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms).*$/gm) ?? [];
  console.log(summary.join('\n'));
  console.log(`\n日志已写入: ${target}`);
  console.log(`退出码: ${code}`);
  process.exitCode = code;
});
