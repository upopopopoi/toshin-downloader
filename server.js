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

    if (!userId || !password) {
        return res.status(400).json({ error: 'IDとパスワードを入力してください。' });
    }

    let browser;
    try {
        browser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        await page.goto('https://www.toshin.com/member/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

        const idInput = page.locator('#email, input[name="email"]');
        const passInput = page.locator('#password, input[name="password"], input[type="password"]');

        await idInput.waitFor({ state: 'visible', timeout: 20000 });
        await idInput.fill(userId);

        await passInput.waitFor({ state: 'visible', timeout: 20000 });
        await passInput.fill(password);

        const submitBtn = page.locator('button[type="submit"], input[type="submit"]');
        if (await submitBtn.count() > 0) {
            await submitBtn.click();
        } else {
            await passInput.press('Enter');
        }

        await page.waitForTimeout(5000);

        const sessionId = Date.now().toString();
        sessions[sessionId] = { browser, context, page, userId };

        setTimeout(() => {
            if (sessions[sessionId] && sessions[sessionId].browser) {
                sessions[sessionId].browser.close().catch(() => {});
                delete sessions[sessionId];
            }
        }, 300000);

        return res.json({ sessionId, message: '認証コードと大学名を入力してください。' });

    } catch (error) {
        console.error("Step1 Error:", error);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: `ログイン処理失敗: ${error.message}` });
    }
});

// ステップ2: 認証コード入力 ＆ 選択肢（年度・学部）の動的取得
app.post('/api/get-options', async (req, res) => {
    const { sessionId, otpCode, university } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(400).json({ error: 'セッションが期限切れです。最初からやり直してください。' });
    }

    try {
        let { page } = session;

        // OTP入力
        if (otpCode && page) {
            const codeInput = page.locator('input[type="text"], input[type="number"], input[name*="code"], input[name*="auth"]').first();
            if (await codeInput.count() > 0) {
                await codeInput.fill(otpCode);
                const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
                if (await submitBtn.count() > 0) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
                        submitBtn.click()
                    ]);
                } else {
                    await codeInput.press('Enter');
                }
                await page.waitForTimeout(3000);
            }
        }

        // 過去問トップページ
        await page.goto('https://www.toshin-kakomon.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 大学リンク検索
        const univLink = page.locator(`a:has-text("${university}")`).first();
        if (await univLink.count() === 0) {
            return res.status(404).json({ error: `「${university}」が見つかりませんでした。正式名称で入力してください。` });
        }

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
            univLink.click()
        ]);

        // 大学ページから「年度」と「学部・区分」の選択肢リンクを自動抽出
        const optionsData = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            
            // 年度の抽出（例: 2024年, 2023年など）
            const years = links
                .map(a => a.innerText.trim())
                .filter(text => /\d{4}年?/.test(text));

            // 学部・方式の抽出
            const faculties = links
                .map(a => a.innerText.trim())
                .filter(text => text.includes('類') || text.includes('学部') || text.includes('日程') || text.includes('前期') || text.includes('後期'));

            return {
                years: Array.from(new Set(years)),
                faculties: Array.from(new Set(faculties))
            };
        });

        // 候補がない場合のフォールバック設定
        if (optionsData.years.length === 0) optionsData.years = ['指定なし'];
        if (optionsData.faculties.length === 0) optionsData.faculties = ['全学部/全区分'];

        return res.json(optionsData);

    } catch (error) {
        console.error("Get Options Error:", error);
        res.status(500).json({ error: `選択肢取得エラー: ${error.message}` });
    }
});

// ステップ3: 最終選択によるPDFダウンロード
app.post('/api/download-final', async (req, res) => {
    const { sessionId, university, year, faculty } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(400).json({ error: 'セッションが期限切れです。最初からやり直してください。' });
    }

    try {
        let { page, context, browser } = session;

        if (year && year !== '指定なし') {
            const yearLink = page.locator(`a:has-text("${year}")`).first();
            if (await yearLink.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
                    yearLink.click()
                ]);
            }
        }

        if (faculty && faculty !== '全学部/全区分') {
            const facultyLink = page.locator(`a:has-text("${faculty}")`).first();
            if (await facultyLink.count() > 0) {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
                    facultyLink.click()
                ]);
            }
        }

        // PDFリンク抽出
        const pdfLinks = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*=".pdf"], a[href*="download.php"]'));
            return anchors.map(a => ({
                title: a.innerText.trim() || 'kakomon_paper',
                url: a.href
            }));
        });

        if (pdfLinks.length === 0) {
            if (browser) await browser.close();
            delete sessions[sessionId];
            return res.status(404).json({ error: 'PDFが見つかりませんでした。別の組み合わせを試してください。' });
        }

        res.attachment(`${university}_${year}_${faculty}.zip`);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const [index, link] of pdfLinks.entries()) {
            try {
                const pdfResponse = await context.request.get(link.url);
                const buffer = await pdfResponse.body();
                const safeTitle = link.title.replace(/[\\/:*?"<>|]/g, '_');
                archive.append(buffer, { name: `${index + 1}_${safeTitle}.pdf` });
            } catch (err) {
                console.error(`Download error for ${link.url}:`, err);
            }
        }

        await archive.finalize();
        if (browser) await browser.close();
        delete sessions[sessionId];

    } catch (error) {
        console.error("Download Error:", error);
        if (session && session.browser) await session.browser.close().catch(() => {});
        delete sessions[sessionId];
        res.status(500).json({ error: `内部処理エラー: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
