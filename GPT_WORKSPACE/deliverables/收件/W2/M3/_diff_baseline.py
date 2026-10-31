import difflib, hashlib, io, os

ref = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/W2_逐人发送包_20261025/M3_W2/materials/M3/token.rs'
refc = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/W2_逐人发送包_20261025/M3_W2/materials/M3/Cargo.reference.toml'
got = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/收件/W2/M3/extracted/M3-W2/jwt_review/src/token.rs'
gotc = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/收件/W2/M3/extracted/M3-W2/jwt_review/Cargo.toml'

for p in (ref, got):
    print(os.path.basename(p), hashlib.sha256(open(p,'rb').read()).hexdigest()[:16], os.path.getsize(p), 'bytes')
print()

a = open(ref, encoding='utf-8').read().splitlines()
b = open(got, encoding='utf-8').read().splitlines()
print('=== token.rs diff (基线 -> 交件) ===')
n = 0
for line in difflib.unified_diff(a, b, 'materials/token.rs', '交件/token.rs', lineterm='', n=2):
    print(line)
    n += 1
print('--- diff 行数:', n, ' 基线行数:', len(a), ' 交件行数:', len(b))
print()
print('=== Cargo.toml: 参考 vs 交件 ===')
ra = open(refc, encoding='utf-8').read().splitlines()
rb = open(gotc, encoding='utf-8').read().splitlines()
for line in difflib.unified_diff(ra, rb, 'Cargo.reference.toml', '交件/Cargo.toml', lineterm='', n=1):
    print(line)
