import shutil, os

MAIN = r'D:/WORKbuddy1/RUST'
GOT  = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/收件/W3/M3/extracted/M3_W3_姓名_20261104/源码'
run  = r'C:/m3w3merge'
if os.path.isdir(run):
    shutil.rmtree(run)
shutil.copytree(MAIN, run, ignore=shutil.ignore_patterns(
    'target', '.git', 'Temp', 'GPT_WORKSPACE', 'gemini-3.8-flash-version'))

# 把 M3 W3 的两个文件覆盖到副本
for rel in ['src/auth/token.rs', 'src/auth/password.rs']:
    shutil.copy2(os.path.join(GOT, rel), os.path.join(run, rel))
    print('已覆盖副本:', rel)

# 同时核对：主项目当前版本 vs W3 baseline 是否一致（说明 W2 修复是否已在主项目）
import hashlib
def h(p):
    return hashlib.sha256(open(p,'rb').read()).hexdigest()[:16]
BASE = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/W3_完整任务包_20261101/M3_W3_完整包/baseline'
print()
print('--- 主项目 vs W3 baseline ---')
for rel in ['src/auth/token.rs', 'src/auth/password.rs']:
    a = h(os.path.join(MAIN, rel)); b = h(os.path.join(BASE, rel))
    print('  %-24s 主项目=%s baseline=%s  %s' % (rel, a, b, '一致' if a == b else '不同'))
