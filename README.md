# fortify-deob

code.fortify level-3 加固的 Cocos Creator / 微信小游戏 `game.js` 通用反编译工具。

在真实样本（Cocos Creator 3.8.x + 微信小游戏，1.9MB 的 `assets/start-scene/index.js`
业务包，code.fortify level-3）上验证：117 个业务模块全部还原，
类名 / 方法名 / 属性名 / 中文字符串 / 数值常量 / 模块导入名 100% 可读。

## 安装

```bash
npm install        # 仅依赖 @babel/* 系列；也可直接复制 node_modules 离线使用
```

## 用法

```bash
# 基本用法
node src/cli.js <解包后的 game.js> -o <输出目录>

# 全局命令（可选）
npm link           # 之后可直接用 fortify-deob game.js -o out

# 可选参数：
#   --target assets/start-scene/index.js   指定目标 define 模块（默认自动挑最大业务包）
#   --no-raw                               不输出原始 factory
```

示例：

```bash
node src/cli.js /path/to/wx_unpacked/game.js -o ./out
```

## 输出

- `readable/*.js`：反混淆后的模块（按原始 TS 模块名命名）
- `raw/*.js`：VM 执行时捕获的原始 System.register factory，可与 readable 对照
- `tables/to.json`：字符串表运行时真值（权威；静态解码仅作无 VM 时兜底）
- `tables/ro_entries.json`：数值常量表
- `tables/outer_constants.json`：混淆体外层单字母常量的运行时值（数百个）
- `manifest.json`：模块名 / 文件名 / deps / scriptId / 类名
- `MODULE_INDEX.md`：人类可读模块索引

## code.fortify level-3 混淆原理

1. 业务代码被打进一个 AMD `define("assets/.../index.js", function(require,module,exports){...})`，
   内部用 Babel 编译的 `System.register(name, deps, factory)` 注册全部 TS 模块。
2. 字符串表 `to[47]`：字符串整体反转 + 分块反转编码，运行时挂到 `String.prototype.s` 解码；
   所有类名、方法名、属性名、中文文案都以 `to[k][j]` 间接引用。
3. 数值表 `ro[274]`：base85 风格编码串在运行时解码，数字以 `ro[k]` 引用。
4. 外层数百个单字母常量别名（`St="y"`）、不透明谓词（`Fu(51.25)>=...`）、
   解码器数组的运行时交换乱序（`Tc(b,1,5)`）。
5. `System[T]` 之类 API 名间接化。

## 处理流水线

| 阶段 | 文件 | 作用 |
|---|---|---|
| 1 | `src/parseDefines.js` | 行首 `define(` 定位起点，对每个行首 `});` 候选做函数体语法校验，精确切出目标 define |
| 2 | `src/tables.js` | 正则静态解码字符串表（兜底用） |
| 3 | `src/vm.js` | Node VM 执行混淆体，hook `System.register` 收集模块；末尾回采运行时 `to`/`ro` 表与外层常量 |
| 4 | `src/deob.js` | 多轮 Babel 变换：字面量还原、常量传播、死变量消除、导入绑定作用域精确定位并语义改名 |
| 5 | `src/cli.js` | 串联流水线、落盘 manifest / 索引 |

关键坑（适配其他游戏时大概率会遇到）：

- **define 切分**：不能用括号配平（正则字面量 `/{...}/` 干扰，会吞掉 MD5 模块）；
  也不能直接 parse 整个 game.js（压缩引擎 chunk 含非法语法，babel 解析失败）。
  现行方案对每个 `});` 候选做一次函数体语法校验，第一个通过的就是真正结束点。
- **VM 沙箱**：不能注入宿主内建对象（String 原型不共享会导致 `String.prototype.s`
  解码失效）；只注入 require/System/define/wx stub/timers，让上下文自建内建。
- **导入改名**：混淆器在方法内部高频复用单字母名，必须沿 setter 赋值路径用
  `scope.getBinding` 向外查真正的外层导入绑定，否则会误改局部变量。

## 适配其他游戏的检查点

- 目标 define 自动挑选条件：含 `String.prototype.s=` 解码函数 或 `System.register`，
  挑中失败时用 `--target` 显式指定。
- 字符串/数值表变量名自动识别（`new Array(n)` 与 base85 解码函数特征），
  非典型编码需改 `src/tables.js`；运行时表不依赖静态解码，通常无需改动。
- VM 执行若在收集模块前抛错，多为 `wx` API 或 babel runtime helper 缺失，
  在 `src/vm.js` 的 `wxStub()` / `helpers` / `customRequire` 里补 noop 即可。
- 不认识的引擎 require 路径在 `customRequire` 里按子串映射到 helper。

## 已知限制

- 输出是 Babel loose 编译形态（`function(t){...}` + `inheritsLoose`），不是原生 class 语法，
  但逻辑、命名与原始 TS 一一对应，可直接照着重写 TS。
- 不透明谓词与解码器数组乱序（`Ms && Tc(...)`、`Fu(...)>=...`）保留未删，均为死分支，不影响阅读。
- 方法内部的局部单字母变量名保留；导入名、属性名、字符串已全部还原。
- 关卡配置类模块含运行时数组乱序，直接读源码看到的是排序过程，
  需要真值时在 VM 中执行对应 factory 取结果。

## 项目结构

```
src/
  cli.js           命令行入口与输出组织
  parseDefines.js  AMD define 精确切分
  tables.js        字符串表静态解码（兜底）
  vm.js            沙箱执行、System.register hook、运行时表回采
  deob.js          Babel 反混淆变换
```
