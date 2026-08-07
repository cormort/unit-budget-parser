// 回歸測試：用 examples/ 的五份真實 PDF 驗證解析結果沒有退化。
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
// rows 含「未歸戶說明」列（每個未歸戶句一列，插在敘述順序的前後科目之間），故 rows = 科目列 + orphans
const EXPECT = {
    'dgbas-115.pdf': { agency: '行政院主計總處', plans: 12, rows: 297, l2: 239, withDesc: 232, orphans: 1 },
    // 救回被承辦單位欄吞掉的說明後：rows 1313→1352、withDesc 144→148、orphans 446→485
    // (n) 子句跟著父句歸屬分支層後：rows 1352→1348、orphans 485→481（17 份共少 23 筆孤兒列，
    // 字元多重集合完全一致＝那些句子只是從獨立列移到分支列，沒有任何文字遺失）
    'moe-115.pdf': { agency: '教育部', plans: 17, rows: 1348, l2: 622, withDesc: 148, orphans: 481 },
    'moa-115.pdf': { agency: '農業部', plans: 8, rows: 460, l2: 319, withDesc: 217, orphans: 21 },
    // 以下兩份含「非基準版面」，是欄界量測（_unitPageHead）的回歸樣本，不可只留基準版面的三份：
    //   mohw 整張表縮到約 95%（說明欄 x=356、內文 341，皆低於原本寫死的 359）——六份實測中僅此一份
    //   motc／mohw 另含「一般性補助款－X」附冊，表頭字被逐字拆開且工作計畫表頭高出 7pt
    'motc-115.pdf': { agency: '交通部', plans: 13, rows: 273, l2: 137, withDesc: 101, orphans: 27 },
    'mohw-115.pdf': { agency: '衛生福利部', plans: 21, rows: 1318, l2: 889, withDesc: 719, orphans: 97 },
};

// 在 sandbox 中執行 index.html 的 <script>，以 stub 應付 DOM
function loadTool(html) {
    // 取最長的 inline <script>＝工具本體（頁面另有 GA 等短腳本，不能寫死第 1 個）
    const js = html.split('<script>').slice(1).map(s => s.split('</script>')[0])
        .reduce((a, b) => b.length > a.length ? b : a)
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
        else if (r.level === '用途別二級') l2s[lk] = (l2s[lk] || 0) + a;   // 未歸戶說明列無金額，不入加總
    }
    const bad = [];
    for (const k in l1a) if (l2s[k] !== undefined && l2s[k] !== l1a[k]) bad.push(`一級 ${k}: ${l1a[k]} ≠ Σ二級 ${l2s[k]}`);
    for (const k in bra) if (brs[k] !== undefined && brs[k] !== bra[k]) bad.push(`分支 ${k}: ${bra[k]} ≠ Σ一級 ${brs[k]}`);
    for (const k in plb) if (pls[k] !== undefined && pls[k] !== plb[k]) bad.push(`計畫 ${k}: ${plb[k]} ≠ Σ分支 ${pls[k]}`);
    return bad;
}

// 工作計畫核對：概況表的每個工作計畫，都要能在歲出機關別預算表找到相同的編號、
// 相容的名稱與相同的本年度預算數。四層驗算只證明概況表「自己前後一致」（頂端的工作計畫
// 預算數就取自概況表自身），這條才是外部依據。
function crossCheckAgency(ctx, rows, agency) {
    if (!agency.pages) return ['找不到「歲出機關別預算表」頁面'];
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.planCode)) seen.set(r.planCode, { name: r.planName, budget: r.planBudget });
    const bad = [];
    let noName = 0;
    const unmatched = [];
    for (const [code, p] of seen) {
        const a = agency.map.get(code);
        if (!a) { unmatched.push(code); continue; }   // 對不到不算錯，但要計數（見下）
        if (a.budget !== p.budget) bad.push(`${code}「${p.name}」預算數 ${p.budget} ≠ 機關別表 ${a.budget || '(未取得)'}`);
        // 名稱欄常被欄寬截斷、或被 pdf.js 與說明欄黏成同一 item，抽不到就略過，不誤報成不符
        const ni = ctx._planNameIssue(a.name, p.name);
        if (ni === 'noname') noName++;
        else if (ni === 'short') bad.push(`${code} 概況表名稱不完整「${p.name}」⊂ 機關別表「${a.name}」`);
        else if (ni) bad.push(`${code} 名稱「${p.name}」≠ 機關別表「${a.name}」`);
    }
    // 抽不到名稱的比例若暴增，代表版面偵測退化了，要擋下來
    if (noName > Math.max(3, seen.size * 0.2)) bad.push(`機關別表有 ${noName}/${seen.size} 個計畫抽不到名稱，版面偵測可能退化`);
    // 中央五份實測全部對得到；一旦有計畫對不到，代表版面偵測退化或該表沒讀全，要擋下來
    if (unmatched.length) bad.push(`${unmatched.length} 個工作計畫不在機關別預算表（${unmatched.join('、')}），金額無法外部核對`);
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
    const agency = await ctx.parseAgencyPlanTable(pdf);
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
    errs.push(...crossCheckAgency(ctx, rows, agency).map(m => '工作計畫核對不符 → ' + m));

    if (errs.length) {
        failed++;
        console.error(`✗ ${file}`);
        errs.forEach(e => console.error('    ' + e));
    } else {
        console.log(`✓ ${file}  ${got.agency}｜${got.plans} 計畫／${got.rows} 列｜二級 ${got.l2}（有說明 ${got.withDesc}）｜孤兒句 ${got.orphans}｜四層驗算 0 不符｜工作計畫核對 ${got.plans}/${got.plans}（機關別表 ${agency.pages} 頁）`);
    }
}

if (failed) {
    console.error(`\n${failed} 份不符。若為刻意調整規則，請一併更新 test.mjs 的 EXPECT 與 README 數字。`);
    process.exit(1);
}
console.log('\n全部通過。');
