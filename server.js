const express = require('express');
const { chromium } = require('playwright');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sessions = {};

// ステップ1: ログイン
app.post('/api/login-step1', async (req, res) => {
    const { userId, password } = req.body;
    if (!userId || !password) return res.status(400).json({ error: 'IDとパスワードを入力してください。' });

    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
        const page = await context.newPage();

        await page.goto('https://www.toshin.com/member/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

        await page.locator('#email, input[name="email"]').fill(userId);
        await page.locator('#password, input[name="password"], input[type="password"]').fill(password);
        
        const submitBtn = page.locator('button[type="submit"], input[type="submit"]');
        if (await submitBtn.count() > 0) await submitBtn.click();
        else await page.keyboard.press('Enter');

        await page.waitForTimeout(4000);
        const sessionId = Date.now().toString();
        sessions[sessionId] = { browser, context, page, userId };

        setTimeout(() => {
            if (sessions[sessionId]?.browser) sessions[sessionId].browser.close().catch(() => {});
            delete sessions[sessionId];
        }, 300000); // 5分でセッション切れ

        return res.json({ sessionId, message: '2段階認証コードと大学名を入力してください。' });
    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: `ログイン処理失敗: ${error.message}` });
    }
});

// ステップ2: 認証コード入力 ＆ 大学ページへ移動・年度取得
app.post('/api/search-univ', async (req, res) => {
    const { sessionId, otpCode, university } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(400).json({ error: 'セッション切れです。再読込してください。' });

    try {
        let { page } = session;

        // OTP入力
        if (otpCode) {
            const codeInput = page.locator('input[type="text"], input[type="number"]').first();
            if (await codeInput.count() > 0) {
                await codeInput.fill(otpCode);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(3000);
            }
        }

        await page.goto('https://www.toshin-kakomon.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 【改善】クリックで移動せず、hrefを取得して直接URL移動する（タイムアウト回避）
        const univUrl = await page.evaluate((u) => {
            const link = Array.from(document.querySelectorAll('a')).find(a => a.innerText.includes(u));
            return link ? link.href : null;
        }, university);

        if (!univUrl) return res.status(404).json({ error: `「${university}」が見つかりません。` });
        await page.goto(univUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 【改善】年度のリンクだけを厳密に抽出（ゴミリンク排除）
        const years = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            document.querySelectorAll('a').forEach(a => {
                const text = a.innerText.trim();
                // 「2023年」「2023年度」などのテキストのみ許可
                if (/^(19|20)\d{2}年?度?$/.test(text) && !seen.has(a.href)) {
                    seen.add(a.href);
                    results.push({ text, url: a.href });
                }
            });
            return results;
        });

        if (years.length === 0) years.push({ text: '全年度（年度選択なし）', url: page.url() });
        return res.json({ years });

    } catch (error) {
        res.status(500).json({ error: `大学検索エラー: ${error.message}` });
    }
});

// ステップ3: 学部・日程の取得
app.post('/api/get-faculties', async (req, res) => {
    const { sessionId, yearUrl } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(400).json({ error: 'セッション切れです。' });

    try {
        let { page } = session;
        await page.goto(yearUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 【改善】ゴミテキストを徹底的に弾き、学部名らしきものだけを抽出
        const faculties = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            const garbage = ['東進', 'ログイン', 'ログアウト', 'ホーム', '利用', '規約', '個人', 'プライバシー', 'TOP', '一覧', '戻る', '検索', '会社', 'お問い合わせ', '大学'];
            
            document.querySelectorAll('a').forEach(a => {
                const text = a.innerText.trim();
                // 短すぎる/長すぎる/ゴミワードを含む/年度テキストは除外
                if (text.length >= 2 && text.length <= 30 && !garbage.some(g => text.includes(g)) && !/^(19|20)\d{2}/.test(text)) {
                    if (!seen.has(text) && a.href.startsWith('http')) {
                        seen.add(text);
                        results.push({ text, url: a.href });
                    }
                }
            });
            return results;
        });

        if (faculties.length === 0) faculties.push({ text: 'このページの全PDFを取得', url: page.url() });
        return res.json({ faculties });

    } catch (error) {
        res.status(500).json({ error: `学部取得エラー: ${error.message}` });
    }
});

// ステップ4: PDF一括ダウンロード
app.post('/api/download-final', async (req, res) => {
    const { sessionId, facultyUrl } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(400).json({ error: 'セッション切れです。' });

    try {
        let { page, context, browser } = session;
        await page.goto(facultyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // PDFのリンク（問題、解答など）を抽出
        const pdfLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*=".pdf"], a[href*="download"]'))
                .map(a => ({ title: a.innerText.trim() || 'paper', url: a.href }));
        });

        if (pdfLinks.length === 0) {
            await browser.close();
            delete sessions[sessionId];
            return res.status(404).json({ error: 'PDFが見つかりませんでした。' });
        }

        res.attachment('toshin_kakomon.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const [i, link] of pdfLinks.entries()) {
            try {
                const pdfRes = await context.request.get(link.url);
                const buffer = await pdfRes.body();
                const safeTitle = linkおっと、ごめんなさい！どうやら直前までのやり取りの文脈がこちらでリセットされてしまったようです。

画像の特定の模様を消す加工や、B4見開きPDFの分割・補正といった作業のことでしょうか？ 確かにこれまで一緒に色々とやってきましたね。

お手数ですが、どの作業の続きだったか、もう一度教えてもらえませんか？
