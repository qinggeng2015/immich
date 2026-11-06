# Immich Audio 发布

此仓库的独立发布入口为 **Immich Audio CI** 和 **Publish Immich Audio**。上游工作流保留在原仓库运行，fork 使用自己的检查、构建和发布链。

## 发布物

- `app.alextran.immich.audio` 独立包名的三种 split APK，可与原版同时安装。
- 沿用已有 Immich Audio 开发签名，发布前检查证书、ABI、版本码和文件摘要。
- `ghcr.io/qinggeng2015/immich-server:<audio-tag>`，包含服务端、Web、CLI 和插件。
- `ghcr.io/qinggeng2015/immich-machine-learning:<audio-tag>`，CPU 版本。
- 两种镜像均提供 `linux/amd64` 和 `linux/arm64`。
- GitHub Release 附件包含 SDK/CLI tgz、部署文件、OpenAPI、中文安装说明和校验清单。

部署文件使用独立的 `immich-audio` Compose 项目、容器名称和默认数据目录，默认暴露 `2285` 端口。数据库密码在安装时配置；模型 API key 仅保存在服务配置中。

## 必需配置

启用仓库 Actions，并在 Actions secrets 中配置 `AUDIO_ANDROID_KEYSTORE_BASE64`。其内容为现有签名 keystore 的 Base64 编码，不能提交到代码仓库。证书 SHA256 必须为：

```text
eb356e414b2f8e38b238b89b8a2ebb0b5d7ff56939f30e6b794408d9758284ed
```

GitHub 内置的 `GITHUB_TOKEN` 用于发布 Release 和本仓库的 GHCR 镜像。首次创建 GHCR 包后，应确认两个包的可见性为 Public，保证发布的 Compose 可以匿名拉取镜像。

## 发版步骤

1. 将源码提交并推送到 `main`，等待 **Immich Audio CI** 成功。
2. 在对应提交上创建新的小写 `audio-*` tag 并推送，例如 `audio-v3.4.0-rc.0-20261106.1`。
3. tag 推送会触发 **Publish Immich Audio**。也可以在 Actions 中选择该 tag 手动运行；不能从 `main` 直接运行发布。
4. 发布流程复用同一完整提交 SHA 的成功 CI；没有符合条件的检查时，会先运行检查。
5. 全部 APK、容器和包成功后，验证产物对应源码提交及校验值，再公开 GitHub 预发布。

默认 Android 基础版本码为 `3040000 + 发布工作流 run_number`，可以在手动运行时传入更高的 `build_number`。ARM64 split APK 的实际版本码在基础值上增加 `2000`，必须高于此前安装版本。不会生成低版本码的 universal APK。

已公开的 tag 不能重用；需要新版本时创建新 tag。失败的草稿发布可以重试，但目标提交和附件集合必须匹配。最终的 `release-manifest.json` 记录源码提交、两种镜像的 manifest digest、APK 身份和全部附件摘要。

## 检查范围

CI 覆盖服务端单元测试与 FFmpeg、数据库 medium 测试、Web 单元与浏览器检查、CPU ML 常规测试、API 生成文件、SQL、数据库迁移及格式检查。Android 仅执行代码生成、静态分析、打包和 APK 元数据检查；手机运行测试由使用者完成。
