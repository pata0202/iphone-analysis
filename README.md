# iphone-analysis

上傳 iPhone 的 sysdiagnose，辨識螢幕、電池、基頻、Wi-Fi 晶片的製造商與社群排名。檔案只在瀏覽器內解析，不會上傳。

```bash
npm install
npm run dev     # http://localhost:4321
npm test        # 解析器測試（test-data/ 存在時會一併跑真實資料）
npm run build   # 輸出靜態網站到 dist/
```

- 製造商對照與排名：`src/data/vendors.json`
- 教學截圖：`public/guide/stepN.jpg`
