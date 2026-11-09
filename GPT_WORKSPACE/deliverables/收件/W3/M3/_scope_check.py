import os, hashlib

BASE = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/W3_完整任务包_20261101/M3_W3_完整包/baseline'
GOT  = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/收件/W3/M3/extracted/M3_W3_姓名_20261104/源码'

def walk(root):
    out = {}
    for r, ds, fs in os.walk(root):
        for f in fs:
            p = os.path.join(r, f)
            rel = os.path.relpath(p, root).replace('\\', '/')
            out[rel] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    return out

b = walk(BASE)
g = walk(GOT)

added    = sorted(set(g) - set(b))
removed  = sorted(set(b) - set(g))
modified = sorted(k for k in set(b) & set(g) if b[k] != g[k])
same     = sorted(k for k in set(b) & set(g) if b[k] == g[k])

print('=== 交件相对 baseline 的整体差异 ===')
print('  baseline 文件数: %d' % len(b))
print('  交件文件数:     %d' % len(g))
print()
print('--- 新增文件 (%d) ---' % len(added))
for k in added:
    print('   +', k)
print('--- 删除文件 (%d) ---' % len(removed))
for k in removed:
    print('   -', k)
print('--- 内容修改 (%d) ---' % len(modified))
for k in modified:
    print('   M', k)
print('--- 完全一致 (%d) ---' % len(same))
for k in same:
    print('   =', k)
