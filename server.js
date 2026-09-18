const express = require('express');
const { chromium } = require('playwright');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sessions = {};

// ステップ1: ログイン試行
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

        console.log("東進トップページへ移動中...");
        // 東進のトップページへアクセス
        await page.goto('https://www.toshin-kakomon.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ページ内のすべての input 要素から ID / パスワード欄を特定
        const inputs = await page.$$('input');
        let idFilled = false;
        let passFilled = false;

        for (const input of inputs) {
            const type = await input.getAttribute('type');
            const name = await input.getAttribute('name') || '';

            if (!idFilled && (type === 'text' || type === 'email' || name.includes('id') || name.includes('user'))) {
                await input.fill(userId);
                idFilled = true;
            } else if (!passFilled && type === 'password') {
                await input.fill(password);
                passFilled = true;
            }
        }

        if (!idFilled || !passFilled) {
            throw new Error('ログイン入力欄が見つかりませんでした。');
        }

        // フォーム送信
        const submitBtn = await page.$('input[type="submit"], button[type="submit"], input[type="image"]');
        if (submitBtn) {
            await submitBtn.click();
        } else {
            await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(5000);

        const currentUrl = page.url();
        const content = await page.content();

        const sessionId = Date.now().toString();
        sessions[sessionId] = { browser, context, page, userId };

        // 5分後に自動セッション破棄
        setTimeout(() => {
            if (sessions[sessionId] && sessions[sessionId].browser) {
                sessions[sessionId].browser.close().catch(() => {});
                delete sessions[sessionId];
            }
        }, 300000);

        // 2段階認証が必要かどうかの判定
        const requiresOtp = content.includes('認証') || content.includes('コード') || content.includes('OTP');

        return res.json({ requiresOtp, sessionId, message: requiresOtp ? '2段階認証コードを入力してください。' : 'ログイン成功' });

    } catch (error) {
        console.error("Step1 Error:", error);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: `ログイン処理失敗: ${error.message}` });
    }
});

// ステップ2: 認証コード入力・一括取得
app.post('/api/download-step2', async (req, res) => {
    const { sessionId, otpCode, university, subject } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(400).json({ error: 'セッションが期限切れです。最初からやり直してください。' });
    }

    try {
        let { page, context, browser } = session;

        if (otpCode && page) {
            console.log("2段階認証コードを入力中...");
            const inputs = await page.$$('input');
            for (const input of inputs) {
                const type = await input.getAttribute('type');
                if (type === 'text' || type === 'number') {
                    await input.fill(otpCode);
                    break;
                }
            }
            const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
            if (submitBtn) await submitBtn.click();
            await page.waitForTimeout(4000);
        }

        console.log(`検索中: ${university} ${subject}`);
        const searchUrl = `https://www.toshin-kakomon.com/search.php?univ=${encodeURIComponent(university)}&subject=${encodeURIComponent(subject || '')}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const pdfLinks = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*=".pdf"]'));
            return anchors.map(a => ({
                title: a.innerText.trim() || 'kakomon',
                url: a.href
            }));
        });

        if (pdfLinks.length === 0) {
            if (browser) await browser.close();
            delete sessions[sessionId];
            return res.status(404).json({ error: '該当する過去問PDFが見つかりませんでした。大学名や教科名を確認してください。' });
        }

        res.attachment(`${university}_${subject || '過去問'}.zip`);
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
        console.error("Step2 Error:", error);
        if (session && session.browser) await session.browser.close().catch(() => {});
        delete sessions[sessionId];
        res.status(500).json({ error: `内部処理エラー: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
