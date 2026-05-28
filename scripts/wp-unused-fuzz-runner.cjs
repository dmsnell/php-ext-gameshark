#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(path.join(__dirname, '..', 'wordpress-develop', 'node_modules', 'playwright'));

const runDir = process.env.RUN_DIR;
const base = process.env.BASE_URL;
const callbackPort = Number(process.env.CALLBACK_PORT || 0);
const durationSeconds = Number(process.env.DURATION_SECONDS || 60);
const smokeOnly = process.env.SMOKE_ONLY === '1';

if (!runDir || !base) {
  console.error('RUN_DIR and BASE_URL are required');
  process.exit(2);
}

const logsDir = path.join(runDir, 'logs');
const workersDir = path.join(logsDir, 'workers');
const responseDir = path.join(logsDir, 'api-responses');
const screenshotsDir = path.join(runDir, 'screenshots');
for (const dir of [logsDir, workersDir, responseDir, screenshotsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ids = JSON.parse(fs.readFileSync(path.join(runDir, 'ids.json'), 'utf8'));
const privateManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.private.json'), 'utf8'));
const credentials = privateManifest.credentials || {};
const runId = ids.run_id || `gs-${Date.now()}`;
const deadline = Date.now() + durationSeconds * 1000;
let stopping = false;
let heavyBusy = Promise.resolve();

const coverage = {
  started_at: new Date().toISOString(),
  smoke_only: smokeOnly,
  frontend_urls: {},
  admin_screens: {},
  rest_routes: {},
  xmlrpc_methods: {},
  ajax_actions: {},
  roles: {},
  outcomes: {},
  mutations: {},
  phase_markers: [],
};

function now() {
  return new Date().toISOString();
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/([?&](?:_wpnonce|nonce)=)[^&]+/gi, '$1[REDACTED_NONCE]')
    .replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED_AUTH]');
}

function appendJsonl(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function log(worker, event) {
  const row = { ts: now(), worker, ...event };
  appendJsonl(path.join(workersDir, `${worker}.jsonl`), row);
  appendJsonl(path.join(logsDir, 'events.jsonl'), row);
}

function increment(bucket, key) {
  coverage[bucket][key] = (coverage[bucket][key] || 0) + 1;
}

function markOutcome(status) {
  increment('outcomes', status);
}

function saveCoverage() {
  coverage.updated_at = now();
  fs.writeFileSync(path.join(runDir, 'coverage.json'), JSON.stringify(coverage, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function active() {
  return !stopping && Date.now() < deadline;
}

async function withHeavy(worker, label, fn) {
  let release;
  const previous = heavyBusy;
  heavyBusy = new Promise((resolve) => { release = resolve; });
  await previous;
  coverage.phase_markers.push({ ts: now(), worker, phase: label });
  saveCoverage();
  try {
    return await fn();
  } finally {
    release();
  }
}

function safeUrl(urlPath) {
  if (urlPath.startsWith('http://127.0.0.1:') || urlPath.startsWith('http://localhost:')) {
    return urlPath;
  }
  return new URL(urlPath, base).href;
}

async function screenshot(page, worker, name) {
  try {
    const file = path.join(screenshotsDir, `${Date.now()}-${worker}-${name}.png`.replace(/[^A-Za-z0-9_.-]/g, '-'));
    await page.screenshot({ path: file, fullPage: false, timeout: 5000 });
    return file;
  } catch {
    return null;
  }
}

async function goto(page, worker, urlPath, options = {}) {
  const url = safeUrl(urlPath);
  const start = Date.now();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeout || 45000 });
    const status = response ? response.status() : 0;
    const routeKey = new URL(url).pathname + (options.keySuffix || '');
    if (worker.startsWith('frontend')) increment('frontend_urls', routeKey);
    if (url.includes('/wp-admin/')) increment('admin_screens', new URL(url).pathname);
    log(worker, { action: 'goto', url: redact(url), status, elapsed_ms: Date.now() - start, outcome: status >= 500 ? 'server_error' : 'success' });
    markOutcome(status >= 500 ? 'server_error' : 'success');
    return response;
  } catch (error) {
    const shot = await screenshot(page, worker, 'goto-failure');
    log(worker, { action: 'goto', url: redact(url), outcome: 'timeout', error: String(error.message || error), screenshot: shot, elapsed_ms: Date.now() - start });
    markOutcome('timeout');
    return null;
  }
}

async function dismissChrome(page) {
  for (const selector of [
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    'button:has-text("Dismiss")',
    'button:has-text("No thanks")',
    'button:has-text("Skip")',
  ]) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 750 })) await locator.click({ timeout: 1000 });
    } catch {}
  }
  try { await page.keyboard.press('Escape'); } catch {}
}

async function login(browser, role) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const cred = credentials[role];
  if (!cred) return { context, page };
  try {
    await goto(page, `login-${role}`, '/wp-login.php');
    await page.locator('#user_login').fill(cred.username, { timeout: 10000 });
    await page.locator('#user_pass').fill(cred.password, { timeout: 10000 });
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      page.locator('#wp-submit').click(),
    ]);
    await goto(page, `login-${role}`, '/wp-admin/');
    increment('roles', role);
    await context.storageState({ path: path.join(runDir, 'cookies', `${role}.json`) });
    log(`login-${role}`, { action: 'login', role, outcome: 'success' });
  } catch (error) {
    log(`login-${role}`, { action: 'login', role, outcome: 'auth_blocked', error: String(error.message || error) });
    markOutcome('auth_blocked');
  }
  return { context, page };
}

function authHeader() {
  const appPass = credentials.app_password;
  if (!appPass || !credentials.admin) return {};
  const token = Buffer.from(`${credentials.admin.username}:${appPass}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function apiCall(worker, method, urlPath, options = {}) {
  const url = safeUrl(urlPath);
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    log(worker, { action: 'api', method, url: redact(url), outcome: 'blocked_non_loopback' });
    return null;
  }
  const headers = { ...(options.auth ? authHeader() : {}), ...(options.headers || {}) };
  const start = Date.now();
  try {
    const response = await fetch(url, { method, headers, body: options.body, redirect: options.redirect || 'follow', signal: AbortSignal.timeout(options.timeout || 15000) });
    const body = Buffer.from(await response.arrayBuffer());
    const outFile = path.join(responseDir, `${Date.now()}-${worker}-${method}-${parsed.pathname.replace(/[^A-Za-z0-9]/g, '-')}.body`);
    fs.writeFileSync(outFile, body.subarray(0, 512 * 1024));
    if (parsed.pathname.includes('/wp-json/')) increment('rest_routes', `${method} ${parsed.pathname}`);
    if (parsed.pathname.includes('admin-ajax.php')) increment('ajax_actions', String(parsed.searchParams.get('action') || 'missing'));
    log(worker, { action: 'api', method, url: redact(url), status: response.status, elapsed_ms: Date.now() - start, bytes: body.length, body_file: outFile, auth: Boolean(options.auth), outcome: response.status >= 500 ? 'server_error' : 'success' });
    markOutcome(response.status >= 500 ? 'server_error' : 'success');
    return { status: response.status, body: body.toString('utf8') };
  } catch (error) {
    log(worker, { action: 'api', method, url: redact(url), outcome: 'timeout', error: String(error.message || error), elapsed_ms: Date.now() - start });
    markOutcome('timeout');
    return null;
  }
}

function form(data) {
  return new URLSearchParams(data).toString();
}

async function frontendWorker(browser) {
  const { context, page } = await login(browser, 'anonymous');
  const postId = ids.posts.hello;
  const commentPostId = ids.posts.comment_rich || postId;
  const urls = [
    '/', `/?p=${postId}`, `/${runId}-hello-world/`, '/not-found-gameshark/',
    `/?p=${ids.posts.password}`, `/?p=${ids.posts.private}`,
    `/?page_id=${ids.pages.parent}`, `/?page_id=${ids.pages.child}`,
    '/feed/', '/?feed=rss2', '/comments/feed/', '/wp-sitemap.xml', '/robots.txt',
    '/?s=hello', '/?s=%3Cscript%3Ealert(1)%3C/script%3E', '/?s=',
    '/?m=202605', '/?year=2026', '/?monthnum=5', '/?author=1',
    `/?cat=${ids.terms.news}`, '/?tag=alpha', '/?paged=2', '/?error=404',
    `/?p=${postId}&embed=true`, `/wp-json/oembed/1.0/embed?url=${encodeURIComponent(`${base}/?p=${postId}`)}`,
    `/?attachment_id=${Object.values(ids.media || {})[0] || 0}`,
  ];
  let i = 0;
  while (active()) {
    await goto(page, 'frontend', urls[i++ % urls.length]);
    if (i % 7 === 0) {
      await goto(page, 'frontend', `/?p=${commentPostId}`);
      try {
        await page.locator('#comment').fill(`Gameshark fuzz comment ${Date.now()} <b>HTML</b> 'SQL'`, { timeout: 3000 });
        await page.locator('#author').fill(`GS ${Date.now()}`, { timeout: 1000 }).catch(() => {});
        await page.locator('#email').fill(`gs-${Date.now()}@example.test`, { timeout: 1000 }).catch(() => {});
        await page.locator('#submit').click({ timeout: 3000 });
        increment('mutations', 'anonymous_comment');
        log('frontend', { action: 'comment-submit', post_id: commentPostId, outcome: 'success' });
      } catch (error) {
        log('frontend', { action: 'comment-submit', post_id: commentPostId, outcome: 'expected_error', error: String(error.message || error) });
        markOutcome('expected_error');
      }
    }
    await sleep(1500 + Math.random() * 2500);
    if (smokeOnly && i > 4) break;
  }
  await context.close();
}

async function adminLightWorker(browser) {
  const { context, page } = await login(browser, 'admin');
  const screens = [
    '/wp-admin/', '/wp-admin/edit.php', '/wp-admin/post-new.php', '/wp-admin/edit.php?post_type=page',
    '/wp-admin/upload.php', '/wp-admin/media-new.php', '/wp-admin/edit-comments.php',
    '/wp-admin/users.php', '/wp-admin/user-new.php', '/wp-admin/options-general.php',
    '/wp-admin/options-discussion.php', '/wp-admin/options-permalink.php',
    '/wp-admin/tools.php', '/wp-admin/export.php', '/wp-admin/site-health.php',
    '/wp-admin/privacy.php', '/wp-admin/erase-personal-data.php', '/wp-admin/export-personal-data.php',
  ];
  let i = 0;
  while (active()) {
    await goto(page, 'admin-light', screens[i++ % screens.length]);
    await dismissChrome(page);
    if (i % 6 === 0) {
      await apiCall('admin-light', 'POST', '/wp-json/wp/v2/posts', {
        auth: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ title: `${runId} REST draft ${Date.now()}`, content: '<p>REST-created draft</p>', status: 'draft' }),
      });
      increment('mutations', 'rest_post_create');
    }
    await sleep(2000 + Math.random() * 3000);
    if (smokeOnly && i > 3) break;
  }
  await context.close();
}

async function editorHeavyWorker(browser) {
  const { context, page } = await login(browser, 'editor');
  let count = 0;
  while (active()) {
    await withHeavy('editor-heavy', 'gutenberg', async () => {
      await goto(page, 'editor-heavy', '/wp-admin/post-new.php', { timeout: 60000 });
      await dismissChrome(page);
      try {
        const title = `${runId} editor ${Date.now()}`;
        const titleInput = page.locator('.editor-post-title__input, textarea[aria-label="Add title"], input[name="post_title"]').first();
        await titleInput.fill(title, { timeout: 10000 });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+T' : 'Control+Alt+T').catch(() => {});
        await page.keyboard.type('Paragraph from Playwright with <tag> and quoted SQL text.');
        const buttons = page.getByRole('button', { name: /save draft|publish|update/i });
        await buttons.first().click({ timeout: 8000 }).catch(() => {});
        increment('mutations', 'editor_attempt');
        log('editor-heavy', { action: 'editor-create', title, outcome: 'success' });
      } catch (error) {
        log('editor-heavy', { action: 'editor-create', outcome: 'selector_failure', error: String(error.message || error), screenshot: await screenshot(page, 'editor-heavy', 'editor') });
        markOutcome('selector_failure');
      }
      await goto(page, 'editor-heavy', '/wp-admin/revision.php').catch(() => {});
    });
    count++;
    await sleep(15000 + Math.random() * 15000);
    if (smokeOnly || count > 16) break;
  }
  await context.close();
}

async function mediaWorker(browser) {
  const { context, page } = await login(browser, 'admin');
  const fixture = path.join(runDir, 'fixtures', `document-${runId}.txt`);
  let count = 0;
  while (active()) {
    await withHeavy('media', 'media', async () => {
      await goto(page, 'media', '/wp-admin/media-new.php');
      await dismissChrome(page);
      await apiCall('media', 'POST', '/wp-json/wp/v2/media', {
        auth: true,
        headers: { 'Content-Disposition': `attachment; filename=rest-${Date.now()}.txt`, 'Content-Type': 'text/plain' },
        body: fs.readFileSync(fixture),
      });
      await goto(page, 'media', '/wp-admin/upload.php?mode=list');
      await goto(page, 'media', `/?attachment_id=${Object.values(ids.media || {})[0] || 0}`);
      increment('mutations', 'media_upload_attempt');
    });
    count++;
    await sleep(20000 + Math.random() * 15000);
    if (smokeOnly || count > 14) break;
  }
  await context.close();
}

async function apiWorker() {
  const postId = ids.posts.hello;
  const endpoints = [
    '/wp-json/', '/wp-json/wp/v2', '/wp-json/wp/v2/posts?context=view&_embed=1&per_page=5',
    `/wp-json/wp/v2/posts/${postId}?context=view`, `/wp-json/wp/v2/posts/${postId}?context=embed`,
    '/wp-json/wp/v2/pages?context=view&_embed=1', '/wp-json/wp/v2/comments?context=view',
    '/wp-json/wp/v2/media?context=view', '/wp-json/wp/v2/users?context=view',
    '/wp-json/wp/v2/search?context=view&search=hello&type=post',
    '/wp-json/wp/v2/block-types', '/wp-json/wp/v2/themes',
    '/wp-json/wp/v2/settings', '/wp-json/gameshark-fixture/v1/ping',
    '/wp-admin/load-scripts.php?c=0&load%5Bchunk_0%5D=jquery-core,utils&ver=6.9',
    '/wp-admin/load-styles.php?c=0&load%5Bchunk_0%5D=common,forms&ver=6.9',
    '/wp-cron.php?doing_wp_cron=1',
  ];
  let i = 0;
  while (active()) {
    const endpoint = endpoints[i++ % endpoints.length];
    await apiCall('api', 'GET', endpoint, { auth: endpoint.includes('/settings') || endpoint.includes('/themes') });
    if (i % 5 === 0) {
      await apiCall('api', 'OPTIONS', '/wp-json/wp/v2/posts');
      await apiCall('api', 'POST', '/wp-admin/admin-ajax.php', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ action: i % 10 === 0 ? 'gameshark_fixture_ajax' : 'unknown_gameshark_action', data: 'value' }),
      });
      await apiCall('api', 'POST', '/wp-admin/admin-post.php', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ action: 'gameshark_fixture_post' }),
      });
      await apiCall('api', 'POST', `/wp-json/wp/v2/posts/${postId}`, {
        auth: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ excerpt: `REST updated ${Date.now()}`, comment_status: 'open' }),
      });
    }
    await sleep(1200 + Math.random() * 1800);
    if (smokeOnly && i > 8) break;
  }
}

function xmlPayload(method, params = '') {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params}</params></methodCall>`;
}

function xmlString(value) {
  return `<param><value><string>${String(value).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</string></value></param>`;
}

async function xmlrpcWorker() {
  const admin = credentials.admin || { username: 'admin', password: '' };
  const target = `${base}/?p=${ids.posts.hello}`;
  const source = `http://127.0.0.1:${callbackPort}/source-links-target.html?target=${encodeURIComponent(target)}`;
  const methods = [
    ['system.listMethods', ''],
    ['wp.getUsersBlogs', xmlString(admin.username) + xmlString(admin.password)],
    ['wp.getPosts', xmlString('1') + xmlString(admin.username) + xmlString(admin.password)],
    ['pingback.ping', xmlString(source) + xmlString(target)],
    ['pingback.ping', xmlString(`http://127.0.0.1:${callbackPort}/missing-link`) + xmlString(target)],
  ];
  let i = 0;
  while (active()) {
    const [method, params] = methods[i++ % methods.length];
    increment('xmlrpc_methods', method);
    await apiCall('xmlrpc', 'POST', '/xmlrpc.php', {
      headers: { 'Content-Type': 'text/xml' },
      body: xmlPayload(method, params),
      timeout: 12000,
    });
    await apiCall('xmlrpc', 'POST', `/wp-trackback.php?p=${ids.posts.hello}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ url: `http://127.0.0.1:${callbackPort}/trackback-source`, title: `${runId} trackback`, blog_name: 'Gameshark', excerpt: 'loopback trackback excerpt' }),
      timeout: 12000,
    });
    await sleep(5000 + Math.random() * 5000);
    if (smokeOnly && i > 2) break;
  }
}

async function themePluginWorker(browser) {
  const { context, page } = await login(browser, 'admin');
  let count = 0;
  while (active()) {
    await withHeavy('theme-plugin', 'theme-plugin', async () => {
      await goto(page, 'theme-plugin', '/wp-admin/plugins.php');
      await dismissChrome(page);
      try {
        const href = await page.locator('tr[data-slug="gameshark-fixture"] a:has-text("Activate"), tr[data-slug="gameshark-fixture"] a:has-text("Deactivate")').first().getAttribute('href', { timeout: 5000 });
        if (href) await goto(page, 'theme-plugin', href.startsWith('http') || href.startsWith('/') ? href : `/wp-admin/${href}`, { timeout: 20000 });
      } catch {}
      await goto(page, 'theme-plugin', '/wp-admin/options-general.php?page=gameshark-fixture', { timeout: 20000 });
      await goto(page, 'theme-plugin', '/wp-admin/theme-install.php?search=twenty', { timeout: 20000 });
      await goto(page, 'theme-plugin', '/wp-admin/themes.php', { timeout: 20000 });
      await goto(page, 'theme-plugin', '/wp-admin/customize.php?return=%2Fwp-admin%2Fthemes.php', { timeout: 15000 });
      await goto(page, 'theme-plugin', '/wp-admin/site-editor.php', { timeout: 15000 });
      await apiCall('theme-plugin', 'GET', '/wp-json/wp/v2/themes?status=active', { auth: true });
      await apiCall('theme-plugin', 'GET', '/wp-json/wp/v2/templates', { auth: true });
      increment('mutations', 'theme_plugin_phase');
    });
    count++;
    await sleep(45000 + Math.random() * 20000);
    if (smokeOnly || count > 8) break;
  }
  await context.close();
}

async function authLifecycleWorker(browser) {
  const { context, page } = await login(browser, 'subscriber');
  let count = 0;
  while (active()) {
    await goto(page, 'auth', '/wp-login.php?action=lostpassword');
    await goto(page, 'auth', '/wp-login.php?action=register');
    await goto(page, 'auth', '/wp-admin/');
    await goto(page, 'auth', '/wp-login.php?action=logout');
    await login(browser, 'subscriber');
    count++;
    await sleep(30000 + Math.random() * 20000);
    if (smokeOnly || count > 6) break;
  }
  await context.close();
}

function startCallbackServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${callbackPort}`);
    log('callback', { action: 'request', path: url.pathname, query: redact(url.search), outcome: 'success' });
    if (url.pathname === '/slow') {
      setTimeout(() => { res.end('slow'); }, 2000);
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/source-links-target.html' });
      res.end();
      return;
    }
    if (url.pathname === '/error') {
      res.writeHead(500);
      res.end('error');
      return;
    }
    if (url.pathname === '/source-links-target.html') {
      const target = url.searchParams.get('target') || base;
      res.end(`<html><body><a href="${target}">target</a></body></html>`);
      return;
    }
    if (url.pathname === '/oembed-provider') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: '1.0', type: 'rich', html: '<p>embed</p>' }));
      return;
    }
    res.end('<html><body>missing target link</body></html>');
  });
  server.listen(callbackPort, '127.0.0.1');
  return server;
}

async function adaptiveReviewer() {
  let cycle = 0;
  while (active()) {
    await sleep(smokeOnly ? 5000 : 300000);
    cycle++;
    const summary = {
      cycle,
      elapsed_seconds: Math.round((Date.now() - (deadline - durationSeconds * 1000)) / 1000),
      frontend_url_count: Object.keys(coverage.frontend_urls).length,
      admin_screen_count: Object.keys(coverage.admin_screens).length,
      rest_route_count: Object.keys(coverage.rest_routes).length,
      xmlrpc_method_count: Object.keys(coverage.xmlrpc_methods).length,
      outcomes: coverage.outcomes,
      suggestions: [],
    };
    if (!coverage.admin_screens['/wp-admin/upload.php']) summary.suggestions.push('queue media library grid/list coverage');
    if (!coverage.rest_routes['GET /wp-json/wp/v2/settings']) summary.suggestions.push('queue authenticated settings REST probes');
    if (!coverage.xmlrpc_methods['pingback.ping']) summary.suggestions.push('queue loopback pingback probes');
    if (!coverage.frontend_urls['/wp-sitemap.xml']) summary.suggestions.push('queue sitemaps and robots front-door sweep');
    appendJsonl(path.join(logsDir, 'review-loop.log'), { ts: now(), ...summary });
    saveCoverage();
    console.log(`[review] cycle=${cycle} frontend=${summary.frontend_url_count} admin=${summary.admin_screen_count} rest=${summary.rest_route_count} xmlrpc=${summary.xmlrpc_method_count}`);
    if (smokeOnly) break;
  }
}

async function main() {
  const callbackServer = startCallbackServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  const hardStop = setTimeout(() => {
    stopping = true;
    log('runner', { action: 'hard-stop', outcome: 'success', duration_seconds: durationSeconds });
    saveCoverage();
    browser.close().catch(() => {});
    setTimeout(() => {
      log('runner', { action: 'forced-exit', outcome: 'success' });
      saveCoverage();
      process.exit(0);
    }, 30000).unref();
  }, Math.max(5000, durationSeconds * 1000 + 30000));

  try {
    const tasks = [
      frontendWorker(browser),
      adminLightWorker(browser),
      editorHeavyWorker(browser),
      mediaWorker(browser),
      themePluginWorker(browser),
      authLifecycleWorker(browser),
      apiWorker(),
      xmlrpcWorker(),
      adaptiveReviewer(),
    ];
    await Promise.race([
      Promise.allSettled(tasks),
      sleep(Math.max(5000, durationSeconds * 1000 + 45000)),
    ]);
  } finally {
    clearTimeout(hardStop);
    stopping = true;
    saveCoverage();
    await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
    await Promise.race([new Promise((resolve) => callbackServer.close(resolve)), sleep(5000)]);
  }
}

main().catch((error) => {
  console.error(error);
  log('runner', { action: 'fatal', outcome: 'environment_blocker', error: String(error.stack || error) });
  saveCoverage();
  process.exit(1);
});
