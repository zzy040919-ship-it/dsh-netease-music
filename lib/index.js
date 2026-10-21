import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 网易云音乐播放器：搜索 / 详情 / 直链代理 / 歌词 / 账号 / 读取客户端当前歌曲。 */
const ROUTE = '/dsh-netease-music';
const ORIGIN = 'https://music.163.com';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  referer: ORIGIN + '/',
};
const PAID_FEES = new Set([1, 4]);
const SEARCH_LIMIT = 12;
const COVER_HOST = /(^|\.)music\.126\.net$/i;
const AUDIO_HOST = /(^|\.)music\.(126\.net|163\.com)$/i;
const TITLE_HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'client-title.ps1');
const KEY_HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'net-cookie-key.ps1');
const execFileAsync = promisify(execFile);

function settingsPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-netease-music.json');
}

function readSettings() {
  try { return JSON.parse(readFileSync(settingsPath(), 'utf8')) || {}; } catch { return {}; }
}

function writeSettings(next) {
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}

function trace(message) {
  try {
    const file = join(process.env.TEMP || '.', 'dsh-netease-music.log');
    writeFileSync(file, new Date().toISOString() + ' ' + message + '\n', { flag: 'a' });
  } catch { /* diagnostics only */ }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65536) { req.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function headers(extra) {
  const cookie = readSettings().cookie;
  return cookie ? { ...HEADERS, cookie: String(cookie), ...extra } : { ...HEADERS, ...extra };
}

function artistNames(artists) {
  return (Array.isArray(artists) ? artists : [])
    .map((artist) => (artist && artist.name ? String(artist.name) : ''))
    .filter(Boolean)
    .join(' / ');
}

async function readJson(url) {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) throw new Error('http ' + response.status);
  return response.json();
}

async function searchSongs(query) {
  const encoded = encodeURIComponent(query);
  const attempts = [
    ORIGIN + '/api/search/get?s=' + encoded + '&type=1&limit=' + SEARCH_LIMIT + '&offset=0',
    ORIGIN + '/api/search/get/web?csrf_token=&type=1&limit=' + SEARCH_LIMIT + '&offset=0&s=' + encoded,
  ];
  let songs = [];
  for (const url of attempts) {
    try {
      const body = await readJson(url);
      // 被风控时 result 会是一段加密字符串，而不是对象
      if (body && body.result && Array.isArray(body.result.songs)) { songs = body.result.songs; break; }
    } catch (error) {
      trace('search failed: ' + (error && error.message ? error.message : error));
    }
  }
  trace('search "' + query + '" -> ' + songs.length);
  return songs.map((song) => ({
    id: String(song.id),
    name: String(song.name || ''),
    artist: artistNames(song.artists),
    album: String((song.album && song.album.name) || ''),
    duration: Math.round((Number(song.duration) || 0) / 1000),
    paid: PAID_FEES.has(Number(song.fee)),
  }));
}

const CDN_HOSTS = ['m701', 'm702', 'm703', 'm801', 'm802', 'm803', 'm800', 'm804', 'm704', 'm805'];
let cdnHost = '';

/** 网易云 CDN 会按域名随机调度，个别 m* 节点在本地不通：换一个能通的节点再播放。 */
async function playableCdn(url) {
  let target;
  try { target = new URL(url); } catch (error) { return url; }
  if (!/\.music\.126\.net$/.test(target.hostname)) return url;
  const origin = target.hostname.split('.')[0];
  const candidates = [cdnHost, origin, ...CDN_HOSTS].filter((item, index, all) => item && all.indexOf(item) === index);
  for (const host of candidates) {
    const candidate = 'http://' + host + '.music.126.net' + target.pathname + target.search;
    try {
      const response = await fetch(candidate, { headers: headers({ range: 'bytes=0-1023' }), signal: AbortSignal.timeout(5000) });
      const type = String(response.headers.get('content-type') || '');
      const range = response.headers.get('content-range');
      try { await response.arrayBuffer(); } catch (error) { /* ignore */ }
      if (response.ok && type.startsWith('audio/') && range) {
        cdnHost = host;
        trace('cdn host ok: ' + host + (host === origin ? ' (origin)' : ''));
        return candidate;
      }
    } catch (error) { /* try next */ }
  }
  trace('cdn host probe failed, keeping ' + target.hostname);
  return url;
}

async function streamUrl(id, cookie) {
  if (cookie) {
    const quality = encodeURIComponent(String(readSettings().quality || 'exhigh'));
    const attempts = [
      ORIGIN + '/api/song/enhance/player/url/v1?ids=[' + id + ']&level=' + quality + '&encodeType=mp3',
      ORIGIN + '/api/song/enhance/player/url/v1?ids=[' + id + ']&level=standard&encodeType=mp3',
      ORIGIN + '/api/song/enhance/player/url?ids=[' + id + ']&br=320000',
    ];
    for (const url of attempts) {
      try {
        const body = await readJson(url);
        const playable = body && Array.isArray(body.data) ? body.data[0] : null;
        if (playable && playable.url) {
          trace('streamUrl ok br=' + (playable.br || '?') + ' code=' + (playable.code || '?'));
          return String(playable.url);
        }
        trace('streamUrl rejected: ' + JSON.stringify(body).slice(0, 120));
      } catch (error) {
        trace('streamUrl attempt failed: ' + ((error && error.message) || error));
      }
    }
  }
  const outer = await fetch(ORIGIN + '/song/media/outer/url?id=' + id + '.mp3', { headers: headers(), redirect: 'manual' });
  const location = outer.headers.get('location');
  if (!location || location.includes('/404')) return null;
  const url = new URL(location, ORIGIN).href;
  const probe = await fetch(url, { headers: headers({ range: 'bytes=0-1023' }) });
  const type = String(probe.headers.get('content-type') || '');
  const range = probe.headers.get('content-range');
  await probe.arrayBuffer().catch(() => {});
  if (!type.startsWith('audio/') || !range) return null;
  return url;
}

async function songDetail(id) {
  const body = await readJson(ORIGIN + '/api/song/detail/?ids=[' + encodeURIComponent(id) + ']');
  const song = body && Array.isArray(body.songs) ? body.songs[0] : null;
  if (!song) return { ok: false, reason: 'not-found' };
  const cookie = readSettings().cookie;
  const detail = {
    ok: true,
    id: String(song.id || id),
    name: String(song.name || ''),
    artist: artistNames(song.artists),
    album: String((song.album && song.album.name) || ''),
    cover: String((song.album && song.album.picUrl) || ''),
    duration: Math.round((Number(song.duration) || 0) / 1000),
    paid: PAID_FEES.has(Number(song.fee)),
  };
  if (detail.paid && !cookie) return { ...detail, ok: false, reason: 'paid' };
  const resolved = await streamUrl(detail.id, cookie);
  const url = resolved ? await playableCdn(resolved) : null;
  if (!url) {
    trace('songDetail unplayable: ' + detail.name + ' paid=' + detail.paid + ' cookie=' + Boolean(cookie));
    return { ...detail, ok: false, reason: 'unplayable' };
  }
  trace('songDetail ok: ' + detail.name + ' url=' + String(url).slice(0, 50));
  return { ...detail, url };
}

async function accountOf(cookie) {
  if (!cookie) return { ok: false };
  try {
    const response = await fetch(ORIGIN + '/api/nuser/account/get', { headers: { ...HEADERS, cookie: String(cookie) }, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    trace('accountOf: status=' + response.status + ' len=' + text.length + ' head=' + text.slice(0, 120).replace(/\s+/g, ' '));
    const body = JSON.parse(text);
    const profile = body && body.profile ? body.profile : null;
    if (!profile) return { ok: false };
    return {
      ok: true,
      nickname: String(profile.nickname || ''),
      avatar: String(profile.avatarUrl || ''),
      userId: profile.userId,
    };
  } catch (error) {
    trace('accountOf failed: ' + ((error && error.message) || error));
    return { ok: false };
  }
}

async function proxyCover(res, rawUrl) {
  let target;
  try { target = new URL(rawUrl); } catch { return false; }
  if (target.protocol !== 'https:' || !COVER_HOST.test(target.hostname)) return false;
  const response = await fetch(target.href, { headers: { ...HEADERS } });
  if (!response.ok) return false;
  const buffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    'content-type': response.headers.get('content-type') || 'image/jpeg',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': buffer.length,
  });
  res.end(buffer);
  return true;
}

async function proxyAudio(req, res, rawUrl) {
  let target;
  try { target = new URL(rawUrl); } catch { return false; }
  if (!/^https?:$/.test(target.protocol) || !AUDIO_HOST.test(target.hostname)) return false;
  const input = { ...HEADERS };
  if (req.headers.range) input.range = req.headers.range;
  const upstream = await fetch(target.href, { headers: input });
  const out = {
    'content-type': upstream.headers.get('content-type') || 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
  };
  for (const key of ['content-length', 'content-range']) {
    const value = upstream.headers.get(key);
    if (value) out[key] = value;
  }
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
  return true;
}

async function lyricOf(id) {
  const body = await readJson(ORIGIN + '/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=1&kv=1&tv=-1');
  return {
    ok: Boolean(body && body.lrc && body.lrc.lyric),
    lrc: (body && body.lrc && body.lrc.lyric) || '',
    translation: (body && body.tlyric && body.tlyric.lyric) || '',
  };
}

/** 网易云客户端（CEF）的 cookie 库目录。 */
function neteaseProfileDirs() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const base = join(local, 'Netease', 'CloudMusic');
  const dirs = [];
  try {
    for (const name of readdirSync(base)) {
      if (!name.startsWith('webapp')) continue;
      const dir = join(base, name);
      if (existsSync(join(dir, 'Cookies')) && existsSync(join(dir, 'LocalPrefs.json'))) dirs.push(dir);
    }
  } catch { /* 没装网易云 */ }
  return dirs;
}

async function dpapiKey(prefsPath) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', KEY_HELPER, '-Prefs', prefsPath,
  ], { windowsHide: true });
  const line = String(stdout).trim().split(/\r?\n/).pop();
  const key = Buffer.from(String(line || ''), 'base64');
  return key.length === 32 ? key : null;
}

function decryptCookie(blob, key) {
  if (blob.subarray(0, 3).toString() !== 'v10') return null;
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const cipher = blob.subarray(15, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

/** 从本机网易云客户端读出已登录的 MUSIC_U，校验后写入配置。 */
async function autoLogin() {
  const dirs = neteaseProfileDirs();
  if (!dirs.length) return { ok: false, error: '没找到网易云客户端的登录数据' };
  let sqlite = null;
  try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
  if (!sqlite) return { ok: false, error: '当前宿主不支持读取 cookie 库' };
  for (const dir of dirs) {
    try {
      const key = await dpapiKey(join(dir, 'LocalPrefs.json'));
      if (!key) continue;
      const copy = join(tmpdir(), 'dsh-netease-cookies-' + process.pid + '.db');
      copyFileSync(join(dir, 'Cookies'), copy);
      const db = new sqlite.DatabaseSync(copy, { readOnly: true });
      let rows = [];
      try { rows = db.prepare("SELECT encrypted_value FROM cookies WHERE name = 'MUSIC_U'").all(); } finally { db.close(); }
      if (!rows.length) continue;
      const value = decryptCookie(Buffer.from(rows[0].encrypted_value), key);
      if (!value) continue;
      const account = await accountOf('MUSIC_U=' + value);
      if (!account.ok) continue;
      const next = readSettings();
      next.cookie = 'MUSIC_U=' + value;
      writeSettings(next);
      trace('auto login ok: ' + account.nickname);
      return account;
    } catch (error) {
      trace('auto login failed: ' + (error && error.message ? error.message : error));
    }
  }
  return { ok: false, error: '没读到已登录的网易云账号（先在客户端里登录）' };
}

/** 账号最近播放（客户端没开时的同步来源）。 */
async function recentSongs(limit) {
  const cookie = readSettings().cookie;
  trace('recentSongs: cookie=' + Boolean(cookie));
  if (!cookie) return [];
  const account = await accountOf(cookie);
  trace('recentSongs: account ok=' + Boolean(account.ok) + ' uid=' + (account.userId || ''));
  if (!account.ok || !account.userId) return [];
  let body = null;
  try {
    body = await readJson(ORIGIN + '/api/v1/play/record?uid=' + account.userId + '&type=0&limit=' + limit);
  } catch (error) {
    trace('recentSongs failed: ' + ((error && error.message) || error));
    return [];
  }
  const rows = body && Array.isArray(body.allData) ? body.allData : [];
  trace('recentSongs: rows=' + rows.length + ' code=' + (body && body.code));
  return rows.map((row) => {
    const song = row && row.song ? row.song : {};
    return {
      id: String(song.id || ''),
      name: String(song.name || ''),
      artist: (Array.isArray(song.ar) ? song.ar : []).map((artist) => String((artist && artist.name) || '')).filter(Boolean).join(' / '),
      album: String((song.al && song.al.name) || ''),
      duration: Math.round((Number(song.dt) || 0) / 1000),
      paid: false,
    };
  }).filter((song) => song.id);
}

export const inject = ['webServer'];

export function apply(ctx) {
  let titleChild = null;
  let titleBuffer = '';
  let clientTitle = '';

  function ensureTitleHelper() {
    if (titleChild !== null || process.platform !== 'win32') return;
    try {
      titleChild = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TITLE_HELPER], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      titleChild = null;
      return;
    }
    titleChild.stdout.setEncoding('utf8');
    titleChild.stdout.on('data', (chunk) => {
      titleBuffer += chunk;
      let at;
      while ((at = titleBuffer.indexOf('\n')) !== -1) {
        const line = titleBuffer.slice(0, at).trim();
        titleBuffer = titleBuffer.slice(at + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message && message.t === 'title') clientTitle = String(message.title || '');
        } catch { /* partial line */ }
      }
    });
    titleChild.on('exit', () => { titleChild = null; });
    titleChild.on('error', () => { titleChild = null; });
  }

  async function clientNow() {
    ensureTitleHelper();
    for (let attempt = 0; attempt < 30 && clientTitle === ''; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const raw = clientTitle;
    if (raw) {
      const split = /^(.+?) - (.+)$/.exec(raw);
      return {
        ok: true,
        source: 'client',
        raw,
        title: split ? split[1].trim() : raw,
        artist: split ? split[2].trim() : '',
      };
    }
    // 客户端没开：用账号的最近播放顶上
    try {
      const songs = await recentSongs(20);
      if (songs.length) {
        trace('client-now: client closed, using recent play (' + songs.length + ')');
        return { ok: true, source: 'account', raw: songs[0].name, title: songs[0].name, artist: songs[0].artist, songs };
      }
    } catch (error) {
      trace('recent play failed: ' + ((error && error.message) || error));
    }
    return { ok: false, error: '客户端没开，账号也没有最近播放记录（先在任意一端放一首歌）' };
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname.slice(ROUTE.length);
      const method = req.method || 'GET';

      if (method === 'GET' && path === '/api/search') {
        const query = (url.searchParams.get('q') || '').trim();
        if (!query) return sendJson(res, 400, { ok: false, error: 'missing q' });
        return sendJson(res, 200, { ok: true, songs: await searchSongs(query) });
      }

      if (method === 'GET' && path === '/api/song') {
        trace('api/song request');
        const id = (url.searchParams.get('id') || '').trim();
        if (!/^\d+$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
        return sendJson(res, 200, await songDetail(id));
      }

      if (method === 'GET' && path === '/api/cover') {
        if (await proxyCover(res, url.searchParams.get('u') || '')) return undefined;
        res.writeHead(404);
        return res.end();
      }

      if (method === 'GET' && path === '/api/audio') {
        if (await proxyAudio(req, res, url.searchParams.get('u') || '')) return undefined;
        res.writeHead(404);
        return res.end();
      }

      if (method === 'GET' && path === '/api/lyric') {
        const id = (url.searchParams.get('id') || '').trim();
        if (!/^\d+$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
        return sendJson(res, 200, await lyricOf(id));
      }

      if (method === 'GET' && path === '/api/client-now') {
        if (url.searchParams.get('source') === 'account') {
          try {
            const songs = await recentSongs(30);
            return sendJson(res, 200, songs.length
              ? { ok: true, source: 'account', songs }
              : { ok: false, error: '账号还没有最近播放记录' });
          } catch (error) {
            trace('recent play route failed: ' + ((error && error.message) || error));
            return sendJson(res, 200, { ok: false, error: '读取最近播放失败' });
          }
        }
        return sendJson(res, 200, await clientNow());
      }

      if (method === 'GET' && path === '/api/account/auto') {
        return sendJson(res, 200, await autoLogin());
      }

      if (method === 'GET' && path === '/api/ping') {
        trace('client ping ' + (url.searchParams.get('s') || ''));
        return sendJson(res, 200, { ok: true });
      }

      if (path === '/api/account') {
        if (method === 'GET') return sendJson(res, 200, await accountOf(readSettings().cookie));
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin' });
        if (method === 'DELETE') {
          const next = readSettings();
          delete next.cookie;
          writeSettings(next);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const cookie = body && typeof body.cookie === 'string' ? body.cookie.trim() : '';
          if (!/MUSIC_U=[^;]/.test(cookie)) return sendJson(res, 400, { ok: false, error: 'cookie 里需要 MUSIC_U=...' });
          const account = await accountOf(cookie);
          if (!account.ok) return sendJson(res, 400, { ok: false, error: 'cookie 无效或已过期' });
          const next = readSettings();
          next.cookie = cookie;
          writeSettings(next);
          return sendJson(res, 200, account);
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: String((error && error.message) || error) });
    }
  }

  trace('host apply');
  if (process.platform === 'win32') ensureTitleHelper();
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'dsh-netease-music: routes',
  );

  ctx.effect(() => () => {
    if (titleChild !== null) {
      const current = titleChild;
      titleChild = null;
      current.kill();
    }
  }, 'dsh-netease-music: title helper');
}
