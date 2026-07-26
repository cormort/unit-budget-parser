// 回歸測試：用 examples/ 的三份真實 PDF 驗證解析結果沒有退化。
//
// 關鍵設計：直接載入 index.html 內的解析核心（parseUnitDoc）來跑，不自行複寫規則。
// 本專案曾因外部驗證腳本自行複寫解析迴圈而得出失真結論（斷裂數字、孤兒句數量全錯），
// 所以測試必須跑「實際上線的那份程式碼」。
//
//   npm install && npm test
//
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { readFile } from 'fs/promises';
import vm from 'node:vm';

// ── 期望值：任何規則改動若動到既有歸屬，這裡就會失敗 ──
const EXPECT = {
    'dgbas-115.pdf': { agency: '行政院主計總處', plans: 12, rows: 296, l2: 239, withDesc: 228, orphans: 4 },
    'moe-115.pdf': { agency: '教育部', plans: 17, rows: 867, l2: 622, withDesc: 144, orphans: 464 },
    'moa-115.pdf': { agency: '農業部', plans: 8, rows: 439, l2: 319, withDesc: 217, orphans: 25 },
};

// 在 sandbox 中執行 index.html 的 <script>，以 stub 應付 DOM
function loadTool(html) {
    const js = html.split('<script>')[1].split('</script>')[0]
        .replace(/pdfjsLib\.GlobalWorkerOptions[^\n]*\n/, '');
    const stub = { files: { length: 0 }, style: {}, value: '', textContent: '', innerHTML: '', options: [], addEventListener() { }, querySelectorAll: () => [] };
    const ctx = {
        console, document: { getElementById: () => stub, querySelectorAll: () => [], createElement: () => stub },
        window: {}, XLSX: {}, pdfjsLib: { GlobalWorkerOptions: {} },
        URL: { createObjectURL: () => '', revokeObjectURL() { } }, Blob: function () { },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    return ctx;
}

// 上下合計驗算：二級→一級→分支→工作計畫預算金額
function reconcile(rows) {
    const l2s = {}, l1a = {}, brs = {}, bra = {}, pls = {}, plb = {};
    for (const r of rows) {
        const a = +r.amount;
        plb[r.planCode] = +r.planBudget.replace(/,/g, '');
        const bk = r.planCode + '|' + r.branchCode, lk = bk + '|' + r.l1Code;
        if (r.level === '分支計畫') { bra[bk] = a; pls[r.planCode] = (pls[r.planCode] || 0) + a; }
        else if (r.level === '用途別一級') { l1a[lk] = a; brs[bk] = (brs[bk] || 0) + a; }
        else l2s[lk] = (l2s[lk] || 0) + a;
    }
    const bad = [];
    for (const k in l1a) if (l2s[k] !== undefined && l2s[k] !== l1a[k]) bad.push(`一級 ${k}: ${l1a[k]} ≠ Σ二級 ${l2s[k]}`);
    for (const k in bra) if (brs[k] !== undefined && brs[k] !== bra[k]) bad.push(`分支 ${k}: ${bra[k]} ≠ Σ一級 ${brs[k]}`);
    for (const k in plb) if (pls[k] !== undefined && pls[k] !== plb[k]) bad.push(`計畫 ${k}: ${plb[k]} ≠ Σ分支 ${pls[k]}`);
    return bad;
}

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
let failed = 0;

for (const [file, want] of Object.entries(EXPECT)) {
    const ctx = loadTool(html);          // 每份重新載入，避免狀態互相污染
    const data = new Uint8Array(await readFile(new URL(`./examples/${file}`, import.meta.url)));
    const task = getDocument({ data });
    const pdf = await task.promise;
    const rows = await ctx.parseUnitDoc(pdf);
    await task.destroy();

    const l2 = rows.filter(r => r.level === '用途別二級');
    const got = {
        agency: ctx.detectedAgency(),
        plans: new Set(rows.map(r => r.planCode)).size,
        rows: rows.length,
        l2: l2.length,
        withDesc: l2.filter(r => r.desc).length,
        orphans: rows.filter(r => r.level === '分支計畫')
            .reduce((n, r) => n + (r.descFrags || []).filter(f => !f.matched).length, 0),
    };

    const errs = Object.entries(want).filter(([k, v]) => got[k] !== v)
        .map(([k, v]) => `${k}: 期望 ${v}，實際 ${got[k]}`);
    errs.push(...reconcile(rows).map(m => '四層驗算不符 → ' + m));

    if (errs.length) {
        failed++;
        console.error(`✗ ${file}`);
        errs.forEach(e => console.error('    ' + e));
    } else {
        console.log(`✓ ${file}  ${got.agency}｜${got.plans} 計畫／${got.rows} 列｜二級 ${got.l2}（有說明 ${got.withDesc}）｜孤兒句 ${got.orphans}｜四層驗算 0 不符`);
    }
}

if (failed) {
    console.error(`\n${failed} 份不符。若為刻意調整規則，請一併更新 test.mjs 的 EXPECT 與 README 數字。`);
    process.exit(1);
}
console.log('\n全部通過。');
