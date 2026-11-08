# 参与 EnyAgentDesk

EnyAgentDesk 还是早期项目。这个仓库是**公开发布快照**，开发在私有上游仓库的 `main` 和 `develop` 分支进行；这里的 `main` 只接收导出脚本生成的脱敏快照，保留连续的公开历史。

## 如何反馈

- 问题和建议走 [Issue](https://github.com/ShengrenHOU/EnyAgentDesk/issues)。请先搜索是否已有同样的问题。
- 代码 PR 不会被直接合并。等价改动会在上游仓库实现、验证，再随下一次发布进入这里。
- 安全问题不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 的说明私下联系。

## 发布方式

- 每次发布以上一个公开快照为父提交，私有历史不进入公开仓库，提交信息带 `Upstream-Commit: <上游提交>` 尾注；`main` 由镜像写入，不在这里手工改历史。
- 标签使用 `vX.Y.Z`，对应 `package.json` 的版本；`0.x` 版本在 GitHub Release 中标记为 pre-release。
- 公开文档、许可证和 Issue/PR 模板由本仓库维护；源码、测试、脚本、提示词和配置从上一次导出的上游状态同步。
- 导出前会扫描密钥、私有路径、公司邮箱、飞书标识和内部文件；扫描不通过就不发布。

## 本地检查

维护者或需要复现问题时：

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次运行类型检查、全部测试和构建。Windows 上可以用 `pnpm check:native` 跑原生子集；两种结果分开报告。

## 许可证

本仓库以 Apache-2.0 发布。上游代码保留 MIT 许可证，版权归 DeepSeek Harness Team；原 MIT 文本在 [LICENSES/MIT.txt](LICENSES/MIT.txt)，完整来源说明见 [NOTICE](NOTICE)。
