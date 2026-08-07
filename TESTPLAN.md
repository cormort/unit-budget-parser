# 大量測試計畫與檢驗規格

給 `hermes`（或任何冷啟動的外包 agent）執行的批次測試規格。目的**不是**證明工具是對的，
而是**用最多的真實版面把破口逼出來**，並讓每個破口都變成可重現、可排序、可直接修的案例。

適用專案：

| 專案 | 路徑 | 對象 |
|---|---|---|
| 中央單位預算 | `~/Dev/Work/unit-budget-parser` | 各部會「歲出計畫提要及分支計畫概況表」 |
| 地方單位預算 | `~/Dev/Work/local-budget-parser` | 各縣市「歲出計畫說明提要與各項費用明細表」 |

---

## 〇、最重要的一條原則

**判定由程式做，不由 agent 做。**

`audit.mjs` 的退出碼與 JSON 就是唯一的判定結果。agent 的職責只有三項：
**找檔案、跑指令、把結果整理回報**。agent 不得：

- 自行判斷「這個數字看起來對／不對」——它沒有 ground truth，會編。
- 修改 `index.html`、`test.mjs`、`audit.mjs` 或任何解析規則。
- 為了讓測試通過而調整門檻或跳過檔案。

理由：本專案已經有過三次「先下結論再驗證，結論是錯的」的紀錄（詳見兩個 repo 的 README）。
人都會這樣，LLM 更會。所以把判定權從自然語言裡拿掉。

---

## 一、取樣計畫

### 1.1 目標覆蓋面

破口來自**版面差異**，不是資料量。取樣要沿著「會讓版面不同」的維度鋪開：

| 維度 | 為什麼會造成差異 | 目標 |
|---|---|---|
| **機關** | 各機關自行排版，欄寬、表名、折行位置都不同 | 中央 ≥15 部會；地方 ≥15 縣市 |
| **年度** | 換年度常換排版軟體或範本 | 每個機關至少 2 個年度（如 114、115） |
| **機關層級** | 主管單位預算（含所屬機關）比單一機關複雜得多 | 至少 5 份「主管」層級（如各縣市社會局、教育局） |
| **文件性質** | 決算書的欄位是「預算數／決算數」，與預算書不同 | 至少 3 份決算 |
| **字型／產生器** | 部分縣市 pdf.js 讀不出內文，需退回 PDFium | 已知高雄、新北屬此類，再找 3 份以上 |
| **檔案規模** | 大檔會暴露效能與跨頁狀態問題 | 至少 3 份 >300 頁 |

**優先序**：機關 > 機關層級 > 年度 > 文件性質。同一機關同一年度的重複檔案沒有價值。

### 1.2 已內建、不必重找

`unit-budget-parser/examples/`（5 份：主計總處、教育部、農業部、交通部、衛福部 115）、
`local-budget-parser/examples/`（7 份：北市主計處／社會局／新工處、中市、高市、新北主計處／社會局）。
這 12 份是回歸基準，**新測試不要覆蓋它們**。

### 1.3 取得方式

各機關預算書多為公開 PDF。建議來源：

- 中央：行政院主計總處「中央政府總預算」專區、各部會網站「預算及決算」頁
- 地方：各縣市政府主計處網站「預算書」「決算書」專區
- 立法院／各級議會的預算審查附件

**下載規範**：

- 存放於 `~/Dev/Work/_budget-corpus/<central|local>/<機關代碼>-<年度>.pdf`，**不要放進 repo**
  （兩個 repo 的 `examples/` 是版控中的回歸基準，混入會拖垮 clone）
- 單檔 >80MB 或總量 >5GB 就停下來回報，不要無限下載
- 只抓 PDF，不抓 zip／doc；抓不到就記下來，不要換成別的年度硬湊數量
- 逐檔記錄來源 URL 與下載時間，寫進 `corpus.jsonl`（見 §4.3）

---

## 二、執行方式

### 2.1 環境確認（每次批次開始前跑一次）

```bash
cd ~/Dev/Work/unit-budget-parser && npm install --silent && node test.mjs
cd ~/Dev/Work/local-budget-parser && npm install --silent && node test.mjs
```

兩者都必須輸出「全部通過」。**沒過就停止，回報並結束**——基準都壞了，大量測試的結果沒有意義。

### 2.2 批次稽核

```bash
node audit.mjs <pdf 或目錄>... --out report.json
```

- 可傳多個檔案或目錄；目錄會自動展開其下的 `*.pdf`（不遞迴）
- `--jsonl` 改為逐筆輸出 JSON 行，適合邊跑邊收
- 人看的摘要走 stderr，機器讀的 JSON 走 stdout 或 `--out`
- **退出碼**：有任何 blocker → `1`；只有 warning 或全過 → `0`

單檔約需 3～30 秒（視頁數）。建議**每 20～30 份一批**，每批獨立 `--out`，避免一次跑太久失去中間結果。

### 2.3 逾時與當機

單檔超過 **300 秒**視為逾時：中止該檔，記為 `blocker: timeout`，繼續下一份。
`audit.mjs` 內部已用 try/catch 把例外收成 `blocker: exception`，不會讓整批中斷。

---

## 三、檢驗規格

### 3.1 blocker（違反即為 bug，無需 ground truth）

這些檢查的共同點是**自證式**：不必知道正確答案，只要內部矛盾就一定有錯。

| # | 檢查 | 判定 | 為什麼是自證的 |
|---|---|---|---|
| B1 | `parse` | 解析不出任何資料列 | 若確認該檔是單位預算，讀不到就是版面未支援 |
| B2 | `fourLayer` | 上下層加總不符（明細→科目→分支→工作計畫） | 預算書的層級本來就是加總關係，不符必有一側讀錯 |
| B3 | `planBudgetConsistent` | 同一 `planCode` 出現兩種 `planBudget` | 同一個計畫不可能有兩個預算數，必是解析狀態沒收斂 |
| B4 | `fieldShape` | 代碼格式非法／名稱為空／名稱混入表格內文／金額非數值或為負／總經費列未標 `excluded` | 形狀違反即為抽取越界 |
| B5 | `crossCheck` | 工作計畫的名稱或本年度預算數與**歲出機關別預算表**不符 | 同一本書的兩張表必須一致 |
| B6 | `exception` | 解析過程丟例外 | — |

**B5 的名稱比對是不對稱的**（細節見兩個 repo 的 README）：機關別表名稱 ⊂ 本表名稱屬欄寬截斷、正常；
本表名稱 ⊂ 機關別表名稱代表本表漏字、要報。

### 3.2 warning（需人工判讀，不阻擋）

| # | 檢查 | 意義 |
|---|---|---|
| W1 | `crossCheck`（不可用） | 這份 PDF 沒有歲出機關別預算表，工作計畫的金額**沒有外部依據** |
| W2 | `crossCheckUnmatched` | 部分計畫在機關別表找不到對應編號，金額未經核對 |
| W3 | `agencyAmountUnextracted` / `agencyNameUnextracted` | 機關別表的金額或名稱欄抽不到文字 |
| W4 | `orphanRate`（中央）> 0.40 | 未歸戶句比例偏高 |
| W5 | `descCoverage`（中央）< 0.05 | 二級科目幾乎都沒有說明，可能整段沒讀到 |
| W6 | `detailPerL2`（地方）< 0.5 | 明細列相對二級科目偏少，可能整層沒讀到 |

**W2、W3 要特別當心**：專案曾把「對不到」解釋成「資料本來就沒有」，事後證明是自己的 regex 太窄。
**凡是「對不到／抽不到」，一律先假設是本工具的抽取問題。**

### 3.3 門檻的來源

`WARN` 的數值取自現有實測的最差值再放寬（如中央孤兒句最高為教育部 34%，門檻設 40%）。
**agent 不得調整門檻**。若某份 PDF 的指標超標但人工確認屬資料本身限制，記進報告的
`falsePositives`，由我判斷是否放寬。

---

## 四、結果規格

### 4.1 單檔記錄（`records[]` 的一筆）

```json
{
  "file": "/Users/…/_budget-corpus/central/moi-115.pdf",
  "tool": "unit-budget-parser",
  "toolVersion": "43b53bb",
  "engine": "pdf.js",
  "pages": 512,
  "agency": "內政部",
  "ok": false,
  "counts": { "rows": 960, "plans": 12, "branches": 41, "l2": 619, "l2WithDesc": 501, "orphans": 125, "agencyTablePages": 14 },
  "crossCheck": { "available": true, "checked": 12, "total": 12, "unmatched": 0 },
  "quality": { "orphanRate": 0.13, "descCoverage": 0.81, "nameUnextracted": 0, "amountUnextracted": 0 },
  "blockers": [ { "check": "crossCheck", "count": 2, "sample": [ … ] } ],
  "warnings": [],
  "durationMs": 18342
}
```

### 4.2 批次摘要（`summary`）

```json
{
  "generatedAt": "2026-08-06T…",
  "tool": "unit-budget-parser",
  "toolVersion": "43b53bb",
  "total": 30, "passed": 24, "warned": 4, "failed": 2,
  "blockerByCheck": { "crossCheck": 2 },
  "warnByCheck": { "crossCheckUnmatched": 4 }
}
```

### 4.3 語料索引（`corpus.jsonl`，agent 自行維護）

每下載一份寫一行，讓失敗案例可以被重新取得：

```json
{"file":"central/moi-115.pdf","agency":"內政部","year":115,"kind":"預算","level":"單一機關","sourceUrl":"https://…","sha256":"…","bytes":41234567,"fetchedAt":"2026-08-06T…"}
```

### 4.4 最終回報（agent 交還給我的東西）

一份 Markdown，**不超過兩頁**，內容固定四段：

1. **覆蓋度**：實際測了幾份、涵蓋哪些機關／年度／層級，對照 §1.1 還缺哪一格。
2. **blocker 清單**，依「影響的檔案數」由多到少排序。每一項必須有：
   - 檢查代號、影響檔案數、代表檔案的**絕對路徑**
   - 最小重現指令（可直接貼進終端機執行的那一行）
   - 該檔在 PDF 中的頁碼（若 `sample` 裡有）
3. **warning 統計**：只給計數與分布，不要逐筆列。
4. **無法完成的部分**：抓不到的機關、逾時的檔案、環境問題——**照實寫，不要補洞**。

報告本身不做原因推測。「為什麼會這樣」由我看程式決定；agent 寫推測只會誤導排查方向。

---

## 五、分流規範（agent 遇到 blocker 時做什麼）

1. **不要修程式。** 記錄下來就好。
2. 確認該檔**確實是**對應類型的預算書（中央單位預算案／地方單位預算）。若不是，記為
   `out-of-scope` 並從語料移除——用錯檔案產生的 blocker 是雜訊。
3. 同一檢查代號在多份出現時，**保留最小的那一份**當代表（頁數最少），其餘只記檔名。
   大檔重現一次要 30 秒，排查時很痛。
4. 若同一份 PDF 同時觸發 3 個以上檢查，優先懷疑「整份沒讀對」而非三個獨立 bug，
   在報告中標註 `suspect-systemic`。

---

## 六、hermes 調用範本

冷啟動 agent 沒有本對話脈絡，prompt 必須自足（絕對路徑、精確規格、明確禁止事項）：

```bash
hermes -z "你是批次測試執行者。請完整讀取 /Users/hsiehminchieh/Dev/Work/unit-budget-parser/TESTPLAN.md 並嚴格遵守。

任務：依該文件的 §1 取樣計畫，蒐集中央部會單位預算案 PDF（目標 15 個機關 × 2 年度），
存到 /Users/hsiehminchieh/Dev/Work/_budget-corpus/central/，維護 corpus.jsonl，
然後依 §2 執行 /Users/hsiehminchieh/Dev/Work/unit-budget-parser/audit.mjs，
依 §4.4 產出報告到 /Users/hsiehminchieh/Dev/Work/_budget-corpus/report-central.md。

硬性限制：
- 不得修改 unit-budget-parser 或 local-budget-parser 底下的任何檔案
- 不得 git commit / git add / git push
- 不得調整 audit.mjs 的門檻或跳過失敗的檔案
- 判定一律以 audit.mjs 的退出碼與 JSON 為準，不要自行判斷數字對錯
- 總下載量超過 5GB 或任何步驟卡住超過 10 分鐘就停下來回報"
```

地方版把 `central` 換成 `local`、`unit-budget-parser` 換成 `local-budget-parser`、
取樣改為「15 個縣市，含至少 5 份主管單位預算」即可。

**兩批不要同時跑同一個 corpus 目錄**（各自 owner 一個子目錄），避免檔案互相覆蓋。

---

## 七、驗收標準

這輪大量測試算成功，不是「全部通過」，而是：

- 覆蓋面達到 §1.1 的目標（或說清楚哪一格拿不到、為什麼）
- 每個 blocker 都有可直接執行的最小重現指令
- 沒有任何一筆判定來自 agent 的自然語言判斷

**全部通過反而要懷疑取樣不夠散。** 現有 12 份範例已經全綠，新版面若也全綠，
先檢查是不是重複抓到同一種排版範本。
