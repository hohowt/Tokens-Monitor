# AI Token Monitor - 构建与打包指南

## 快速开始

### 环境要求

```bash
# Node.js 18+
node --version    # v18.0.0 或更高

# npm 9+
npm --version     # 9.0.0 或更高

# VSCode 扩展打包工具（自动安装）
npx vsce --version
```

### 编译代码

```bash
npm run compile      # 编译 TypeScript → out/
npm run watch        # 监视模式，自动重新编译
```

### 运行测试

```bash
npm test             # 运行所有单元测试
npm test:watch       # 测试监视模式
npm test -- --coverage  # 生成覆盖率报告（可选）
```

## 打包扩展

### 方式 1: 使用 npm 脚本（推荐）

```bash
# 打包所有平台
npm run package      # 等同于 npm run package:win

# 打包特定平台
npm run package:win      # Windows x64
npm run package:mac      # macOS Intel (x64)
npm run package:mac-arm  # macOS Apple Silicon (arm64)
npm run package:linux    # Linux x64

# 说明
# package:mac / package:mac-arm / package:linux 会先检查对应平台的 ai-monitor 客户端二进制。
# 若仓库中不存在这些目标文件，脚本会先调用 ../client/build.ps1 交叉编译对应客户端。
# 若客户端仍无法编译，脚本会直接失败，而不会继续产出不可运行的 VSIX。
```

### 方式 2: 使用 Bash 脚本

```bash
# 打包所有平台
bash scripts/package-all.sh all

# 打包特定平台
bash scripts/package-all.sh win
bash scripts/package-all.sh mac
bash scripts/package-all.sh linux
```

### 方式 3: 使用 PowerShell 脚本（Windows）

```powershell
# 打包所有平台
.\build.ps1

# 打包特定平台
.\build.ps1 -Platform win
.\build.ps1 -Platform mac
```

## 打包输出位置

所有生成的 `.vsix` 文件都在 `dist/` 目录下：

```
dist/
├── ai-token-monitor-win32-x64.vsix      # Windows
├── ai-token-monitor-darwin-x64.vsix     # macOS Intel
├── ai-token-monitor-darwin-arm64.vsix   # macOS ARM
└── ai-token-monitor-linux-x64.vsix      # Linux
```

## 发布到 VSCode 市场

### 1. 获取个人访问令牌 (PAT)

访问 https://dev.azure.com/ 创建个人访问令牌（权限：Marketplace > Publish）

### 2. 创建发行者账号

```bash
npx vsce create-publisher <publisher-name>
```

### 3. 登录发行者账号

```bash
npx vsce login <publisher-name>
# 输入上面创建的 PAT
```

### 4. 发布扩展

```bash
# 发布单个平台
npx vsce publish --packagePath dist/ai-token-monitor-win32-x64.vsix

# 发布所有平台（自动增加版本号）
npx vsce publish --packagePath dist/ai-token-monitor-*.vsix
```

### 5. 更新版本号

在 `package.json` 中更新 `version` 字段，然后重新打包和发布。

## GitHub Actions CI/CD

项目已配置自动化 CI/CD 流程 (`.github/workflows/build.yml`)：

### 自动触发条件

1. **推送到 main/develop 分支** → 运行测试
2. **创建 Git 标签** (如 `v1.0.0`) → 编译、测试、打包、自动填充 Release

### 手动触发发布

```bash
# 1. 更新版本号
vim package.json  # 修改 version 字段

# 2. 创建 Git 标签
git tag v1.0.0
git push origin v1.0.0

# 3. GitHub Actions 自动构建和发布
# 检查 GitHub Actions 页面的进度
```

## 常见问题

### 1. npm run package 失败

**情况**: `npx vsce package` 无法找到可执行文件

**解决**:
```bash
npm install  # 重新安装依赖
npm run compile  # 重新编译
npm run package  # 重试
```

### 2. Go 代码编译失败

**情况**: 旧版本的 `build.ps1` 尝试编译 Go 代码

**解决**: Go 代码已被移除。使用最新的 `build.ps1` (已修复)

### 3. 测试失败

**情况**: `npm test` 返回非零退出码

**解决**:
```bash
# 检查错误信息
npm test 2>&1 | tail -30

# 修复代码后重试
npm run compile
npm test
```

### 4. 打包生成的 .vsix 太大

**情况**: `.vsix` 文件 > 10 MB

**检查**:
```bash
# 查看打包内容
unzip -l dist/ai-token-monitor-*.vsix | head -30

# 通常是因为 node_modules 被打包了
# 解决: 检查 .vscodeignore 文件配置
```

## 文件结构

```
vscode-extension/
├── src/
│   ├── **/*.ts          # TypeScript 源代码
│   └── __tests__/       # Jest 单元测试
├── out/                 # 编译输出（自动生成）
├── dist/                # .vsix 打包输出（自动生成）
├── bin/                 # 二进制文件（如有代理，此目录已移除）
│
├── package.json         # 项目配置 + npm 脚本
├── tsconfig.json        # TypeScript 配置
├── jest.config.js       # Jest 测试框架配置
│
├── .vscodeignore        # VSCode 打包忽略列表
├── build.ps1            # PowerShell 构建脚本 (简化版)
├── scripts/
│   ├── package-all.sh   # Bash 打包脚本
│   └── ...
│
└── .github/
    └── workflows/
        └── build.yml    # GitHub Actions CI/CD 工作流
```

## 性能提示

### 加快编译速度

```bash
# 增量编译（只编译改动的文件）
npm run watch

# 编译时跳过类型检查（快速反馈）
tsc --noEmit false
```

### 加快测试速度

```bash
# 只运行特定测试文件
npm test -- src/__tests__/eventBus.test.ts

# 只运行匹配的测试用例
npm test -- --testNamePattern="should emit"
```

## 更多信息

- [VSCode Extension API](https://code.visualstudio.com/api)
- [vsce 文档](https://github.com/Microsoft/vscode-vsce)
- [Jest 文档](https://jestjs.io/)
- [TypeScript 文档](https://www.typescriptlang.org/)
