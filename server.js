const express = require('express');
const { chromium } = require('playwright');
const archiver = require('archiver');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.post('/api/download', async (req, res) => {
    const { userId, password, university, subject } = req.body;

    if (!userId || !password || !university) {
        return res.status(400).json({ error: '必須項目が不足しています。' });
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        console.log("ログインページへ移動中...");
        await page.goto('https://www.toshin-kakomon.com/login.php', { waitUntil: 'networkidle' });

        await page.fill('input[name="id"]', userId);
        await page.fill('input[name="pass"]', password);
        await page.click('input[type="submit"], button[type="submit"]');
        await page.waitForLoadState('networkidle');

        if (page.url().includes('login.php')) {
            await browser.close();
            return res.status(401).json({ error: 'ログインに失敗しました。IDとパスワードを確認してください。' });
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
            await browser.close();
            return res.status(404).json({ error: '該当する過去問PDFが見つかりませんでした。' });
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
        await browser.close();

    } catch (error) {
        console.error(error);
        if (browser) await browser.close();
        res.status(500).json({ error: '内部処理エラーが発生しました。' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
