import zipfile, os, shutil, hashlib

src = r'D:/wechat_4/xwechat_files/wxid_pynqyzmdsk9412_2dbf/msg/file/2026-11/M3_W3_姓名_20261104.zip'
dst = r'D:/WORKbuddy1/RUST/GPT_WORKSPACE/deliverables/收件/W3/M3/extracted'
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
print('=== 总计 ===')
print('条目数:', len(infos), ' 解压总字节: %.2f MB' % (total/1048576))

core, heavy = [], []
for i in infos:
    n = fix(i.filename)
    (heavy if ('/target/' in n or '/node_modules/' in n or '/.git/' in n
               or n.endswith('/target/') or n.endswith('/node_modules/')) else core).append((i.file_size, n))

print('核心条目:', len(core), ' 构建产物条目:', len(heavy))
print()
print('=== 核心文件（排除 target/node_modules/.git）===')
for s, n in core:
    print('%10d  %s' % (s, n))

for i in infos:
    n = fix(i.filename)
    if any(k in n for k in ('/target/', '/node_modules/', '/.git/')):
        continue
    i.filename = n
    z.extract(i, dst)
z.close()
print()
print('EXTRACTED_TO', dst)
