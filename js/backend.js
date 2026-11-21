// Supabase との接続部分。画面側のコードは、ここで用意した DB / Auth を通してだけデータを扱う。
// データはすべて docs テーブル（col = コレクション名, id = ドキュメントID, data = 中身）に入れ、
// 漫画や挿絵などの画像だけは Storage の pages バケットに置く。
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';

export const configured = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(String(SUPABASE_URL).trim()) && !String(SUPABASE_KEY).startsWith('ここに');
const sb = configured ? createClient(String(SUPABASE_URL).trim().replace(/\/$/, ''), String(SUPABASE_KEY).trim(), {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'spotcreate-auth' }
}) : null;
export const supabase = sb;

const TABLE = 'docs', BUCKET = 'pages';
const split = p => { const i = p.indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
const clone = v => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
const snap = (id, data) => ({ id, exists: data !== undefined && data !== null, data: () => clone(data) });
function dbError(e) {
  const x = new Error((e && e.message) || 'error');
  const msg = String((e && e.message) || '');
  x.detail = [e && e.code, msg].filter(Boolean).join(' ').slice(0, 160);
  x.code = (e && (e.code === '42501' || e.statusCode === '403' || e.status === 403)) || /row-level security|permission|admin only/i.test(msg) ? 'permission-denied'
    : (e && (e.status === 429 || e.code === '429')) ? 'resource-exhausted' : (e && e.code) || 'unknown';
  return x;
}

// ---------- 画像（pages コレクション）は Storage に置く ----------
function dataUrlToBlob(u) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(u || ''); if (!m) return null;
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: m[1] });
}
async function putImage(id, d) {
  if (!d || typeof d.data !== 'string' || !d.data.startsWith('data:')) return d;
  const blob = dataUrlToBlob(d.data); if (!blob) return d;
  const { error } = await sb.storage.from(BUCKET).upload(id, blob, { upsert: true, contentType: blob.type, cacheControl: '31536000' });
  if (error) throw dbError(error);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(id);
  return { ...d, data: data.publicUrl + '?v=' + Date.now() };
}

// ---------- 読み書き ----------
async function readDoc(col, id) {
  const { data, error } = await sb.from(TABLE).select('data').eq('col', col).eq('id', id).maybeSingle();
  if (error) throw dbError(error);
  return data ? data.data : undefined;
}
async function readCol(col, cons) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(TABLE).select('id,data').eq('col', col);
    for (const c of cons) if (c.t === 'where' && c.op === '==') q = q.eq('data->>' + c.f, String(c.v));
    const { data, error } = await q.order('id').range(from, from + 999);
    if (error) throw dbError(error);
    out.push(...data);
    if (data.length < 1000) break;
  }
  let docs = out.map(r => snap(r.id, r.data));
  for (const c of cons) if (c.t === 'order') docs.sort((a, b) => { const x = a.data()[c.f], y = b.data()[c.f]; return (x > y ? 1 : x < y ? -1 : 0) * (c.d === 'desc' ? -1 : 1); });
  return { docs, size: docs.length, empty: !docs.length };
}

// ---------- 変更の通知（Realtime ＋ 念のための定期確認） ----------
const listeners = new Set();
const channels = {};
const timers = {};
function refresh(col, delay = 250) {
  clearTimeout(timers[col]);
  timers[col] = setTimeout(() => { for (const l of listeners) if (l.col === col) l.run(); }, delay);
}
function watch(col) {
  if (channels[col] || !sb) return;
  channels[col] = sb.channel('docs-' + col)
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'col=eq.' + col }, () => refresh(col))
    .subscribe();
}
setInterval(() => { if (document.visibilityState !== 'visible') return; const cols = new Set([...listeners].map(l => l.col)); cols.forEach(c => refresh(c, 0)); }, 120000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { const cols = new Set([...listeners].map(l => l.col)); cols.forEach(c => refresh(c, 0)); } });

function listen(col, fetcher, next, err) {
  const l = { col, run: async () => { try { next(await fetcher()); } catch (e) { console.warn(col, e); err && err(e); } } };
  listeners.add(l); watch(col); l.run();
  return () => listeners.delete(l);
}

function mkDoc(path) {
  const [col, id] = split(path);
  return {
    id, path,
    get: async () => snap(id, await readDoc(col, id)),
    set: async d => {
      const data = col === 'pages' ? await putImage(id, d) : d;
      const { error } = await sb.from(TABLE).upsert({ col, id, data: clone(data) }, { onConflict: 'col,id' });
      if (error) throw dbError(error); refresh(col, 0);
    },
    update: async d => {
      const cur = await readDoc(col, id); if (cur === undefined) { const e = new Error('not found'); e.code = 'not-found'; throw e; }
      const { error } = await sb.from(TABLE).update({ data: { ...cur, ...clone(d) } }).eq('col', col).eq('id', id);
      if (error) throw dbError(error); refresh(col, 0);
    },
    delete: async () => {
      const { error } = await sb.from(TABLE).delete().eq('col', col).eq('id', id);
      if (error) throw dbError(error);
      if (col === 'pages') { try { await sb.storage.from(BUCKET).remove([id]); } catch (e) {} }
      refresh(col, 0);
    },
    onSnapshot: (next, err) => listen(col, async () => snap(id, await readDoc(col, id)), next, err)
  };
}
function mkQuery(path, cons = []) {
  return {
    path,
    where: (f, op, v) => mkQuery(path, [...cons, { t: 'where', f, op, v }]),
    orderBy: (f, d) => mkQuery(path, [...cons, { t: 'order', f, d }]),
    limit: () => mkQuery(path, cons),
    get: () => readCol(path, cons),
    onSnapshot: (next, err) => listen(path, () => readCol(path, cons), next, err),
    doc: id => mkDoc(path + '/' + id)
  };
}
export const DB = { doc: mkDoc, collection: p => mkQuery(p) };

// ---------- ログイン（見る人も投稿する人も、裏で自動的に「ゲスト」として入る） ----------
let current = null;
const toUser = s => s && s.user ? { uid: s.user.id, email: s.user.email || '', isAnonymous: !!s.user.is_anonymous } : null;
export const Auth = {
  onChange(fn) {
    let last;
    // supabase-js の決まりで、このコールバックの中から直接ほかの呼び出しをしないよう、ひと呼吸おいて渡す
    const { data } = sb.auth.onAuthStateChange((ev, s) => {
      const u = toUser(s), key = u ? u.uid : '';
      current = u;
      if (key === last) return; last = key;
      setTimeout(() => fn(u), 0);
    });
    return () => data.subscription.unsubscribe();
  },
  anon: async () => { const { error } = await sb.auth.signInAnonymously(); if (error) throw error; },
  isAnon: () => !!(current && current.isAnonymous),
  linkGoogle: async () => { const e = new Error('unsupported'); e.code = 'unsupported'; throw e; },
  signOut: () => sb.auth.signOut(),
  current: () => current
};

export function authErrorText(e) {
  const msg = String((e && (e.message || e.code)) || '');
  if (/anonymous sign-ins are disabled/i.test(msg)) return 'ゲストとしてはじめる設定が有効になっていません。運営に連絡してください（Supabase の Authentication で「Allow anonymous sign-ins」をオンにする必要があります）。';
  if (/rate limit|too many|429/i.test(msg) || (e && e.status === 429)) return 'いま利用する人が集中しています。少し時間をおいて、もう一度お試しください。';
  if (/fetch|network/i.test(msg)) return '通信できませんでした。インターネット接続を確かめてください。';
  return 'うまくいきませんでした。通信状況を確かめて、もう一度お試しください。';
}
