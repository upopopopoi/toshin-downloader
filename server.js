const express = require('express');
const { chromium } = require('playwright');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// セッション一時保存（メモリ上）
const sessions = {};

// ステップ1: ログイン試行（2段階認証コードの送信をトリガー）
app.post('/api/login-step1', async (req, res) => {
    const { userId, password } = req.body;

    if (!userId || !password) {
        return res.status(400).json({ error: 'IDとパスワードを入力してください。' });
    }

    try {
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        console.log("ログインページへ移動中...");
        await page.goto('https://www.toshin-kakomon.com/login.php', { waitUntil: 'networkidle' });

        await page.fill('input[name="id"]', userId);
        await page.fill('input[name="pass"]', password);
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForTimeout(3000); // 遷移待ち

        // ログイン状態または2段階認証要求の判定
        const currentUrl = page.url();
        const content = await page.content();

        // 既にログイン成功している場合（2段階認証がスキップされた場合）
        if (!currentUrl.includes('login') && !content.includes('認証コード') && !content.includes('code')) {
            const cookies = await context.cookies();
            await browser.close();
            const sessionId = Date.now().toString();
            sessions[sessionId] = { cookies, userId };
            return res.json({ requiresOtp: false, sessionId });
        }

        // 2段階認証が必要な場合、ブラウザコンテキストを維持（セッションIDを生成）
        const sessionId = Date.now().toString();
        sessions[sessionId] = { browser, context, page, userId };

        // 5分後に自動セッション破棄（タイムアウト対策）
        setTimeout(() => {
            if (sessions[sessionId] && sessions[sessionId].browser) {
                sessions[sessionId].browser.close().catch(() => {});
                delete sessions[sessionId];
            }
        }, 300000);

        return res.json({ requiresOtp: true, sessionId, message: '2段階認証コードを入力してください。' });

    } catch (error) {
        console.error("Step1 Error:", error);
        res.status(500).json({ error: `ログイン処理失敗: ${error.message}` });
    }
});

// ステップ2: 認証コード入力・PDF一括取得
app.post('/api/download-step2', async (req, res) => {
    const { sessionId, otpCode, university, subject } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(400).json({ error: 'セッションが期限切れです。最初からやり直してください。' });
    }

    try {
        let { page, context, browser } = session;

        // 2段階認証コード入力が必要な場合
        if (otpCode && page) {
            console.log("2段階認証コードを入力中...");
            // 東進のコード入力欄（input[name="code"] / input[type="text"]等）に入力
            const codeInput = await page.$('input[name="code"], input[name="auth_code"], input[type="text"]');
            if (codeInput) {
                await codeInput.fill(otpCode);
                await page.click('input[type="submit"], button[type="submit"]');
                await page.waitForLoadState('networkidle');
            }
        }

        console.log(`検索中: ${university} ${subject}`);
        const searchUrl = `https://www.toshin-kakomon.com/search.php?univ=${encodeURIComponent(university)}&subject=${encodeURIComponent(subject || '')}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle' });

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
