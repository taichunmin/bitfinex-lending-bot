# Issue tracker：本地 Markdown

這個 repo 的 issue 和 spec（spec 也就是俗稱的 PRD）都以 markdown 檔存放在 `.scratch/`。

## 慣例

- 一個功能一個目錄：`.scratch/<feature-slug>/`
- spec 檔為 `.scratch/<feature-slug>/spec.md`
- 實作 issue 一個 ticket 一個檔案，路徑為 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，從 `01` 開始編號 — 不要合併成單一檔案
- Triage 狀態記錄在每個 issue 檔案開頭附近的 `Status:` 行（角色字串見 `triage-labels.md`）
- 留言與討論記錄附加在檔案最下方的 `## Comments` 標題底下

## 當 skill 說「publish to the issue tracker」

在 `.scratch/<feature-slug>/` 底下建立新檔案（必要時一併建立目錄）。

## 當 skill 說「fetch the relevant ticket」

讀取所指路徑的檔案。使用者通常會直接給你路徑或 issue 編號。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一個檔案，每個 ticket 對應一個 **child** 檔案。

- **Map**：`.scratch/<effort>/map.md` — 內容為 Notes / Decisions-so-far / Fog。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，從 `01` 起編號，問題寫在內文。`Type:` 行記錄 ticket 類型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行記錄 `claimed`/`resolved`。
- **Blocking**：開頭附近的 `Blocked by: NN, NN` 行。當所列的每個檔案都是 `resolved` 時，該 ticket 才解除阻塞。
- **Frontier**：掃描 `.scratch/<effort>/issues/`，找出開啟中、未阻塞、未認領的檔案；編號最小者優先。
- **Claim**：開始任何工作前先設 `Status: claimed` 並存檔。
- **Resolve**：在 `## Answer` 標題底下附上答案，設 `Status: resolved`，然後把 context pointer（gist + 連結）附加到 `map.md` 的 Decisions-so-far。
