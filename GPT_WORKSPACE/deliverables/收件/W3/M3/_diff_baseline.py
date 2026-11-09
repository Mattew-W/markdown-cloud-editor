import difflib, hashlib, os

BASE = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/W3_完整任务包_20261101/M3_W3_完整包/baseline'
GOT  = r'D:/WORKbuddy1\RUST/GPT_WORKSPACE/deliverables/收件/W3/M3/extracted/M3_W3_姓名_20261104/源码'
MAIN = r'D:/WORKbuddy1/RUST'

def h(p):
    return hashlib.sha256(open(p,'rb').read()).hexdigest()[:16]

def diff(a, b, na, nb):
    x = open(a, encoding='utf-8', errors='replace').read().splitlines()
    y = open(b, encoding='utf-8', errors='replace').read().splitlines()
    d = list(difflib.unified_diff(x, y, na, nb, lineterm='', n=2))
    return d, len(x), len(y)

print('=' * 70)
print('一、auth/token.rs 与 auth/password.rs：三方比对')
print('=' * 70)
for rel in ['src/auth/token.rs', 'src/auth/password.rs']:
    b = os.path.join(BASE, rel)
    g = os.path.join(GOT, rel)
    m = os.path.join(MAIN, rel)
    print()
    print('--- %s ---' % rel)
    print('  baseline  %s  %6d B  %d 行' % (h(b), os.path.getsize(b), len(open(b,encoding='utf-8',errors='replace').read().splitlines())))
    print('  交件      %s  %6d B  %d 行' % (h(g), os.path.getsize(g), len(open(g,encoding='utf-8',errors='replace').read().splitlines())))
    if os.path.exists(m):
        print('  主项目    %s  %6d B  %d 行' % (h(m), os.path.getsize(m), len(open(m,encoding='utf-8',errors='replace').read().splitlines())))
    else:
        print('  主项目    (不存在)')

print()
print('=' * 70)
print('二、baseline  vs  交件：token.rs 完整差异')
print('=' * 70)
d, nl, nl2 = diff(os.path.join(BASE,'src/auth/token.rs'), os.path.join(GOT,'src/auth/token.rs'),
                  'baseline/src/auth/token.rs', '交件/src/auth/token.rs')
print(f'（baseline {nl} 行 → 交件 {nl2} 行，差异块 {len(d)} 行）')
for l in d:
    print(l)

print()
print('=' * 70)
print('三、baseline  vs  交件：password.rs 完整差异')
print('=' * 70)
d2, nl3, nl4 = diff(os.path.join(BASE,'src/auth/password.rs'), os.path.join(GOT,'src/auth/password.rs'),
                    'baseline/src/auth/password.rs', '交件/src/auth/password.rs')
print(f'（baseline {nl3} 行 → 交件 {nl4} 行，差异块 {len(d2)} 行）')
for l in d2:
    print(l)
