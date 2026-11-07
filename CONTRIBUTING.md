# 参与开发

这个项目还是早期阶段。提交前先开 Issue 讨论方向，尤其是会改变工单语义、授权模型、执行器合同或配置格式的改动。

## 环境与检查

需要 Node.js 22.19+ 或 24+、pnpm 以及 git。

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次运行类型检查、全部测试和构建。Windows 上可以用 `pnpm check:native` 跑原生子集；完整测试在 Linux/WSL 上覆盖得更全。两种结果分开报告。

Linux CI 运行完整 `pnpm check`。Windows CI 运行 `pnpm check:native`、启动器测试和原生工作台首次配置测试。依赖安装禁用 lifecycle scripts。新增失败必须解释并修复，不能通过删除测试、放宽预算或增加超时掩盖。

## 改动的范围

- 一个 PR 解决一件事。把重构、格式化、依赖升级和功能改动分开。
- 修改前先读 [开发与维护原则](docs/010-development-principles.md) 和相关的编号文档。
- 新增行为要有对应的回归测试，尤其是重复事件、中断、重试、停止和升级后续接。
- 新的来源、执行器或配置项，先说明现有接口为什么不够，再改代码。
- 不提交 `node_modules/`、`lib/`、`.artifacts/`、日志、状态目录或任何密钥。

## 提交与 PR

- 提交信息写清做了什么，使用现在时祈使句，例如 `Fix ticket retry after restart`。
- PR 描述包含：问题、最终行为、实际运行的检查和未验证的部分。
- 涉及界面的改动附截图或一段可复现步骤，截图要脱敏。
- 安全问题不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 处理。

## 许可证

提交即表示你同意以 Apache-2.0 许可证贡献这些改动。上游代码仍使用 MIT 许可证，版权归 DeepSeek Harness Team；来源说明见 [NOTICE](NOTICE)。
