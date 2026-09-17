// 三支 node 工具（test.mjs／run.mjs／audit.mjs）共用的載入器與查核規則。
//
// 為什麼要收在一支：本專案開頭就寫明「驗證腳本一旦自行複寫解析或驗算規則，就會與實際行為
// 漂移而得出失真結論」——但實際上四層驗算曾經同時存在四份實作（index.html 內嵌、test.mjs、
// run.mjs、audit.mjs），而 run.mjs 那份已經漂移：它用 `else` 累加，任何非分支／非一級的列
// 只要有金額就被算進二級，未歸戶說明列若帶著 l1Code 就會產生幻影不符。
// 現在規則只有兩處：解析與驗算的判準在 index.html（由工具自己呼叫），查核的算法在這裡。
import vm from 'node:vm';

// 在 vm 沙箱中執行 index.html 的 inline <script>（取最長的那段＝工具本體；頁面另有 GA 等短腳本）
export function loadTool(html, { quiet = false } = {}) {
    const js = html.split('<script>').slice(1).map(s => s.split('</script>')[0])
        .reduce((a, b) => b.length > a.length ? b : a)
        .replace(/pdfjsLib\.GlobalWorkerOptions[^\n]*\n/, '');
    const stub = { files: { length: 0 }, style: {}, value: '', textContent: '', innerHTML: '', options: [], addEventListener() { }, querySelectorAll: () => [] };
    const ctx = {
        console: quiet ? { log() { }, warn() { }, error() { }, info() { }, debug() { } } : console,
        document: { getElementById: () => stub, querySelectorAll: () => [], createElement: () => stub },
        window: {}, XLSX: {}, pdfjsLib: { GlobalWorkerOptions: {} },
        URL: { createObjectURL: () => '', revokeObjectURL() { } }, Blob: function () { },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    return ctx;
}

// ── 四層驗算（二級→一級→分支→工作計畫） ──
// 判準在 index.html 的 _reconcileUnit()，此處只是殼：不在驗證腳本裡重寫一次。
export function reconcile(ctx, rows) {
    return ctx._reconcileUnit(rows).issues;
}

export const issueText = i => `${i.level} ${i.key}：表列 ${i.listed} ≠ Σ下層 ${i.sum}`;

// ── 敘述零遺失 ──
// 每個切出來的句子都必須出現在「使用者看得到的地方」：分支列的總述、某個科目列的說明、
// 或未歸戶句自己的列。這條守的是本工具的核心承諾（說明不因為歸戶失敗而消失）——
// 過去確實發生過「句子被標成已歸戶、卻沒有任何一列顯示它」而無聲消失。
// 「看得到」用的是 index.html 自己的 _unitDesc()／_branchOverview()，與畫面、匯出一致。
export function narrativeVisibility(ctx, rows) {
    const norm = s => String(s || '').replace(/<[^>]{1,4}>/g, '').replace(/[\s　]/g, '');
    const lost = [];
    let frags = 0;
    const branches = new Map();
    for (const r of rows) {
        const k = r.planCode + '|' + r.branchCode;
        if (!branches.has(k)) branches.set(k, []);
        branches.get(k).push(r);
    }
    for (const [k, grp] of branches) {
        const br = grp.find(r => r.level === '分支計畫');
        if (!br) continue;
        const pool = grp.map(r => norm(ctx._unitDesc(r))).filter(Boolean).join('\u0001');
        for (const f of br.descFrags || []) {
            frags++;
            const t = norm(f.t);
            if (!t) continue;
            if (!pool.includes(t.slice(0, 12))) lost.push({ branch: k, text: t, matched: !!f.matched });
        }
    }
    return { frags, lost };
}

// ── 事實級標記必須自證 ──
// 工具把歸戶分成「事實（白底）」與「推論（黃底）」，使用者被要求只信任白底。既然它敢標成
// 事實，就要能被機器獨立驗證；這四條規則的挑選演算法不在此複寫，只驗證它的斷言：
//   nameMatched：句中必須同時出現本科目名與本科目金額
//   sumMatched ：句中必須有一組數字（多重集合，允許同值相加）加總等於本科目金額
//   multiSum   ：同上（規則取的是各句代表值，必為句中數字的子集，故子集和必成立）
//   comboMatched：comboSplit 列出的成員金額和必須等於 comboSum，且句中真的出現 comboSum
// 沒有列總數上限的約束（這份語料最多 12 個數字），所以子集和用 2^n DFS 加節點上限。
const amountsOf = s => [...String(s || '').matchAll(/([\d,]+)千元/g)].map(m => +m[1].replace(/,/g, ''));

function subsetSumsTo(nums, target) {
    const a = nums.filter(x => x > 0 && x <= target);
    if (a.length > 22) return null;              // 太大就放棄驗證（回 null＝不判定，不誤報）
    let found = false, nodes = 0;
    const dfs = (i, sum) => {
        if (found || nodes > 500000 || sum > target) return;
        nodes++;
        if (sum === target) { found = true; return; }
        if (i >= a.length) return;
        dfs(i + 1, sum + a[i]);
        dfs(i + 1, sum);
    };
    dfs(0, 0);
    return found;
}

const fmtAmt = n => (+n).toLocaleString('en-US');

export function factClaimIssues(rows) {
    const v = [];
    const add = (kind, r, extra) => v.push({ kind, detail: `${r.planCode}/${r.branchCode}/${r.l2Code || r.l1Code} 第 ${r.page || '?'} 頁 ${extra}` });
    for (const r of rows) {
        const desc = r.desc || '';
        if (r.nameMatched) {
            const nm = r.l2Name || r.l1Name || '';
            if (!nm || !desc.includes(nm)) add('事實（名稱＋金額）句中没有科目名', r, `「${nm}」`);
            else if (!desc.includes(fmtAmt(r.amount) + '千元')) add('事實（名稱＋金額）句中没有本科目金額', r, `${r.amount}`);
        }
        if (r.sumMatched || r.multiSum) {
            const kind = r.sumMatched ? '事實（單句加總）' : '事實（多句加總）';
            const nums = amountsOf(desc);
            if (!nums.length) add(`${kind}的說明抽不到金額`, r, `desc「${desc.slice(0, 30)}」`);
            else if (!nums.includes(+r.amount) && subsetSumsTo(nums, +r.amount) !== true) {
                add(`${kind}句中金額加總不等於本科目金額`, r, `句中 [${nums}] ≠ ${r.amount}`);
            }
        }
        if (r.comboMatched) {
            const parts = String(r.comboSplit || '').split('＋').map(s => +String(s).replace(/[^\d]/g, ''));
            const sum = parts.reduce((a, b) => a + b, 0);
            if (sum !== +r.comboSum) add('合併數分攤明細加總≠合併數', r, `${r.comboSplit} = ${sum}，comboSum=${r.comboSum}`);
            else if (!amountsOf(desc).includes(+r.comboSum)) add('合併數句中找不到該合併金額', r, `${r.comboSum}`);
        }
    }
    return v;
}

// ── 科目代碼必須是官方「歲出用途別科目分類定義」的代碼 ──
// 官方清單在 index.html 的 _ACCT；不在清單裡的代碼不會被名稱校正，只能沿用 PDF 的寫法，
// 而且可能代表解析把代碼讀錯了。實測五份語料只有一個（6005 第一預備金，已補進 _ACCT）。
export function acctCodeIssues(ctx, rows) {
    const known = code => !!ctx._acctName(code);
    const v = [];
    for (const r of rows) {
        if (r.l1Code && !known(r.l1Code)) v.push({ kind: '一級科目代碼不在官方清單', detail: `${r.l1Code} ${r.l1Name || ''}` });
        if (r.l2Code && !known(r.l2Code)) v.push({ kind: '二級科目代碼不在官方清單', detail: `${r.l2Code} ${r.l2Name || ''}` });
        if (r.l1Code && !/^\d{4}$/.test(r.l1Code)) v.push({ kind: '一級科目代碼非 4 碼', detail: r.l1Code });
        if (r.l2Code && !/^\d{4}$/.test(r.l2Code)) v.push({ kind: '二級科目代碼非 4 碼', detail: r.l2Code });
        if (r.l1Code && !/000$/.test(r.l1Code)) v.push({ kind: '一級科目代碼未以 000 結尾', detail: `${r.l1Code} ${r.l1Name || ''}` });
    }
    return v;
}
