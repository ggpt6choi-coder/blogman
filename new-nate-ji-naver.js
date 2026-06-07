require('dotenv').config();
const { chromium } = require('playwright');
const { logWithTime } = require('./common');
const { naverLogin } = require('./common-write');
const { loadNewsList, appendErrorLog } = require('./new-common');
const { writeNaverPost } = require('./new-common-write');
const { defaultMap } = require('./new-category-maps');

const SHOW_BROWSER = false;

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || true;

  const browser = await chromium.launch({ headless: !SHOW_BROWSER, args: ['--no-sandbox'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  page.on('dialog', async d => { await d.accept().catch(()=>null); });

  logWithTime('start');
  const feedsConfig = require('./new-feeds-config');
  const cfg = feedsConfig.nate_ji;
  const id = process.env[cfg.idEnv];
  const pw = process.env[cfg.pwEnv];
  await naverLogin(page, id, pw);
  logWithTime('login done');

  const newsList = await loadNewsList({ remoteUrl: cfg.remoteUrl, localPath: cfg.localPath }).catch(e=>{ console.error(e); return []; });

  let errCount = 0;
  for (let i = 0; i < newsList.length; i++) {
    const news = newsList[i];
    if (!news || !news.newTitle || !news.newArticle) continue;
    const blogData = {
      page,
      blogName: process.env[cfg.blogEnv],
      title: news.newTitle || news.title,
      content: news.newArticle,
      url: news.url || news.link,
      hashTag: news.hashTag,
      type: news.type,
      idx: i,
      dryRun: dryRun,
      options: { typeMap: require('./new-category-maps')[cfg.typeMap || 'defaultMap'] }
    };
    try {
      await writeNaverPost(blogData);
    } catch (err) {
      errCount++;
      const msg = `[${new Date().toISOString()}] [writeNaverPost error] idx:${i} title:${news.title}\n${err && err.stack?err.stack:err}`;
      console.error(msg);
      appendErrorLog(msg);
    }
  }

  logWithTime(`done (errors: ${errCount}/${newsList.length})`);
  await browser.close();
})();
