// 批次稽核：對任意數量的單位預算案 PDF 跑解析，輸出「機器可讀的檢驗結果」。
//
//   node audit.mjs <pdf|dir>... [--out report.json] [--jsonl]
//
// 與 test.mjs 的分工：
//   test.mjs  = 回歸測試，五份已知 PDF 的期望值寫死，任何變動都要人來確認
//   audit.mjs = 探索性稽核，對「沒看過的 PDF」跑不變式檢查，用來找新的版面破口
//
// 判定一律由本檔的確定性規則做，不交給人或 agent 目測——目測會漏、會累、會編。
// 檢查分兩級：
//   blocker：違反即為 bug，無需 ground truth 就能斷定（如上下層加總不符、同一計畫兩種預算數）
//   warn   ：品質指標超出區間，可能是資料本身的限制，需人工判讀（如孤兒句比例過高）
// 退出碼：有任何 blocker → 1；只有 warn → 0。CI 與 agent 都靠這個判斷。

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import vm from 'node:vm';

// ── 品質指標的可接受區間。超出不代表壞掉，代表「值得看一眼」 ──
// 上界取自六個機關的實測最差值再放寬，不是憑感覺訂的：
//   孤兒句比例最高為教育部 446/1313 = 34%（其說明按單位而非按科目撰寫，屬資料限制）
const WARN = {
    orphanRate: 0.40,        // 未歸戶句 / 總列數
    nameUnextractedRate: 0.20,  // 機關別表抽不到名稱的計畫比例（實測最差 2/12 = 17%）
    descCoverage: 0.05,      // 二級科目有說明的比例低於此 → 可能整段說明沒讀到
};

function loadTool(html) {
    // 取最長的 inline <script>＝工具本體（頁面另有 GA 等短腳本，不能寫死第 1 個）
    const js = html.split('<script>').slice(1).map(s => s.split('</script>')[0])
        .reduce((a, b) => b.length > a.length ? b : a)
        .replace(/pdfjsLib\.GlobalWorkerOptions[^\n]*\n/, '');
    const stub = { files: { length: 0 }, style: {}, value: '', textContent: '', innerHTML: '', options: [], addEventListener() { }, querySelectorAll: () => [] };
    const ctx = {
        console: { log() { }, warn() { }, error() { } },   // 解析過程的雜訊不進報告
        document: { getElementById: () => stub, querySelectorAll: () => [], createElement: () => stub },
        window: {}, XLSX: {}, pdfjsLib: { GlobalWorkerOptions: {} },
        URL: { createObjectURL: () => '', revokeObjectURL() { } }, Blob: function () { },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    return ctx;
}

const n = v => +String(v ?? '').replace(/,/g, '');

// ── blocker 1：上下層加總 ──
function checkFourLayer(rows) {
    const l2s = {}, l1a = {}, brs = {}, bra = {}, pls = {}, plb = {};
    for (const r of rows) {
        const a = n(r.amount);
        plb[r.planCode] = n(r.planBudget);
        const bk = r.planCode + '|' + r.branchCode, lk = bk + '|' + r.l1Code;
        if (r.level === '分支計畫') { bra[bk] = a; pls[r.planCode] = (pls[r.planCode] || 0) + a; }
        else if (r.level === '用途別一級') { l1a[lk] = a; brs[bk] = (brs[bk] || 0) + a; }
        else if (r.level === '用途別二級') l2s[lk] = (l2s[lk] || 0) + a;
    }
    const v = [];
    for (const k in l1a) if (l2s[k] !== undefined && l2s[k] !== l1a[k]) v.push({ where: '一級 ' + k, listed: l1a[k], sum: l2s[k], diff: l2s[k] - l1a[k] });
    for (const k in bra) if (brs[k] !== undefined && brs[k] !== bra[k]) v.push({ where: '分支 ' + k, listed: bra[k], sum: brs[k], diff: brs[k] - bra[k] });
    for (const k in plb) if (pls[k] !== undefined && pls[k] !== plb[k]) v.push({ where: '計畫 ' + k, listed: plb[k], sum: pls[k], diff: pls[k] - plb[k] });
    return v;
}

// ── blocker 2：同一個 planCode 不得出現兩種 planBudget ──
// 實測地方版曾因「經常門／資本門分兩段、累加後未回填先前的列」而違反；
// 四層驗算取最後一列故一路通過，匯出的欄位卻自相矛盾。這條專門守住它。
function checkPlanBudgetConsistent(rows) {
    const m = new Map();
    for (const r of rows) {
        if (!r.planCode || !r.planBudget) continue;
        if (!m.has(r.planCode)) m.set(r.planCode, new Set());
        m.get(r.planCode).add(String(r.planBudget));
    }
    return [...m].filter(([, s]) => s.size > 1)
        .map(([code, s]) => ({ planCode: code, values: [...s] }));
}

// ── blocker 3：欄位形狀 ──
// 名稱欄若混進表格內文或說明文字，代表抽取越界了。這些特徵字不可能出現在合法的科目/計畫名裡。
// 「合計」不可裸用：實測內政部的分支計畫「辦理戶政綜**合計**畫及研習活動」跨詞邊界誤中，
// 那是合法名稱。只認表格頁尾真正會出現的形式（「說明合計」、「合計」後面直接接數字）。
// 其餘樣式已用六個機關約 4,600 個名稱值掃過，無誤中。
const NAME_POISON = /千元|說明合計|合計\d|計畫內容|項目內容|預算數|本年度|承辦單位|詳[0-9]|如下[：:]/;
function checkFieldShape(rows) {
    const v = [];
    const seen = new Set();
    const add = (kind, detail) => { const k = kind + '|' + detail; if (!seen.has(k)) { seen.add(k); v.push({ kind, detail }); } };
    for (const r of rows) {
        if (r.planCode && !/^(?:\d{10,11}|\d{4}[a-z]\d{6})$/i.test(r.planCode)) add('planCode 格式非法', r.planCode);
        if (r.level === '分支計畫' && !/^\d{2}$/.test(r.branchCode)) add('branchCode 格式非法', `${r.planCode}/${r.branchCode}`);
        if (r.level === '用途別一級' && !/^\d{3}0$/.test(r.l1Code)) add('l1Code 格式非法', r.l1Code);
        if (r.level === '用途別二級' && !/^\d{4}$/.test(r.l2Code)) add('l2Code 格式非法', r.l2Code);
        for (const [f, val] of [['planName', r.planName], ['branchName', r.branchName], ['l1Name', r.l1Name], ['l2Name', r.l2Name]]) {
            if (val && NAME_POISON.test(val)) add(`${f} 混入表格內文`, `${r.planCode} 「${String(val).slice(0, 40)}」`);
        }
        if (r.planCode && !String(r.planName || '').trim()) add('planName 為空', r.planCode);
        if (r.amount !== '' && !Number.isFinite(n(r.amount))) add('amount 非數值', `${r.planCode} ${r.amount}`);
        if (r.amount !== '' && n(r.amount) < 0) add('amount 為負', `${r.planCode} ${r.amount}`);
    }
    return v;
}

// ── blocker 4：工作計畫核對（外部基準） ──
function checkCrossCheck(ctx, rows, agency) {
    if (!agency.pages) return { available: false, violations: [], checked: 0, total: 0, unmatched: [], nameUnextracted: 0, amountUnextracted: 0 };
    const seen = new Map();
    for (const r of rows) if (r.planCode && !seen.has(r.planCode)) seen.set(r.planCode, { name: r.planName, budget: r.planBudget });
    const violations = [], unmatched = [];
    let nameUnextracted = 0, amountUnextracted = 0;
    for (const [code, p] of seen) {
        const a = agency.map.get(code);
        if (!a) { unmatched.push({ planCode: code, name: p.name, budget: p.budget }); continue; }
        if (!a.budget) amountUnextracted++;
        else if (a.budget !== p.budget) violations.push({ kind: '本年度預算數不符', planCode: code, agency: a.budget, tool: p.budget });
        const ni = ctx._planNameIssue(a.name, p.name);
        if (ni === 'noname') nameUnextracted++;
        else if (ni === 'short') violations.push({ kind: '本表名稱不完整', planCode: code, agency: a.name, tool: p.name });
        else if (ni) violations.push({ kind: '名稱對不上', planCode: code, agency: a.name, tool: p.name });
    }
    return { available: true, violations, checked: seen.size - unmatched.length, total: seen.size, unmatched, nameUnextracted, amountUnextracted };
}

async function auditOne(html, file, toolVersion) {
    const t0 = Date.now();
    const rec = { file, tool: 'unit-budget-parser', toolVersion, ok: false, blockers: [], warnings: [] };
    let task = null;
    try {
        const ctx = loadTool(html);
        task = getDocument({ data: new Uint8Array(await readFile(file)) });
        const pdf = await task.promise;
        rec.pages = pdf.numPages;
        const rows = await ctx.parseUnitDoc(pdf);
        const agency = await ctx.parseAgencyPlanTable(pdf);
        rec.agency = ctx.detectedAgency() || null;

        if (!rows.length) {
            rec.blockers.push({ check: 'parse', detail: '解析不出任何資料列（可能不是單位預算案，或版面未支援）' });
            return rec;
        }
        const l2 = rows.filter(r => r.level === '用途別二級');
        rec.counts = {
            rows: rows.length,
            plans: new Set(rows.map(r => r.planCode)).size,
            branches: rows.filter(r => r.level === '分支計畫').length,
            l2: l2.length,
            l2WithDesc: l2.filter(r => r.desc).length,
            orphans: rows.filter(r => r.level === '未歸戶說明').length,
            agencyTablePages: agency.pages,
        };

        const four = checkFourLayer(rows);
        if (four.length) rec.blockers.push({ check: 'fourLayer', count: four.length, sample: four.slice(0, 5) });

        const pb = checkPlanBudgetConsistent(rows);
        if (pb.length) rec.blockers.push({ check: 'planBudgetConsistent', count: pb.length, sample: pb.slice(0, 5) });

        const shape = checkFieldShape(rows);
        if (shape.length) rec.blockers.push({ check: 'fieldShape', count: shape.length, sample: shape.slice(0, 8) });

        const cc = checkCrossCheck(ctx, rows, agency);
        rec.crossCheck = { available: cc.available, checked: cc.checked, total: cc.total, unmatched: cc.unmatched.length };
        if (!cc.available) {
            rec.warnings.push({ check: 'crossCheck', detail: '這份 PDF 沒有歲出機關別預算表，工作計畫的編號與金額無外部依據' });
        } else {
            if (cc.violations.length) rec.blockers.push({ check: 'crossCheck', count: cc.violations.length, sample: cc.violations.slice(0, 8) });
            if (cc.unmatched.length) rec.warnings.push({ check: 'crossCheckUnmatched', count: cc.unmatched.length, sample: cc.unmatched.slice(0, 8), detail: '這些計畫在機關別預算表找不到對應編號，金額未經外部核對' });
            if (cc.amountUnextracted) rec.warnings.push({ check: 'agencyAmountUnextracted', count: cc.amountUnextracted });
            const nr = cc.total ? cc.nameUnextracted / cc.total : 0;
            if (nr > WARN.nameUnextractedRate) rec.warnings.push({ check: 'agencyNameUnextracted', count: cc.nameUnextracted, rate: +nr.toFixed(3), threshold: WARN.nameUnextractedRate });
        }

        const orphanRate = rec.counts.orphans / rec.counts.rows;
        const descCoverage = rec.counts.l2 ? rec.counts.l2WithDesc / rec.counts.l2 : 0;
        rec.quality = { orphanRate: +orphanRate.toFixed(3), descCoverage: +descCoverage.toFixed(3), nameUnextracted: cc.nameUnextracted, amountUnextracted: cc.amountUnextracted };
        if (orphanRate > WARN.orphanRate) rec.warnings.push({ check: 'orphanRate', value: +orphanRate.toFixed(3), threshold: WARN.orphanRate });
        if (rec.counts.l2 && descCoverage < WARN.descCoverage) rec.warnings.push({ check: 'descCoverage', value: +descCoverage.toFixed(3), threshold: WARN.descCoverage });

        rec.ok = rec.blockers.length === 0;
    } catch (e) {
        rec.blockers.push({ check: 'exception', detail: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
    } finally {
        if (task) await task.destroy().catch(() => { });
        rec.durationMs = Date.now() - t0;
    }
    return rec;
}

async function expand(paths) {
    const out = [];
    for (const p of paths) {
        if (statSync(p).isDirectory()) {
            for (const f of await readdir(p)) if (/\.pdf$/i.test(f)) out.push(join(p, f));
        } else if (/\.pdf$/i.test(p)) out.push(p);
    }
    return out.sort();
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const jsonl = args.includes('--jsonl');
const inputs = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
if (!inputs.length) {
    console.error('用法：node audit.mjs <pdf|dir>... [--out report.json] [--jsonl]');
    process.exit(2);
}

let toolVersion = 'unknown';
try { toolVersion = execSync('git rev-parse --short HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim(); } catch { }

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const files = await expand(inputs);
const records = [];
for (const f of files) {
    const rec = await auditOne(html, f, toolVersion);
    records.push(rec);
    if (jsonl) console.log(JSON.stringify(rec));
    const tag = rec.blockers.length ? `✗ blocker ${rec.blockers.length}` : rec.warnings.length ? `△ warn ${rec.warnings.length}` : '✓';
    console.error(`${tag}  ${basename(f)}｜${rec.agency || '機關未偵測'}｜${rec.counts ? `${rec.counts.plans} 計畫／${rec.counts.rows} 列` : '無資料列'}`);
    for (const b of rec.blockers) console.error(`      blocker ${b.check}${b.count ? ` ×${b.count}` : ''}${b.detail ? '：' + b.detail : ''}`);
}

const summary = {
    generatedAt: new Date().toISOString(),
    tool: 'unit-budget-parser',
    toolVersion,
    total: records.length,
    passed: records.filter(r => r.ok && !r.warnings.length).length,
    warned: records.filter(r => r.ok && r.warnings.length).length,
    failed: records.filter(r => !r.ok).length,
    blockerByCheck: records.flatMap(r => r.blockers).reduce((m, b) => (m[b.check] = (m[b.check] || 0) + 1, m), {}),
    warnByCheck: records.flatMap(r => r.warnings).reduce((m, b) => (m[b.check] = (m[b.check] || 0) + 1, m), {}),
};
const report = { summary, records };
if (outFile) await writeFile(outFile, JSON.stringify(report, null, 2));
else if (!jsonl) console.log(JSON.stringify(report, null, 2));

console.error(`\n合計 ${summary.total}：通過 ${summary.passed}、僅警告 ${summary.warned}、有 blocker ${summary.failed}`);
console.error('blocker 分布：' + (Object.keys(summary.blockerByCheck).length ? JSON.stringify(summary.blockerByCheck) : '無'));
process.exit(summary.failed ? 1 : 0);
