// 批次解析：node run.mjs <pdf...> — 每份輸出同名 .csv（欄位動態取自解析結果）。
// 與 test.mjs 相同做法：直接跑 index.html 內的 parseUnitDoc，不複寫規則。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { readFile, writeFile } from 'fs/promises';
import vm from 'node:vm';

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

// 上下合計驗算（同 test.mjs）
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

const csv = rows => {
    const cols = [...new Set(rows.flatMap(Object.keys))].filter(c => c !== 'descFrags' && !c.startsWith('_'));
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
};

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
for (const pdfPath of process.argv.slice(2)) {
    const ctx = loadTool(html);
    const task = getDocument({ data: new Uint8Array(await readFile(pdfPath)) });
    const pdf = await task.promise;
    const rows = await ctx.parseUnitDoc(pdf);
    await task.destroy();

    const out = pdfPath.replace(/\.pdf$/i, '') + '.csv';
    await writeFile(out, csv(rows));

    const l2 = rows.filter(r => r.level === '用途別二級');
    const bad = reconcile(rows);
    console.log(`${ctx.detectedAgency()}｜${new Set(rows.map(r => r.planCode)).size} 計畫／${rows.length} 列｜二級 ${l2.length}（有說明 ${l2.filter(r => r.desc).length}）｜孤兒句 ${rows.filter(r => r.level === '分支計畫').reduce((n, r) => n + (r.descFrags || []).filter(f => !f.matched).length, 0)}｜四層驗算 ${bad.length} 不符 → ${out}`);
    bad.slice(0, 10).forEach(m => console.log('    ' + m));
}
