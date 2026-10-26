# ext/ —— 三个 provider 扩展包（暂存副本）

**真源在 fork 仓库**：`C:/Users/Lenovo/Documents/qq-bridge-fork` 的 `ext/qq-ext-{house-lite,page-note,workspace}`。
这个目录是打包前的暂存副本（`tools/make-kit.mjs` 从 fork 的 `ext/` 取文件），改包请改 fork 那边，
改完同步回这里再打包，否则分发包里的 ext 与仓库里的不一致 —— 而 `check-kit` 只校验分发包内部自洽，不会替你发现这个漂移。

| 包 | 工具 | 上限 |
| --- | --- | --- |
| qq-ext-house-lite | 8（qq_house_*） | 单 provider 上限正好 8，再加就得拆包 |
| qq-ext-page-note | 6（qq_page_* / qq_note_*） | |
| qq-ext-workspace | 3（qq_read_file / qq_list_files / qq_search_files） | |

合计 17 个工具在桥外，桥侧仍是 25 个，一起构成工具清单里的 42 个。
安装方式、cordis insert 片段、外壳/body 设计理由见 fork 仓库的 `ext/README.md`。
