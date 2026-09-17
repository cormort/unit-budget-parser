// 回歸測試：用 examples/ 的五份真實 PDF 驗證解析結果沒有退化。
//
// 關鍵設計：直接載入 index.html 內的解析核心（parseUnitDoc）來跑，不自行複寫規則。
// 本專案曾因外部驗證腳本自行複寫解析迴圈而得出失真結論（斷裂數字、孤兒句數量全錯），
// 所以測試必須跑「實際上線的那份程式碼」。載入器與查核規則收在 harness.mjs，
// 與 audit.mjs 共用同一份，避免兩邊各寫一次又漂移。
//
//   npm install && npm test
//
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { readFile } from 'fs/promises';
import vm from 'node:vm';
import { loadTool, reconcile, issueText, narrativeVisibility, factClaimIssues, acctCodeIssues, orphanShape } from './harness.mjs';

// ── 期望值：任何規則改動若動到既有歸屬，這裡就會失敗 ──
// rows 含「未歸戶說明」列（每個未歸戶句一列，插在敘述順序的前後科目之間），故 rows = 科目列 + orphans
const EXPECT = {
    'dgbas-115.pdf': { agency: '行政院主計總處', plans: 12, rows: 297, l2: 239, withDesc: 232, orphans: 1 },
    // 救回被承辦單位欄吞掉的說明後：rows 1313→1352、withDesc 144→148、orphans 446→485
    // (n) 子句跟著父句歸屬分支層後：rows 1352→1348、orphans 485→481（17 份共少 23 筆孤兒列，
    // 字元多重集合完全一致＝那些句子只是從獨立列移到分支列，沒有任何文字遺失）
    // 計畫沿革句歸分支層後：rows 1348→1317、orphans 481→450（字元多重集合 0 差異）
    'moe-115.pdf': { agency: '教育部', plans: 17, rows: 1317, l2: 622, withDesc: 148, orphans: 450 },
    'moa-115.pdf': { agency: '農業部', plans: 8, rows: 453, l2: 319, withDesc: 217, orphans: 14 },
    // 以下兩份含「非基準版面」，是欄界量測（_unitPageHead）的回歸樣本，不可只留基準版面的三份：
    //   mohw 整張表縮到約 95%（說明欄 x=356、內文 341，皆低於原本寫死的 359）——六份實測中僅此一份
    //   motc／mohw 另含「一般性補助款－X」附冊，表頭字被逐字拆開且工作計畫表頭高出 7pt
    // #n 續項歸戶 −10、計畫沿革句歸分支層 −17：rows 273→246、orphans 27→0
    'motc-115.pdf': { agency: '交通部', plans: 13, rows: 246, l2: 137, withDesc: 101, orphans: 0 },
    'mohw-115.pdf': { agency: '衛生福利部', plans: 21, rows: 1311, l2: 889, withDesc: 719, orphans: 90 },
};

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
const rowsByFile = new Map();      // 供後面的「未歸戶句形狀」查核使用

for (const [file, want] of Object.entries(EXPECT)) {
    const ctx = loadTool(html);          // 每份重新載入，避免狀態互相污染
    const data = new Uint8Array(await readFile(new URL(`./examples/${file}`, import.meta.url)));
    const task = getDocument({ data });
    const pdf = await task.promise;
    const rows = await ctx.parseUnitDoc(pdf);
    const agency = await ctx.parseAgencyPlanTable(pdf);
    await task.destroy();
    rowsByFile.set(file, rows);

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
    errs.push(...reconcile(ctx, rows).map(m => '四層驗算不符 → ' + issueText(m)));
    errs.push(...crossCheckAgency(ctx, rows, agency).map(m => '工作計畫核對不符 → ' + m));
    // 說明文字不得因為歸戶失敗而消失（每個切出來的句子都要在使用者看得到的地方）
    const nv = narrativeVisibility(ctx, rows);
    errs.push(...nv.lost.map(x => `說明文字消失 → ${x.branch}「${x.text.slice(0, 40)}」`));
    // 白底「事實級」標記必須自證（名稱＋金額、句中加總、合併數）
    errs.push(...factClaimIssues(rows).map(x => `${x.kind} → ${x.detail}`));
    // 科目代碼必須在官方清單內（不在清單就不會被名稱校正，也可能是代碼讀錯）
    errs.push(...acctCodeIssues(ctx, rows).map(x => `${x.kind} → ${x.detail}`));

    if (errs.length) {
        failed++;
        console.error(`✗ ${file}`);
        errs.forEach(e => console.error('    ' + e));
    } else {
        const shp = orphanShape(rows);
        const shapeTag = got.orphans && shp.total >= 10 ? `（含科目名 ${shp.withSubjectName}/${shp.total}${shp.byUnit ? '，敘述不按科目寫' : ''}）` : '';
        console.log(`✓ ${file}  ${got.agency}｜${got.plans} 計畫／${got.rows} 列｜二級 ${got.l2}（有說明 ${got.withDesc}）｜孤兒句 ${got.orphans}${shapeTag}｜四層驗算 0 不符｜工作計畫核對 ${got.plans}/${got.plans}（機關別表 ${agency.pages} 頁）｜說明 ${nv.frags} 句零遺失｜事實級標記自證 0 誤`);
    }
}

// ── 工程契約與查核規則本身的負向測試 ──
// 上面驗的是「解析結果對不對」，這裡驗的是「防護有沒有裝好」：契約一旦被拿掉、或查核規則
// 被改成永遠通過，這些斷言就會失敗。每一條都對應一個真的踩過的坑或真的修過的行為。
const contract = (ok, label, detail) => {
    if (ok) { console.log(`✓ ${label}`); return 0; }
    console.error(`✗ ${label}${detail ? '：' + detail : ''}`);
    return 1;
};

// ── 未歸戶句的形狀：分辨「敘述不按科目寫」與「規則漏接」 ──
// 這條決定了稽核門檻拿誰校準：教育部型（句中沒有科目名）是資料結構限制，不能當基準——
// 用 34% 校準出來的門檻（原本 40%）對正常文件毫無鑑別力。衛福部型（句中寫了科目名卻沒接到）
// 才是該補規則的地方。五份實測：教育部 3/450 = 0.7%、衛福部 85/90 = 94%、其餘近乎 0。
{
    const moeRows = rowsByFile.get('moe-115.pdf') || [];
    const mohwRows = rowsByFile.get('mohw-115.pdf') || [];
    const moe = orphanShape(moeRows), mohw = orphanShape(mohwRows);
    failed += contract(moe.byUnit && moe.nameHitRate < 0.5,
        '教育部型（敘述不按科目寫）被判為資料結構限制，不當門檻基準', JSON.stringify(moe));
    failed += contract(!mohw.byUnit && mohw.nameHitRate > 0.9,
        '衛福部型（句中含科目名卻没接到）不被誤判成資料限制', JSON.stringify(mohw));
    failed += contract((orphanShape(rowsByFile.get('motc-115.pdf') || [])).total === 0,
        '交通部零孤兒句');
}


{
    const ctx = loadTool(html);

    // (1) CDN 程式庫要有 SRI＋crossorigin：CDN 被換內容時瀏覽器必須拒絕執行
    const sriOf = src => {
        const tag = html.match(new RegExp(`<script[^>]*${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'i'));
        return tag ? /integrity="sha384-[^"]+"/.test(tag[0]) && /crossorigin=/.test(tag[0]) : null;
    };
    const pdfSri = sriOf('pdf.js/2.10.377/pdf.min.js');
    const xlsxSri = sriOf('xlsx/0.18.5/xlsx.full.min.js');
    failed += contract(pdfSri && xlsxSri, 'CDN 程式庫都有 SRI + crossorigin', `pdf.js=${JSON.stringify(pdfSri)} xlsx=${JSON.stringify(xlsxSri)}`);

    // (2) 狀態與錯誤訊息要讓螢幕報讀器唸得出來；靜態按鈕都要明確 type=button
    const a11yOk = /id="statusMessageU"[^>]*role="status"/.test(html) && /aria-live="polite"/.test(html)
        && /id="errorOutputU"[^>]*role="alert"/.test(html);
    const btns = html.match(/<button(?![^>]*type=)[^>]*>/g) || [];
    failed += contract(a11yOk && btns.length === 0, '狀態／錯誤訊息有 aria-live 與 role，按鈕都有 type=button', `缺少 role 的訊息=${!a11yOk}，沒有 type 的按鈕=${btns.length}`);

    // (3) 四層驗算只有一支：未歸戶說明列（有金額、也帶 l1Code）不得被算進二級。
    //     這正是 run.mjs 舊複本用 `else` 會出錯、而 index.html 與 test.mjs 不會的形狀。
    const orphanLike = [
        { level: '用途別一級', planCode: 'P', branchCode: '01', l1Code: '1000', amount: '100', planBudget: '100' },
        { level: '用途別二級', planCode: 'P', branchCode: '01', l1Code: '1000', l2Code: '1005', amount: '100' },
        { level: '未歸戶說明', planCode: 'P', branchCode: '01', l1Code: '1000', amount: '999', desc: 'x', orphan: true },
    ];
    failed += contract(ctx._reconcileUnit(orphanLike).badCount === 0 && reconcile(ctx, orphanLike).length === 0,
        '未歸戶說明列不納入四層驗算（有金額、帶 l1Code 也一樣）');

    // (4) 真的對不上時：要報在「一級」這一層，且只有上層列會被標紅（二級列不跟著標）
    const mismatch = [
        { level: '用途別一級', planCode: 'P', branchCode: '01', l1Code: '1000', amount: '100', planBudget: '100' },
        { level: '用途別二級', planCode: 'P', branchCode: '01', l1Code: '1000', l2Code: '1005', amount: '60' },
    ];
    const rec = ctx._reconcileUnit(mismatch);
    const badKeys = [...rec.badRowKeys];
    failed += contract(rec.badCount === 1 && rec.issues[0].level === '用途別一級'
        && badKeys.length === 1 && badKeys[0] === 'P|01|1000',
        '對不上時只標紅上層列，二級列不跟著標紅', JSON.stringify({ badCount: rec.badCount, badKeys }));

    // (5) 查核規則本身的負向測試：故意弄壞，必須抓到
    const fragBad = [
        { level: '分支計畫', planCode: 'P', branchCode: '01', amount: '100',
          descFrags: [{ t: '這句有歸戶。', matched: true }, { t: '這句被標成已歸戶、卻沒有出現在任何一列。', matched: true }] },
        { level: '用途別二級', planCode: 'P', branchCode: '01', l2Code: '1005', amount: '100', desc: '這句有歸戶。' },
    ];
    failed += contract(narrativeVisibility({ _unitDesc: r => r.desc || '' }, fragBad).lost.length === 1,
        '說明文字消失會被查到（負向測試）');

    const factBad = [
        { level: '用途別二級', planCode: 'P', branchCode: '01', l2Code: '1005', l2Name: '法定編制人員待遇', amount: '100', desc: '與本科目無關的句子。', nameMatched: true },
        { level: '用途別二級', planCode: 'P', branchCode: '01', l2Code: '1040', l2Name: '加班費', amount: '500', desc: '超時工作加班費 40,613千元，不休假加班費 25,976千元。', sumMatched: true },
    ];
    const factGood = [
        { level: '用途別二級', planCode: 'P', branchCode: '01', l2Code: '1040', l2Name: '加班費', amount: '66589', desc: '加班費 66,589千元（超時 40,613千元、不休假 25,976千元）。', nameMatched: true },
        { level: '用途別二級', planCode: 'P', branchCode: '01', l2Code: '1040', l2Name: '加班費', amount: '66589', desc: '超時工作加班費 40,613千元，不休假加班費 25,976千元。', sumMatched: true },
    ];
    const factIssues = factClaimIssues(factBad);
    failed += contract(factIssues.length === 2 && factClaimIssues(factGood).length === 0,
        '白底事實級標記無法自證會被查到（負向測試）', JSON.stringify(factIssues.map(x => x.kind)));

    failed += contract(acctCodeIssues(ctx, [{ l2Code: '9999', l2Name: '不存在的科目' }]).length === 1
        && acctCodeIssues(ctx, [{ l2Code: '6005', l2Name: '第一預備金' }]).length === 0,
        '非官方科目代碼會被查到（含已補上的 6005 第一預備金）');
}

// (6) 解析世代：切換機關規則時，先開始、後完成的舊解析不得蓋掉新結果，也不得把舊規則的
//     資料標成新規則的名稱（原本完成訊息讀的是「當下的」_unitProfile）。
{
    const ctx = loadTool(html);
    const els = {};
    const el = id => (els[id] = els[id] || { style: {}, textContent: '', innerHTML: '', disabled: false, files: { length: 0 }, value: '', addEventListener() { } });
    ctx.document = { getElementById: el, querySelectorAll: () => [], createElement: () => el('x') };
    ctx.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({}), destroy() { } }) };
    // 頂層 let（_unitData／_unitProfile）是 script 的語彙宣告，不會成為 ctx 的屬性，
    // 直接寫 ctx._unitData 只會多一個沒人讀的全域屬性——必須用 runInContext 設值。
    vm.runInContext('_unitData = new Uint8Array([1,2,3])', ctx);   // 假裝已經有檔案，不必碰 input
    ctx.parseAgencyPlanTable = async () => ({ pages: 0, map: new Map() });
    const rendered = [];
    ctx._renderUnitPlan = rows => rendered.push(rows);
    const rowsOf = tag => [{ level: '用途別二級', planCode: 'P', branchCode: '01', l2Code: '1005', l2Name: '法定編制人員待遇', amount: '1', desc: tag }];
    let calls = 0;
    ctx.parseUnitDoc = async () => {
        const n = ++calls;
        await new Promise(r => setTimeout(r, n === 1 ? 60 : 5));   // 第一次慢、第二次快
        return rowsOf(`call${n}`);
    };

    vm.runInContext("_unitProfile = 'edu'", ctx);
    const first = ctx.parseUnitPlanPdf();
    await new Promise(r => setTimeout(r, 5));                   // 讓第一次解析真的開始跑
    vm.runInContext("_unitProfile = 'motc'", ctx);
    const second = ctx.parseUnitPlanPdf();
    await Promise.all([first, second]);

    const lastRender = rendered[rendered.length - 1] || [];
    const unitRows = vm.runInContext('_unitRows', ctx);
    const ok = rendered.length === 1 && lastRender[0] && lastRender[0].desc === 'call2'
        && unitRows[0] && unitRows[0].desc === 'call2'
        && /交通部/.test(els.statusMessageU.textContent) && els.extractBtnU.disabled === false;
    failed += contract(ok, '舊解析不得蓋掉新結果，完成訊息要用該次解析的機關規則', JSON.stringify({ renders: rendered.length, msgs: els.statusMessageU.textContent }));
}

if (failed) {
    console.error(`\n${failed} 份不符。若為刻意調整規則，請一併更新 test.mjs 的 EXPECT 與 README 數字。`);
    process.exit(1);
}
console.log('\n全部通過。');
