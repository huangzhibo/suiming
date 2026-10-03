# Source

Source 忠实记录输入材料写了什么，不管 Target 打算怎么用它。它先保存材料及其故事结构，再由 Target Intent 决定改写、续写、重构或仅作参考；Source extraction 不读取 Target Intent，也不直接进入 Target Design。

## 文件形状

```text
source/<source-id>/
  source.yaml
  original.bin
  material.txt
  outline/
    story/index.yaml
    story/<volume-id>/<beat-id>.md
    contracts/<id>.md
  world/
    core.md
    <id>.md
    characters/<id>.md
    places/<id>.md
    resources/<id>.md
```

`source.yaml` 只保存无法从 artifact 本身推导的输入信息：

```yaml
schema_version: 1
name: 原作.txt
encoding: utf-8
```

`name` 是导入时的原始名称；`encoding` 只在原始输入具有文本编码时填写。内容 hash、审稿结论和工作流参数不写入该文件。

`original.bin` 原样保存输入字节。`material.txt` 是 importer 从原始输入得到的可读文本；纯文本通常只是确定性解码，PDF、EPUB、OCR 等输入可以经过格式提取。它仍属于材料而不是作品事实，不能加入 Target 取舍、创作解释或 Agent 指令。原始输入、可读材料和 extraction 分别版本化，修正 OCR 或解析结果会产生新版本。

## Extraction

Source 可以先只有 `source.yaml + original.bin + material.txt`，随后再建立 extraction。Extraction 一旦存在，就完整镜像 Target 的 `outline/** + world/**`，使用相同的 StoryBeat、Character、World、StoryContract 与硬状态语义，但不含 Intent、Reference、StoryText 或 Release。

Target 与每个 Source 各自形成 artifact namespace。同一 `beat-0001`、人物名或 World id 可以同时出现在多个 Source 和 Target 中；本地引用只在所属 namespace 内解析，不使用 `source-id/id` 污染 Story Language local id。

Source 可能只登记原作的一部分，也可能来自未完本作品，所以 `deadline: book_end` 的 Contract 可以在材料边界保持开放；具体规则见 outline 主题「StoryContract」。

Source 的结构检查只能证明 schema、引用、顺序、硬状态和 Contract 生命周期成立。是否遗漏材料、人物理解是否准确、抽取粒度是否足够以及自然语言是否忠实，仍由读取原始 `material.txt` 的语义 Review 判断。Target 任务默认不能读取 Source；只有明确的研究或转换任务才能在对应任务边界内使用它。

Source 的抽取就是 `source/<id>/**` 的提交，没有单独的冻结步骤。

## 笔记与覆盖率

读过哪些原文由笔记记录。每段原文读完留一份 `source/<id>/notes/<n>.md`：

```markdown
---
span: [0, 18000]
material_sha256: <当时 material.txt 的 sha256>
---
这段原文的交接。写什么由抽取任务决定，例如新出场的人物与设定、具体数值、谁在何时知道了什么、未解的问题、截在段界上的事件从哪接起。
```

`span` 是 `material.txt` 的码点区间，左闭右开；`material_sha256` 是写笔记时材料的 sha。覆盖率是 sha 等于当前材料的那些笔记的 span 并集，材料换了，旧笔记自然不再计入。Source 层审稿是 `review/<id>.md`（`scope: source:<id>`），要求笔记覆盖全文。

Source 的存在本身不赋予它 Target 指令权，也不会自动改变已有 Target Canon。
