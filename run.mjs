// 批次解析：node run.mjs <pdf...> — 每份輸出同名 .csv（欄位動態取自解析結果）。
// 與 test.mjs 相同做法：直接跑 index.html 內的 parseUnitDoc，不複寫規則。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { readFile, writeFile } from 'fs/promises';
import { loadTool, reconcile, issueText } from './harness.mjs';

const csv = rows => {
    const cols = [...new Set(rows.flatMap(Object.keys))].filter(c => c !== 'descFrags' && !c.startsWith('_'));
    // 防 CSV 公式注入：= + - @ 開頭的文字前綴 '（純數字如負金額不動）
    const cell = v => { const t = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(t) && !/^-?[\d,.]+$/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
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
    const bad = reconcile(ctx, rows);
    console.log(`${ctx.detectedAgency()}｜${new Set(rows.map(r => r.planCode)).size} 計畫／${rows.length} 列｜二級 ${l2.length}（有說明 ${l2.filter(r => r.desc).length}）｜孤兒句 ${rows.filter(r => r.level === '分支計畫').reduce((n, r) => n + (r.descFrags || []).filter(f => !f.matched).length, 0)}｜四層驗算 ${bad.length} 不符 → ${out}`);
    bad.slice(0, 10).forEach(m => console.log('    ' + issueText(m)));
}
