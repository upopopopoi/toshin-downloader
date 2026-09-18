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

        console.log("東進ログインページへ移動中...");
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

        const currentUrl = page.url();
        const content = await page.content();

        const sessionId = Date.now().toString();
        sessions[sessionId] = { browser, context, page, userId };

        setTimeout(() => {
            if (sessions[sessionId] && sessions[sessionId].browser) {
                sessions[sessionId].browser.close().catch(() => {});
                delete sessions[sessionId];
            }
        }, 300000);

        const requiresOtp = content.includes('認証') || content.includes('コード') || content.includes('OTP') || currentUrl.includes('auth');

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

        // 2段階認証コードの入力処理
        if (otpCode && page) {
            console.log("2段階認証コードを入力中...");
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

        console.log(`過去問データベースに遷移中: ${university} ${subject}`);
        
        // 過去問データベースのトップに移動
        await page.goto('https://www.toshin-kakomon.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 検索窓への入力と実行
        const searchInput = page.locator('input[type="text"], input[name*="kw"], input[name*="search"]').first();
        if (await searchInput.count() > 0) {
            const query = `${university} ${subject || ''}`.trim();
            await searchInput.fill(query);
            await searchInput.press('Enter');
            await page.waitForTimeout(4000);
        }

        // PDF リンクの収集
        const pdfLinks = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*=".pdf"], a[href*="download"]'));
            return anchors.map(a => ({
                title: a.innerText.trim() || 'kakomon',
                url: a.href
            }));
        });

        if (pdfLinks.length === 0) {
            if (browser) await browser.close();
            delete sessions[sessionId];
            return res.status(404).json({ error: `「${university} ${subject}」の過去問PDFが見つかりませんでした。` });
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
