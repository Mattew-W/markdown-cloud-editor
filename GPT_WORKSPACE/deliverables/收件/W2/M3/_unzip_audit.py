import zipfile, os, shutil, hashlib

src = r'C:/Users/huang/xwechat_files/wxid_pynqyzmdsk9412_2dbf/msg/file/2026-10/M3-W2.zip'
dst = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/收件/W2/M3/extracted'
if os.path.isdir(dst):
    shutil.rmtree(dst)
os.makedirs(dst, exist_ok=True)

def fix(name):
    if all(ord(c) < 128 for c in name):
        return name
    try:
        return name.encode('cp437').decode('gbk')
    except Exception:
        return name

z = zipfile.ZipFile(src)
infos = z.infolist()
total = sum(i.file_size for i in infos)

# 分类统计
core, cargo_out, other = [], [], []
for i in infos:
    n = fix(i.filename)
    if '/target/' in n or n.endswith('/target/') or '/target' in n:
        cargo_out.append((i.file_size, n))
    elif i.file_size == 0 and n.endswith('/'):
        other.append((0, n))
    else:
        core.append((i.file_size, n))

print('=== 总计 ===')
print('条目数:', len(infos), ' 解压总字节: %.2f MB' % (total/1048576))
print('核心文件条目:', len(core), ' target 内条目:', len(cargo_out))
print()
print('=== 核心文件（排除 target/）===')
for s, n in core:
    print('%10d  %s' % (s, n))
print()
print('=== 空目录条目 ===')
for s, n in other:
    print('           ', n)

# 解压：核心部分完整解压，target 部分跳过
skip = set()
for i in infos:
    n = fix(i.filename)
    if '/target/' in n or '/target' in n:
        skip.add(i.filename)
for i in infos:
    n = fix(i.filename)
    if i.filename in skip:
        continue
    i.filename = n
    z.extract(i, dst)
z.close()
print()
print('EXTRACTED_TO', dst)

print()
print('=== 核心文件 SHA256 ===')
for root, dirs, files in os.walk(dst):
    for f in sorted(files):
        p = os.path.join(root, f)
        h = hashlib.sha256(open(p,'rb').read()).hexdigest()
        print(h, os.path.relpath(p, dst).replace('\\','/'))
