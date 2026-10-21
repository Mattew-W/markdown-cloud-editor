# Git 推送配置：SSH 通路（2026-10-21）

## 结论先说

**配置已全部做好，只剩一步需要你手动完成：在 GitHub 网页上添加 SSH 公钥。**

完成那一步后，`git push` / `git pull` 立即可用，无需再设任何环境变量。

---

## 一、为什么需要这一步（真实故障记录）

本机 `git push` / `git fetch` 全部失败，不是配置疏漏，是网络通路问题：

| 现象 | 根因 |
|---|---|
| `schannel: server closed abruptly (missing close_notify)` | git 的 HTTPS 经代理握手失败 |
| `CONNECT tunnel failed, response 502` | 本机必须走代理 `HTTP_PROXY=127.0.0.1:58915`（直连 443 会超时），但代理的 CONNECT 隧道对 git 的 HTTPS 返回 502 |
| 清空代理变量后 `Failed to connect to github.com port 443` | 证明直连不通，代理是必需的 |
| `http.version=HTTP/1.1`、`sslBackend=openssl`、查全局/系统级代理配置（均为空） | 全部无效 |
| `gh` CLI 走同一代理正常 | 差异在 HTTP 栈（Go 的实现能过 CONNECT），不在网络本身 |
| `gh auth refresh` → `Bad Gateway` | 设备码端点在 `github.com`（非 `api.github.com`），同样被代理挡 |

实测对照结论：

| 域名 | 结果 |
|---|---|
| `api.github.com` | **HTTP 200**（通） |
| `github.com`（网页/设备码端点） | **502**（被挡） |

**所以走 HTTPS 或网页自动化都不可行，必须换 SSH 通路。**

---

## 二、需要你做的一步（大约 40 秒）

1. 打开这个页面：<https://github.com/settings/ssh/new>
   （直接登录状态下；打不开就说明代理挡了 `github.com` 网页，需先在浏览器里开代理）
2. Title 填：`huang-windows-ed25519`
3. Key 粘贴下面这一整行（已复制好）：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBV/BI3clFJAHVYPTqEgeAQ8UQgMBg1+vqJPYHR4pOzD huang@windows
```

4. 点 **Add SSH key**

> 公钥原文也在 `C:\Users\huang\.ssh\id_ed25519.pub`，可随时打开复制。

---

## 三、做完之后这样验证

在 PowerShell 里执行：

```powershell
cd D:\WORKbuddy1\RUST
ssh -T git@github.com
```

成功时会看到（这是**正常**的，GitHub 就是这样回复的）：

```
Hi Mattew-W! You've successfully authenticated, but GitHub does not provide shell access.
```

然后正常推送：

```powershell
git fetch origin
git push origin <分支名>
```

---

## 四、这次一并修掉的两处配置缺陷

### 1. `C:\Users\huang\.ssh\config` 曾是一个**空目录**

早前某次操作误建成目录。**ssh 遇到 `config` 是目录时会静默忽略整个配置文件**——你改过配置也不会生效。现已删除，改为本文所述的正常配置文件。

### 2. `ssh-agent` 服务被禁用，且当前账户无管理员权限

服务状态 `Stopped / Disabled`，`Set-Service` 报「拒绝访问」。

**这不影响使用**：已写明 `IdentityFile` + `IdentitiesOnly yes`，ssh 直接读私钥文件，不经过 agent。若将来要启用 agent，需以管理员身份运行：

```powershell
Set-Service ssh-agent -StartupType Manual
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

---

## 五、已写入的配置内容

`C:\Users\huang\.ssh\config`：

```
Host github.com
    HostName github.com
    User git
    IdentityFile C:/Users/huang/.ssh/id_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

仓库 remote（已从 HTTPS 改为 SSH）：

```
git@github.com:Mattew-W/markdown-cloud-editor.git
```

---

## 六、当前状态与未提交内容

- 仓库远程已切 SSH 地址，**在公钥添加前无法推送**（会报 `Permission denied (publickey)`）。
- 本地 `codex/architecture` 分支有新提交待推：`57c073b`、`3863809`（M1 汇报表与 `.gitignore` 修正）。
- **注意历史约束**：本地 `codex/architecture` 与远程 `main` **无共同祖先**（`git merge-base` 返回空）。
  按 `GPT_WORKSPACE/GIT_WORKFLOW.md`，**禁止强推、禁止 `--allow-unrelated-histories`**。
  推代码时必须基于 `origin/main` 开新分支走 PR 流程。

---

## 七、备选方案（若你不想用 SSH）

目前仍然可用、已实测可靠的路径是 **`gh` CLI 走 API 层**（`api.github.com` 通）：

```powershell
gh api repos/<owner>/<repo>/git/blobs --method POST -f content=<base64> -f encoding=base64
gh api repos/<owner>/<repo>/git/trees  --method POST -f base_tree=<sha> ...
gh api repos/<owner>/<repo>/git/commits --method POST -f message=... -f tree=... -f parents[]=...
gh api repos/<owner>/<repo>/git/refs --method POST -f ref=refs/heads/<branch> -f sha=<commit>
```

2026-10-21 的 M1 汇报表就是用这条路传上去的（分支 `codex/m1-progress-report-20261021`，回读 SHA256 与本地一致）。
局限：需要手工构造 commit，无法执行 `git push` 的常规合并流程。