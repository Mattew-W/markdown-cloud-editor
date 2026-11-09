import shutil, os

run = r'C:/m3w3revert'
if os.path.isdir(run):
    shutil.rmtree(run)
shutil.copytree(r'C:/m3w3/proj', run, ignore=shutil.ignore_patterns('target'))

# 回退 1：token.rs 的空白 sub 加固 -> 恢复 baseline 的 is_empty()
p1 = os.path.join(run, 'src', 'auth', 'token.rs')
s = open(p1, encoding='utf-8').read()
new = '''    // `sub` 承载用户 UUID，不允许为空串：空值会让"验签通过但查不到用户"。
    // 纯空白（空格 / 制表符 / 全角空格）与空串同属"查不到用户"，一并拒绝；
    // 只判空而不裁剪首尾，合法 id 原样返回，不做任何改写。
    // 最小校验，不做 UUID 格式解析（解析交给调用方，如 extractor.rs）。
    if data.claims.sub.trim().is_empty() {'''
old = '''    // `sub` 承载用户 UUID，不允许为空串：空值会让"验签通过但查不到用户"。
    // 最小校验，不做 UUID 格式解析（解析交给调用方，如 extractor.rs）。
    if data.claims.sub.is_empty() {'''
assert new in s, 'token.rs 空白 sub 块未找到'
s = s.replace(new, old)
open(p1, 'w', encoding='utf-8').write(s)
print('已回退 token.rs 空白 sub 加固')

# 回退 2：password.rs 去掉 ensure_verifiable 调用
p2 = os.path.join(run, 'src', 'auth', 'password.rs')
s = open(p2, encoding='utf-8').read()
new2 = '''
    // 参数闸：先从 PHC 串读 m / t / p 并检查上限，再交给 argon2。
    // 顺序很关键——argon2 内部按 m 申请内存，`m=4294967295` 会在申请 4.4 TB 时
    // 直接中止进程，那时已经来不及返回任何错误。
    ensure_verifiable(&parsed)?;'''
assert new2 in s, 'password.rs ensure_verifiable 调用未找到'
s = s.replace(new2, '')
open(p2, 'w', encoding='utf-8').write(s)
print('已回退 password.rs 参数闸')
