# SSH 连接

新增机器使用当前 WSL 或本机环境的 OpenSSH。输入用户与地址，设置机器名称；首次登录在 VS Code 集成终端中完成。主机指纹确认和密码读取由 OpenSSH 处理，插件读取完成报告。密码沿终端传入，配置、日志、MCP 和 Agent 均只处理连接身份及结果。

向导生成连接专用 Ed25519 密钥，存入该环境的 `~/.ssh/wayfarer`，目录0700、私钥0600；远端只在当前登录账号的 `authorized_keys` 追加公钥。随后用 BatchMode 验证该密钥及远端 Python 3，将独立 OpenSSH 配置、实际home和Python路径保存为命名端点。既有账号配置、其他密钥及公钥行保留。新连接按既有 Endpoint 通道按需建立，展开的目录沿已有监听更新。

支持 `user@host`、`user@host:port` 与 `user@[IPv6]:port`；远端为 Linux/POSIX，Python 3.6+。需要ProxyJump、特殊认证或现有别名时，从“导入已有SSH配置”沿用OpenSSH原配置。Windows Remote SSH 的原生工作区绑定继续独立于WSL的SSH配置。

取消关闭该次终端和报告查询；断连、认证失败或缺少Python会结束向导并显示实际阶段。已经写入的专用凭证留在上述明确目录，方便处理确认中断后的登录。成功报告消费后删除该次临时目录；插件空闲期间保持原有生命周期。

`tests/ssh_terminal_acceptance.py` 使用隔离的本机SSH服务器和真实OpenSSH/PTY验证首次密码、公钥安装、免密验证及密码回显；Paramiko仅为这项可选验收的依赖，生产助手使用Python标准库和系统OpenSSH。
