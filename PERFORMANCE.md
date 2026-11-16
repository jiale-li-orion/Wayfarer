# CPU 与内存 profiling

2026-11-16 实测。训练机使用 Node 22，Windows 验收使用 VS Code 1.146、Ubuntu WSL；推理机助手运行于 Python 3.6.8。样本和操作在临时目录中完成。

| 场景 | 调整前 | 调整后 | 修改 |
| --- | ---: | ---: | --- |
| 64 MiB 校验复制耗时 | 121.8 ms | 70.0 ms | 本机读写使用二进制缓冲 |
| 同一复制累计 CPU | 185.5 ms | 88.7 ms | 消除本机链路 Base64 往返 |
| 600 个小文件耗时 | 1,442.7 ms | 480.4 ms | 任务级缓冲复用、增量检查点 |
| 同一批小文件累计 CPU | 1,919.3 ms | 627.9 ms | 避免重写整份任务历史 |
| 同一批小文件峰值新增 RSS | 47.2 MiB | 4.6 MiB | 小文件 hash 缓冲按大小分配 |
| 1,011 节点、120 次缩放累计渲染 CPU | 2.607 s | 0.420 s | 远景 Canvas |
| 同一缩放帧间隔 p95 | 20.9 ms | 7.1 ms | 减少细小 DOM 节点和连线 |
| 同一缩放平均帧间隔 | 12.4 ms | 6.85 ms | 可见范围渲染与分级展示 |

64 MiB 场景包含内容校验，使用训练机已缓存的本地文件，作为运行时实现对比。后一次复制观测到的 RSS 增量为 0：进程复用了已有分配空间，传输仍使用固定缓冲。小文件样本为 600 × 128 字节，指标包括实际文件创建、摘要校验和任务记录。

Webview 在实际 Windows VS Code 中加载 1,000 个文件、5 个目录及分页节点。普通视角约 15–17 个节点进入 DOM；远景用 Canvas 绘制结构。缩放测量为前台窗口的合成滚轮序列，两轮使用相同操作次数。收起后测量用 GC 得到约 4.5–5 MiB 的 JS heap；该值仅表示 JS heap，窗口总内存还包括 Chromium、绘图缓冲和 Extension Host。后台挂起样本另行排除。

WSL、训练机、推理机助手完成端到端文件与包测试后，RSS 约 19、23、18 MiB；当时目录游标和包子进程均为 0。后续版本增加页面重读缓存与监听计数，可从 \`endpoint.resources\` 继续对照。

## 重测

\`\`\`sh
npm run bench
npx tsx scripts/benchmark-small.ts
\`\`\`

实际 Windows 验收：打开安装版 Workspace Map，使用独立 VS Code user-data-dir 和 CDP 端口，运行 \`scripts/profile-webview.mjs\`。脚本读取当前窗口会话，创建临时树，记录渲染 CPU、heap、DOM 和帧间隔，再清理临时文件。保持窗口可见；后台挂起会改变 rAF 调度。

\`scripts/acceptance.py\` 检查 Windows／WSL／SSH 传输与隔离 pip／npm 环境；\`scripts/verify-webview.mjs\` 检查手柄搬移、目录双击和历史导航。运行入口和路径使用当前验收环境，其他机器需调整测试参数。

原始记录保存在 \`docs/performance-data/\`；包中保留这份说明，原始数据保留在源码仓库。后续比较同时记录节点数、文件大小分布、连接带宽和窗口可见状态。
