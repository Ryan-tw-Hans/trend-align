# TrendAlign — 多軌報表趨勢與時間對齊工作台

> **讓每一段數據，清晰可見。**  
> 純前端、零伺服器、本機優先（Local-first）的工程波形與多份測試報表時間對齊比對工具。

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20Demo-brightgreen.svg)](https://Ryan-tw-Hans.github.io/trend-align/)
[![License: MIT / Apache 2.0 SheetJS](https://img.shields.io/badge/License-SheetJS%20CE-blue.svg)](vendor/SheetJS-LICENSE.txt)
[![No Backend Needed](https://img.shields.io/badge/Backend-Zero%20Dependency-orange.svg)](#-資安與隱私保證)

🌐 **線上使用網址**：[https://Ryan-tw-Hans.github.io/trend-align/](https://Ryan-tw-Hans.github.io/trend-align/)

---

## 🌟 核心特色

1. **🛡️ 100% 本機端運算（Zero Server & Zero Data Upload）**：
   * 程式所有運算（Excel 解析、時間對齊、Canvas 繪圖、標尺差值計算）完全在使用者瀏覽器記憶體中執行。
   * **絕不上傳任何數據到伺服器**，保障企業機密測試報表絕對安全，支援離線使用。
2. **📈 高效能 Canvas 趨勢圖繪製**：
   * 支援百萬筆級別的時間序列數據，採用像素桶（Pixel Bucket）極值縮減演算法，完整保留突波與尖峰細節。
   * 滾輪中心縮放、矩形框選放大、視窗平移、雙 Y 軸獨立縮放（左軸/右軸）、相對變化（Δ 模式）。
3. **⏱️ 智慧報表時間對齊（Time Alignment）**：
   * **起始歸零（Elapsed Time）**：比較不同日期測試的進行進程。
   * **實際時間（Absolute Time）**：精準對齊同一時刻。
   * **特徵自動對齊**：支援依據最大值、最小值或最明顯上升沿（正斜率），一鍵將多份報表對齊。
   * **雙標尺對齊與手動拖曳平移**：使用 A/B 標尺標記事件點後直接瞬移對齊。
4. **🎛️ 自由版面自訂與一鍵還原**：
   * **獨立工具區塊收折**：左側「資料來源」、「比較設定」、「訊號通道」各區塊皆可點擊標題縮小至剩標題列，節省視野空間。
   * **寬度與高度自由拖曳**：可拖曳側邊欄與圖表分界線調整寬度，各區塊底部與圖表、數據表下方均設有高度調整把手。
   * **一鍵恢復預設排版**：隨時點擊「↺ 恢復預設」或「⊞ 預設版面」，即可將所有區塊尺寸與收折狀態還原。
5. **📊 人性化標尺與區間分析數據表**：
   * **欄位排序（Sorting）**：點擊任一表頭（訊號、標尺 A/B、Δ差異、最小值、最大值、平均值、有效點數）進行升降冪排序，缺值智慧置底。
   * **欄位寬度拖曳（Resizing）**：滑鼠移至表頭邊界拖曳即可調整欄寬，雙擊恢復預設。
   * **峰谷極值一鍵定位標尺**：點擊表格中「最小值」或「最大值」時間，標尺 A/B 自動瞬移至該極值發生時刻，精準比對異常。
   * **資料列與圖表曲線同步聚焦**：點擊表格列即時高亮該報表曲線，其餘曲線自動淡化。
   * **即時搜尋過濾**：輸入關鍵字即時篩選訊號通道。
6. **📥 匯出成果**：
   * 一鍵匯出高解析度趨勢圖 PNG（附圖例、報表資訊與偏移量）。
   * 匯出 UTF-8 BOM CSV 區間統計報表（含標尺數值、極值時間與原始檔案列號）。

---

## 🚀 如何使用 GitHub Pages 免費發布給他人使用？

本工具專為 GitHub Pages 設計，是純靜態網頁（Static Web App）。發布後，其他人打開網頁即可**讀取他們自己電腦上的 Excel 或 CSV 報表**進行分析，而他們的檔案絕不會外洩！

### 發布步驟：

1. **推送代碼至 GitHub**：
   在 `trend-align` 資料夾下執行：
   ```bash
   git add .
   git commit -m "feat: complete TrendAlign web application"
   git push -u origin main
   ```
2. **啟用 GitHub Pages**：
   - 進入 GitHub 倉儲的 **Settings** 頁面。
   - 左側選單點選 **Pages**。
   - 在 **Build and deployment** > **Source** 選擇 `Deploy from a branch`。
   - **Branch** 選擇 `main` 分支，資料夾選擇 `/ (root)`，點擊 **Save**。
3. **獲取網址並分享**：
   - 約等待 30 秒至 1 分鐘，GitHub Pages 即會上線：  
     `https://Ryan-tw-Hans.github.io/trend-align/`
   - 將此網址傳給任何使用者，使用 Chrome、Edge 或 Safari 打開即可立即使用！

---

## 🔒 資安與隱私保證（為什麼其他人可以用它讀取自己電腦的報表？）

* **瀏覽器本機檔案 API（HTML5 File API）**：  
  當使用者在瀏覽器中選取本機檔案或拖曳檔案進網頁時，檔案僅由瀏覽器的 JavaScript 讀入該使用者電腦的**分頁記憶體（RAM）**中進行解析。
* **零網路傳輸（No Network Requests）**：  
  打開瀏覽器開發者工具（F12 -> Network 網路面板）可見：除了初次載入靜態 HTML/CSS/JS 之外，**在匯入檔案、分析計算與拖曳標尺的整個過程中，不會發送任何 API 請求或資料上傳**。
* **支援離線使用**：  
  一旦網頁載入完成，即使把電腦網路拔掉或進入飛航模式，整套分析系統依然可以 100% 正常載入檔案、分析波形與匯出報表！

---

## 💻 本機直接執行（不需網路）

如果您或使用者不想透過網頁連結，也可以下載此專案後在本機直接使用：

* **Windows 使用者**：直接雙擊資料夾內的 `開啟趨勢分析.cmd`。
* **其他系統（macOS / Linux）**：使用任何現代瀏覽器（Chrome、Edge、Firefox、Safari）直接開啟 `index.html`。
* 隨附的 `sample-data/` 資料夾內提供示範 CSV 檔案，可直接拖放體驗測試。

---

## 📋 支援檔案格式

| 格式 | 副檔名 | 說明 |
| :--- | :--- | :--- |
| **Excel 活頁簿** | `.xlsx`, `.xls` | 支援多工作表自動拆分來源、1900/1904 日期系統 |
| **CSV 逗點分隔檔** | `.csv` | 自動判斷 UTF-8 / Big5 編碼、支援自訂分隔符號與引號換行 |
| **TSV 定界字元檔** | `.tsv` | Tab 鍵分隔之數據紀錄 |

* **資料格式規範**：
  * 第一列：欄位名稱（Channel Names）
  * 第一欄：時間（支援 `YYYY-MM-DD HH:mm:ss.SSS`、`HH:mm:ss.SSS`、Excel 日期序號、Unix 秒/毫秒）
  * 其餘欄位：數值資料（空值或文字會自動形成斷線，不補 0）

---

## 🛠️ 技術棧與開源授權

* **前端架構**：原生 HTML5、CSS3（現代變數與 Grid/Flexbox）、原生 ES6+ JavaScript。
* **圖表渲染**：HTML5 Canvas 2D Context（無重量級前端框架依賴，載入速度極快）。
* **Excel 解析引擎**：內附 [SheetJS Community Edition](https://sheetjs.com/)（`vendor/xlsx.full.min.js`，授權遵循 Apache 2.0，授權文件見 `vendor/SheetJS-LICENSE.txt`）。
* **無外部 CDN 依賴**：所有字型、腳本均為本機相對路徑打包，無任何外連 CDN 斷線風險。

---

*Made with precision for engineering signal analysis.*
