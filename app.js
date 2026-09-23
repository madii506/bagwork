'use strict';
/* bagwork — the board lives on-chain.
   Every action is a Solana transaction that touches the escrow wallet and carries a memo
   starting with "bagwork|v1|". The site reads the escrow's history from a public RPC and
   rebuilds the board from those memos. No server, no database. */
(() => {
const CFG = Object.assign({
  CA: '',        // $BAGWORK mint address, set at launch
  X_URL: '',     // project X link, set at launch
  ESCROW: 'JCvG38CpUVY6Xbigkrn43NVJKZ2ANAaoAWfMSuwokKGE', // escrow wallet public key
  RPCS: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
  TAG: 'bagwork|v1|',
  MAX_PAGES: 5,
  REFRESH_MS: 20000
}, window.BW_CFG || {});

let W = window.solanaWeb3;
const MEMO_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const LPS = 1e9;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const XRE = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/i;
const VRE = /^https:\/\/(?:(?:www\.|m\.)?tiktok\.com\/@[A-Za-z0-9_.]{2,24}\/video\/\d+|(?:www\.)?youtube\.com\/shorts\/[A-Za-z0-9_-]{6,20}|youtu\.be\/[A-Za-z0-9_-]{6,20})(?:[/?#].*)?$/i;
const TYPES = {
  raid:   { name: 'raids',   does: 'like, RT and reply on the tweet the dev names.', proof: 'the link to your reply' },
  meme:   { name: 'memes',   does: 'cook an original meme for the coin and post it.', proof: 'the link to your post with the meme' },
  thread: { name: 'threads', does: 'write a thread that actually explains the coin.', proof: 'the link to the first post of the thread' },
  video:  { name: 'videos',  does: 'tiktoks, shorts, edits. cut it and post it.', proof: 'a tiktok, youtube short or X video link' }
};
const MARK = document.getElementById('mark-tpl').innerHTML;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');

/* ---------- small helpers ---------- */
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const short = a => a ? (a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a) : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sol = l => { const v = l / LPS; return (Math.round(v * 10000) / 10000).toLocaleString('en-US', { maximumFractionDigits: 4 }); };
const dash = (n, f = x => x) => (n ? f(n) : '<span class="dash" title="nothing yet — a dash is not a zero">—</span>');
function safeUrl(u) { u = str(u, 200); return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ''; }
function ago(ts) {
  if (!ts) return 'just now';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
}
function dur(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + x + 's';
}
function usd(n) { if (n == null) return ''; const a = Math.abs(n); return '$' + (a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0)); }
const tx = s => 'https://solscan.io/tx/' + encodeURIComponent(s);
const acct = a => 'https://solscan.io/account/' + encodeURIComponent(a);
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
function toast(msg, bad, html) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  if (html) t.innerHTML = msg; else t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 4200);
}
async function copy(v) {
  try { await navigator.clipboard.writeText(v); }
  catch (e) { const t = document.createElement('textarea'); t.value = v; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e2) {} t.remove(); }
  toast('copied · ' + short(v));
}

/* ---------- chain reads ---------- */
async function rpc(method, params) {
  let last;
  for (const url of CFG.RPCS) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (r.status === 429) { last = new Error('rate limited'); await sleep(600 * (a + 1)); continue; }
        if (!r.ok) throw new Error('rpc ' + r.status);
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      } catch (e) { last = e; break; }
    }
  }
  throw last || new Error('rpc unavailable');
}
async function pool(items, n, fn) {
  let i = 0; const errs = [];
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { errs.push(e); } }
  }));
  return errs;
}
function parseTx(sig, t) {
  if (!t || !t.meta || t.meta.err) return null;
  const msg = t.transaction.message;
  const keys = msg.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
  const ixs = [...msg.instructions];
  (t.meta.innerInstructions || []).forEach(g => ixs.push(...g.instructions));
  let memo = null; const tr = [];
  for (const ix of ixs) {
    if ((ix.program === 'spl-memo' || ix.programId === MEMO_ID) && typeof ix.parsed === 'string' && ix.parsed.startsWith(CFG.TAG) && !memo) memo = ix.parsed;
    if (ix.program === 'system' && ix.parsed && ix.parsed.type === 'transfer') tr.push({ from: ix.parsed.info.source, to: ix.parsed.info.destination, l: Number(ix.parsed.info.lamports) || 0 });
  }
  if (!memo) return null;
  let m; try { m = JSON.parse(memo.slice(CFG.TAG.length)); } catch (e) { return null; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  return { sig, slot: t.slot || 0, time: t.blockTime || 0, signer: keys[0], m, tr };
}

const S = { recs: new Map(), newest: null, bal: null, synced: false, syncing: false, err: null, dex: {}, dexAt: 0, syncedAt: 0 };
const CK = 'bw:' + CFG.ESCROW;
(function loadCache() {
  if (!CFG.ESCROW) return;
  const c = LS.get(CK);
  if (c && Array.isArray(c.recs)) { c.recs.forEach(r => r && r.sig && S.recs.set(r.sig, r)); S.newest = c.newest || null; }
})();
function saveCache() {
  const recs = [...S.recs.values()].filter(r => r && !r.skip).slice(-3000);
  LS.set(CK, { newest: S.newest, recs });
}

const intro = { t0: performance.now(), ready: false, done: false };
function introStep(p, txt) {
  const b = $('#intro-bar'), s = $('#intro-step'), c = $('#intro-pct');
  if (b) b.style.width = p + '%'; if (c) c.textContent = p + '%'; if (s && txt) s.textContent = txt;
}
function introReady(txt) {
  if (intro.ready) return; intro.ready = true;
  setTimeout(() => { introStep(100, txt); const g = $('#intro-go'); if (g) { g.disabled = false; g.focus({ preventScroll: true }); } }, Math.max(0, 1400 - (performance.now() - intro.t0)));
}
function enterSite() {
  if (intro.done) return; intro.done = true;
  const el = $('#intro'); document.body.classList.remove('locked');
  if (!el) return; el.classList.add('out'); setTimeout(() => el.remove(), 700);
}
async function sync() {
  if (!CFG.ESCROW || S.syncing) return;
  S.syncing = true;
  if (!intro.ready) introStep(60, 'reading the escrow from the chain…');
  try {
    const b = await rpc('getBalance', [CFG.ESCROW, { commitment: 'confirmed' }]);
    S.bal = b.value;
    const sigs = []; let before;
    for (let p = 0; p < CFG.MAX_PAGES; p++) {
      const o = { limit: 1000, commitment: 'confirmed' };
      if (before) o.before = before;
      if (S.newest) o.until = S.newest;
      const page = await rpc('getSignaturesForAddress', [CFG.ESCROW, o]);
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const want = sigs.filter(s => !s.err && s.memo && s.memo.includes(CFG.TAG) && !S.recs.has(s.signature));
    let missing = 0;
    const errs = await pool(want, 4, async s => {
      const t = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!t) { missing++; return; }
      S.recs.set(s.signature, parseTx(s.signature, t) || { sig: s.signature, skip: true });
    });
    if (!errs.length && !missing && sigs.length) S.newest = sigs[0].signature;
    S.synced = true; S.syncedAt = Date.now(); S.err = errs.length ? 'some transactions did not load, retrying' : null;
    saveCache();
  } catch (e) {
    S.err = (e && e.message) || String(e);
  } finally {
    S.syncing = false;
    derive(); render(true); dexFetch();
    introReady(S.synced ? 'escrow checked. board loaded.' : 'the chain is slow. the board keeps trying inside.');
  }
}

/* ---------- rebuild the board from memos ---------- */
let D = null;
const filled = t => t.proofs.filter(p => p.status === 'approved' || p.status === 'paid').length;
const left = t => Math.max(0, t.n - filled(t));
function derive() {
  const E = CFG.ESCROW;
  const recs = [...S.recs.values()].filter(r => r && !r.skip && r.m).sort((a, b) => (a.slot - b.slot) || (a.time - b.time));
  const coins = new Map(), tasks = new Map(), proofs = new Map(), reqs = new Map(), pays = [], outs = [], ev = [];
  const inTo = (r, to) => r.tr.filter(t => t.to === to && t.from === r.signer).reduce((s, t) => s + t.l, 0);
  const outFrom = (r, to) => r.tr.filter(t => t.from === E && t.to === to).reduce((s, t) => s + t.l, 0);
  for (const r of recs) {
    const m = r.m;
    try {
      switch (m.t) {
        case 'list': {
          const mint = str(m.mint, 44);
          if (!B58.test(mint) || coins.has(mint)) break;
          const c = { mint, name: str(m.name, 32) || 'unnamed', tk: str(m.tk, 12).replace(/^\$/, '').toUpperCase() || '???', d: str(m.d, 140), x: safeUrl(m.x), owner: r.signer, sig: r.sig, time: r.time, funded: 0, paid: 0, out: 0, tasks: [] };
          coins.set(mint, c); ev.push({ k: 'list', r, c }); break;
        }
        case 'fund': {
          const c = coins.get(m.mint); const l = inTo(r, E);
          if (!c || l <= 0) break;
          c.funded += l; ev.push({ k: 'fund', r, c, l }); break;
        }
        case 'task': {
          const c = coins.get(m.mint);
          if (!c || r.signer !== c.owner || !TYPES[m.k]) break;
          const rew = Math.round(Number(m.r) * LPS), n = Math.floor(Number(m.n));
          if (!(rew > 0) || !(n >= 1 && n <= 1000)) break;
          const t = { sig: r.sig, mint: c.mint, c, k: m.k, r: rew, n, txt: str(m.txt, 200), url: safeUrl(m.url), time: r.time, closed: false, proofs: [] };
          tasks.set(r.sig, t); c.tasks.push(t); ev.push({ k: 'task', r, t }); break;
        }
        case 'close': {
          const t = tasks.get(m.task);
          if (t && r.signer === t.c.owner && !t.closed) { t.closed = true; ev.push({ k: 'close', r, t }); }
          break;
        }
        case 'proof': {
          const t = tasks.get(m.task);
          if (!t || t.closed || r.signer === t.c.owner || left(t) <= 0) break;
          if (t.proofs.some(p => p.worker === r.signer && p.status !== 'rejected')) break;
          const url = safeUrl(m.url); if (!url) break;
          const p = { sig: r.sig, t, worker: r.signer, url, x: str(m.x, 16).replace(/^@/, ''), time: r.time, status: 'pending' };
          proofs.set(r.sig, p); t.proofs.push(p); ev.push({ k: 'proof', r, p }); break;
        }
        case 'ok': {
          const p = proofs.get(m.p);
          if (!p || p.status !== 'pending' || r.signer !== p.t.c.owner || left(p.t) <= 0) break;
          p.status = 'approved'; p.okTime = r.time; p.okSig = r.sig; ev.push({ k: 'ok', r, p }); break;
        }
        case 'no': {
          const p = proofs.get(m.p);
          if (!p || p.status !== 'pending' || r.signer !== p.t.c.owner) break;
          p.status = 'rejected'; p.why = str(m.why, 100); p.noSig = r.sig; ev.push({ k: 'no', r, p }); break;
        }
        case 'pay': {
          if (r.signer !== E) break;
          const p = proofs.get(m.p);
          if (!p || p.status !== 'approved') break;
          const l = outFrom(r, p.worker); if (l <= 0) break;
          p.status = 'paid'; p.paySig = r.sig; p.payTime = r.time; p.paid = l; p.t.c.paid += l;
          const x = { sig: r.sig, time: r.time, to: p.worker, l, p }; pays.push(x); ev.push({ k: 'pay', r, x }); break;
        }
        case 'req': {
          const c = coins.get(m.mint);
          if (!c || r.signer !== c.owner) break;
          const l = Math.round(Number(m.sol) * LPS); if (!(l > 0)) break;
          reqs.set(r.sig, { sig: r.sig, c, l, time: r.time, done: false }); ev.push({ k: 'req', r, c, l }); break;
        }
        case 'out': {
          if (r.signer !== E) break;
          const c = coins.get(m.mint); if (!c) break;
          const l = outFrom(r, c.owner); if (l <= 0) break;
          c.out += l; const q = reqs.get(m.req); if (q) q.done = true;
          const x = { sig: r.sig, time: r.time, c, l }; outs.push(x); ev.push({ k: 'out', r, x }); break;
        }
      }
    } catch (e) { /* a malformed memo never breaks the board */ }
  }
  for (const c of coins.values()) {
    c.pool = c.funded - c.paid - c.out; c.owed = 0; c.reserve = 0; c.open = 0;
    for (const t of c.tasks) {
      c.owed += t.proofs.filter(p => p.status === 'approved').length * t.r;
      const lf = left(t);
      if (!t.closed && lf > 0) { c.open++; c.reserve += lf * t.r; }
    }
    c.free = c.pool - c.owed - c.reserve;
  }
  D = { coins, tasks, proofs, reqs, pays, outs, ev };
}
derive();

async function dexFetch() {
  const mints = [...D.coins.keys()]; if (CFG.CA) mints.push(CFG.CA);
  if (!mints.length || Date.now() - S.dexAt < 60000) return;
  S.dexAt = Date.now(); let got = false;
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mints.slice(i, i + 30).join(','));
      const j = await r.json();
      for (const p of (j.pairs || [])) {
        const a = p.baseToken && p.baseToken.address; if (!a) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0, cur = S.dex[a];
        if (!cur || liq >= cur.liq) { S.dex[a] = { liq, mcap: p.marketCap || p.fdv || null, img: safeUrl(p.info && p.info.imageUrl), url: safeUrl(p.url) }; got = true; }
      }
    } catch (e) {}
  }
  if (got) render(true);
}

/* ---------- wallet ---------- */
const wallet = { pk: null, prov: null, name: null };
function providers() {
  const a = [];
  const ph = window.phantom && window.phantom.solana;
  if (ph && ph.isPhantom) a.push({ name: 'Phantom', p: ph });
  if (window.solflare && window.solflare.isSolflare) a.push({ name: 'Solflare', p: window.solflare });
  if (window.backpack && window.backpack.isBackpack) a.push({ name: 'Backpack', p: window.backpack });
  if (!a.length && window.solana && window.solana.connect) a.push({ name: 'wallet', p: window.solana });
  return a;
}
async function connectWith(x, silent) {
  try {
    const r = await x.p.connect(silent ? { onlyIfTrusted: true } : undefined);
    const pk = (r && r.publicKey) || x.p.publicKey;
    if (!pk) throw new Error('no key');
    wallet.pk = pk.toString(); wallet.prov = x.p; wallet.name = x.name;
    LS.set('bw:wallet', x.name);
    if (x.p.on && !x.p.__bw) {
      x.p.__bw = true;
      x.p.on('accountChanged', k => { if (k) { wallet.pk = k.toString(); render(); } else disconnect(); });
    }
    if (!silent) { closeModal(); toast('connected · ' + short(wallet.pk)); }
    render();
  } catch (e) { if (!silent) toast('connection cancelled', true); }
}
function disconnect() {
  try { wallet.prov && wallet.prov.disconnect && wallet.prov.disconnect(); } catch (e) {}
  wallet.pk = wallet.prov = wallet.name = null; LS.set('bw:wallet', null);
  closeModal(); toast('disconnected'); render();
}
function walletModal() {
  if (wallet.pk) {
    return `<h3>your wallet</h3><p class="muted">${esc(wallet.name)} · <code>${esc(short(wallet.pk))}</code></p>
      <div class="linkrow mt"><button class="btn btn-sm" data-act="copy" data-v="${esc(wallet.pk)}">copy address</button>
      <a class="btn btn-sm btn-mint" href="#/dashboard" data-act="close-modal">dashboard</a>
      <a class="btn btn-sm" href="#/earnings/${esc(wallet.pk)}" data-act="close-modal">earnings</a>
      <button class="btn btn-sm btn-red" data-act="disconnect">disconnect</button></div>`;
  }
  const a = providers();
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  const deep = 'https://phantom.app/ul/browse/' + encodeURIComponent(location.href) + '?ref=' + encodeURIComponent(location.origin);
  return `<h3>connect a wallet</h3><p class="muted">Solana only. connecting doesn't sign anything; each action asks your wallet separately.</p>
    ${a.length ? a.map((x, i) => `<button class="btn wal" data-act="pick-wallet" data-i="${i}">${esc(x.name)}</button>`).join('') :
      `<p><b>no Solana wallet found in this browser.</b></p>
       ${mobile ? `<a class="btn btn-mint wal" href="${esc(deep)}">open this page in Phantom</a>` : ''}
       <a class="btn wal" href="https://phantom.com/download" target="_blank" rel="noopener">get Phantom ↗</a>
       <a class="btn wal" href="https://solflare.com/download" target="_blank" rel="noopener">get Solflare ↗</a>`}`;
}

/* ---------- chain writes ---------- */
async function send(memo, opt = {}) {
  if (!CFG.ESCROW) { toast('the escrow goes live with the CA. writes open then.', true); return null; }
  if (!wallet.pk) { openModal(walletModal()); toast('connect a wallet first'); return null; }
  const text = CFG.TAG + JSON.stringify(memo);
  if (new TextEncoder().encode(text).length > 520) { toast('that is too long for one memo, shorten it', true); return null; }
  let sig;
  try {
    W = W || window.solanaWeb3;
    if (!W) throw new Error('wallet library still loading, try again in a second');
    if (!window.Buffer) { const m = await import('https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm'); window.Buffer = m.Buffer; }
    const from = new W.PublicKey(wallet.pk);
    const t = new W.Transaction();
    t.add(W.SystemProgram.transfer({ fromPubkey: from, toPubkey: new W.PublicKey(opt.to || CFG.ESCROW), lamports: opt.lamports || 0 }));
    t.add(new W.TransactionInstruction({ keys: [{ pubkey: from, isSigner: true, isWritable: false }], programId: new W.PublicKey(MEMO_ID), data: Buffer.from(text, 'utf8') }));
    toast('check your wallet…');
    const bh = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    t.recentBlockhash = bh.value.blockhash; t.feePayer = from;
    if (wallet.prov.signAndSendTransaction) {
      const r = await wallet.prov.signAndSendTransaction(t);
      sig = typeof r === 'string' ? r : r && r.signature;
    } else {
      const signed = await wallet.prov.signTransaction(t);
      sig = await rpc('sendTransaction', [signed.serialize().toString('base64'), { encoding: 'base64' }]);
    }
  } catch (e) {
    const m = (e && e.message) || String(e);
    toast(/reject|cancel|denied|declined/i.test(m) ? 'cancelled in wallet' : 'could not send: ' + m, true);
    return null;
  }
  toast(`sent · <a href="${tx(sig)}" target="_blank" rel="noopener">view tx ↗</a> · the board updates in a few seconds`, false, true);
  [3000, 8000, 16000].forEach(ms => setTimeout(sync, ms));
  return sig;
}

/* ---------- modal ---------- */
function openModal(html) { $('#modal-card').innerHTML = '<button class="modal-x" data-act="close-modal" aria-label="close">×</button>' + html; $('#modal').hidden = false; const f = $('#modal-card input,#modal-card select,#modal-card textarea'); if (f) f.focus(); }
function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; }

/* ---------- views: parts ---------- */
const typeBadge = k => `<span class="badge b-${k}">${esc(k)}</span>`;
const isOp = () => wallet.pk && wallet.pk === CFG.ESCROW;
function avatar(c) {
  const d = S.dex[c.mint];
  return `<span class="av">${d && d.img ? `<img src="${esc(d.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(c.tk.slice(0, 2))}</span>`;
}
function loadingNote() {
  if (!CFG.ESCROW) return '';
  if (S.err && !S.synced) return `<div class="empty">couldn't reach the chain right now (${esc(S.err)}). <button class="btn btn-sm" data-act="retry">retry</button></div>`;
  if (!S.synced) return `<div class="empty skel">reading the escrow's history from the chain…</div>`;
  return '';
}
function coinCard(c) {
  const d = S.dex[c.mint];
  return `<a class="card coin" href="#/coin/${esc(c.mint)}">
    <div class="coin-top">${avatar(c)}<div><h3>${esc(c.name)}</h3><div class="tk">$${esc(c.tk)}</div></div><span class="age">${ago(c.time)}</span></div>
    <p>${esc(c.d) || '<span class="muted">no description</span>'}</p>
    <div class="row"><span><b>${c.open}</b> open tasks</span><span><b>${sol(c.pool)}</b> SOL pool</span><span><b>${sol(c.paid)}</b> paid</span>${d && d.mcap ? `<span class="mcap">mcap ${usd(d.mcap)} · dexscreener</span>` : ''}</div></a>`;
}
function taskCard(t) {
  const f = filled(t), lf = left(t), pend = t.proofs.filter(p => p.status === 'pending').length;
  const mine = wallet.pk && wallet.pk === t.c.owner;
  const done = wallet.pk && t.proofs.some(p => p.worker === wallet.pk && p.status !== 'rejected');
  let btn;
  if (t.closed) btn = '<span class="st st-rejected">closed</span>';
  else if (!lf) btn = '<span class="st st-paid">all slots filled</span>';
  else if (mine) btn = '<span class="muted">your task</span>';
  else if (done) btn = '<span class="st st-pending">proof sent</span>';
  else btn = `<button class="btn btn-sm btn-mint" data-act="take" data-task="${esc(t.sig)}">take task →</button>`;
  return `<div class="card task t-${t.k}">
    <div class="task-top">${typeBadge(t.k)}<a href="#/coin/${esc(t.mint)}"><b>${esc(t.c.name)}</b> <span class="muted">$${esc(t.c.tk)}</span></a><span class="pay">${sol(t.r)} SOL</span></div>
    <p class="txt">${esc(t.txt) || esc(TYPES[t.k].does)}</p>
    <div class="meta"><span>posted ${ago(t.time)}</span><span>${pend} pending</span>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener nofollow ugc">target ↗</a>` : ''}</div>
    <div class="foot"><div class="slots" title="${f} of ${t.n} filled"><i style="width:${Math.round(f / t.n * 100)}%"></i></div><span class="muted">${f}/${t.n}</span>${btn}</div></div>`;
}
function payRow(x) {
  return `<li>${typeBadge(x.p.t.k)}<a href="#/earnings/${esc(x.to)}"><b>${esc(x.p.x ? '@' + x.p.x : short(x.to))}</b></a><span class="muted">on $${esc(x.p.t.c.tk)} · ${ago(x.time)}</span><span class="amt">+${sol(x.l)} SOL</span><a class="tx" href="${tx(x.sig)}" target="_blank" rel="noopener">tx ↗</a></li>`;
}
function unpaid() { return [...D.proofs.values()].filter(p => p.status === 'approved').sort((a, b) => a.okTime - b.okTime); }
function unpaidRow(p) {
  return `<li>${typeBadge(p.t.k)}<b>${esc(p.x ? '@' + p.x : short(p.worker))}</b><span class="muted">$${esc(p.t.c.tk)} · approved · unpaid</span><span class="amt"><span class="timer" data-since="${p.okTime}">${dur(p.okTime)}</span></span><a class="tx" href="${tx(p.okSig)}" target="_blank" rel="noopener">approval ↗</a></li>`;
}
function leaders(sinceTs) {
  const m = new Map();
  for (const x of D.pays) {
    if (sinceTs && x.time < sinceTs) continue;
    const e = m.get(x.to) || { w: x.to, x: '', l: 0, n: 0, last: 0, k: { raid: 0, meme: 0, thread: 0, video: 0 } };
    e.l += x.l; e.n++; e.last = Math.max(e.last, x.time); e.k[x.p.t.k]++; if (x.p.x) e.x = x.p.x;
    m.set(x.to, e);
  }
  return [...m.values()].sort((a, b) => b.l - a.l);
}
function stats() {
  const openTasks = [...D.tasks.values()].filter(t => !t.closed && left(t) > 0).length;
  const paid = D.pays.reduce((s, x) => s + x.l, 0);
  const workers = new Set(D.pays.map(x => x.to)).size;
  const ready = CFG.ESCROW && S.synced;
  const v = (n, f) => ready ? dash(n, f) : '<span class="dash">—</span>';
  return `<div class="grid g6">
    <div class="card stat live"><div class="v">${S.bal && ready ? sol(S.bal) : '<span class="dash" title="nothing yet — a dash is not a zero">—</span>'}</div><div class="l">SOL in escrow</div></div>
    <div class="card stat"><div class="v">${v(paid, sol)}</div><div class="l">SOL paid out</div></div>
    <div class="card stat"><div class="v">${v(D.pays.length)}</div><div class="l">payouts</div></div>
    <div class="card stat"><div class="v">${v(workers)}</div><div class="l">workers paid</div></div>
    <div class="card stat"><div class="v">${v(openTasks)}</div><div class="l">open tasks</div></div>
    <div class="card stat"><div class="v">${v(D.coins.size)}</div><div class="l">coins listed</div></div></div>`;
}
function caChip() {
  return CFG.CA
    ? `<span class="chip"><b>CA</b><code>${esc(CFG.CA)}</code><button data-act="copy" data-v="${esc(CFG.CA)}">copy</button></span>`
    : `<span class="chip"><b>CA</b><code>soon</code><button data-act="ca-soon">copy</button></span>`;
}
function escrowChip() {
  return CFG.ESCROW
    ? `<span class="chip"><b>escrow</b><code>${esc(CFG.ESCROW)}</code><button data-act="copy" data-v="${esc(CFG.ESCROW)}">copy</button><a href="${acct(CFG.ESCROW)}" target="_blank" rel="noopener" class="muted">solscan ↗</a></span>`
    : `<span class="chip"><b>escrow</b><code>goes live with the CA</code></span>`;
}
function boardGrid() {
  let list = [...D.coins.values()];
  const q = boardQ.trim().toLowerCase();
  if (q) list = list.filter(c => (c.name + ' ' + c.tk + ' ' + c.mint).toLowerCase().includes(q));
  const sorts = { newest: (a, b) => b.time - a.time, pool: (a, b) => b.pool - a.pool, tasks: (a, b) => b.open - a.open, paid: (a, b) => b.paid - a.paid };
  list.sort(sorts[boardSort] || sorts.newest);
  if (!D.coins.size) return loadingNote() || `<div class="empty">no coins on the board yet. the first listing prints here. <a href="#/devs">list yours →</a></div>`;
  if (!list.length) return `<div class="empty">nothing matches "${esc(boardQ)}".</div>`;
  return `<div class="grid g3">${list.map(coinCard).join('')}</div>`;
}
let boardQ = '', boardSort = 'newest', taskK = 'all', taskQ = '', taskSort = 'newest', lbWin = 'all', rcK = 'all';
const ICON = {
  raid: '<svg viewBox="0 0 24 24"><path d="M3 10v4h3l6 4V6L6 10H3zm13-2.5a5 5 0 0 1 0 9M18.5 5a8.5 8.5 0 0 1 0 14"/></svg>',
  meme: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/></svg>',
  thread: '<svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><path d="M5 8v8M10 6h10M10 12h10M10 18h7"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9v6l5-3z"/></svg>'
};
function syncedTxt() {
  if (!CFG.ESCROW) return 'opens with the CA';
  if (S.syncedAt) return 'synced ' + ago(Math.floor(S.syncedAt / 1000));
  return S.err ? 'retrying the chain…' : 'reading the chain…';
}
function pill() {
  const el = $('#live-pill'); if (!el) return;
  const st = !CFG.ESCROW ? 'off' : S.err && !S.synced ? 'bad' : S.synced ? 'on' : 'warn';
  el.className = 'live-pill ' + st;
  el.querySelector('b').textContent = st === 'on' ? 'live · ' + ago(Math.floor(S.syncedAt / 1000)) : st === 'bad' ? 'chain offline' : st === 'warn' ? 'syncing' : 'not live yet';
}
function escrowCard() {
  if (!CFG.ESCROW) return '';
  const bal = S.bal && S.synced ? sol(S.bal) : '<span class="dash" title="nothing yet — a dash is not a zero">—</span>';
  return `<div class="escard"><div class="escard-top"><span class="dot${S.synced ? ' on' : ''}"></span><b>live escrow</b><span class="muted" data-synced>${esc(syncedTxt())}</span></div>
    <div class="escard-bal">${bal} <small>SOL locked</small></div>
    <div class="escard-row"><code>${esc(short(CFG.ESCROW))}</code><button class="btn btn-sm" data-act="copy" data-v="${esc(CFG.ESCROW)}">copy</button><a class="btn btn-sm" href="${acct(CFG.ESCROW)}" target="_blank" rel="noopener">solscan ↗</a></div></div>`;
}
function actRow(e) {
  const [k, t, l] = evText(e);
  return `<li><span class="ev ev-${esc(e.k)}">${esc(k)}</span><span>${esc(t)}</span><span class="muted">${ago(e.r.time)}</span>${l ? `<span class="amt">${sol(l)} SOL</span>` : '<span class="amt"></span>'}<a class="tx" href="${tx(e.r.sig)}" target="_blank" rel="noopener">tx ↗</a></li>`;
}
function checkProof(k, x, url) {
  x = str(x, 16).replace(/^@/, ''); url = str(url, 200);
  if (!url) return [null, 'paste a link to check it.'];
  if (!TYPES[k]) return [false, 'pick a task type.'];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(x)) return [false, 'add your X handle, letters, numbers and _ only.'];
  const xm = url.match(XRE);
  if (k === 'video' ? !(xm || VRE.test(url)) : !xm) return [false, `that isn't ${TYPES[k].proof}.`];
  if (xm && xm[1].toLowerCase() !== x.toLowerCase()) return [false, `that post is from @${xm[1]}, not @${x}. devs will reject it.`];
  return [true, `looks right. this is the link format a ${k} proof needs, from @${x}.`];
}
function updateTools() {
  const fc = document.getElementById('f-check'), fp = document.getElementById('f-plan');
  if (fc) {
    const [ok, msg] = checkProof(fc.elements.k.value, fc.elements.x.value, fc.elements.url.value);
    const o = $('#check-out'); o.className = 'tool-out' + (ok === true ? ' good' : ok === false ? ' bad' : ''); o.textContent = (ok === true ? '✓ ' : ok === false ? '✗ ' : '') + msg;
  }
  if (fp) {
    const rr = num(fp.elements.r.value), n = Math.floor(num(fp.elements.n.value)), m = Math.floor(num(fp.elements.m.value || '1'));
    const o = $('#plan-out');
    if (!(rr > 0) || !(n >= 1) || !(m >= 1)) { o.className = 'tool-out'; o.textContent = 'enter pay per slot and slots to see what to lock.'; }
    else { const tot = Math.round(rr * LPS) * n * m; o.className = 'tool-out good'; o.innerHTML = `lock <b>${sol(tot)} SOL</b> for <b>${n * m}</b> paid slots. each approved proof pays <b>${sol(Math.round(rr * LPS))} SOL</b>, straight from escrow.`; }
  }
}

/* ---------- pages ---------- */
function home() {
  const top = leaders()[0];
  const recent = D.pays.slice(-8).reverse();
  const up = unpaid();
  const openT = [...D.tasks.values()].filter(t => !t.closed && left(t) > 0).sort((a, b) => b.time - a.time).slice(0, 6);
  const cnt = k => [...D.tasks.values()].filter(t => t.k === k && !t.closed && left(t) > 0).length;
  const d = CFG.CA && S.dex[CFG.CA];
  return `
  <section class="hero"><div class="wrap hero-grid">
    <div>
      ${!CFG.ESCROW ? '<div class="notice">▲ the board opens with the CA. devs can prep a listing now.</div>' : ''}
      <h1 class="title">bagwork</h1>
      <p class="lede">you've been doing bagwork for free. not anymore.</p>
      ${escrowCard()}
      <div class="ctas">
        <a class="btn btn-mint" href="#/tasks">browse tasks</a>
        <a class="btn btn-or" href="#/devs">list your coin →</a>
        <button class="btn" data-act="scroll" data-to="how">how it works</button>
        ${CFG.X_URL ? `<a class="btn btn-dark" href="${esc(CFG.X_URL)}" target="_blank" rel="noopener">follow on X</a>` : ''}
      </div>
    </div>
    <div class="hero-art"><div class="rays"></div>${MARK}
      <a class="stk s1" href="#/tasks?k=raid">raid → SOL</a><a class="stk s2" href="#/tasks?k=thread">thread → SOL</a>
      <a class="stk s3" href="#/tasks?k=meme">meme → SOL</a><a class="stk s4" href="#/tasks?k=video">video → SOL</a></div>
  </div></section>

  <section class="sec"><div class="wrap">
    <div class="card king"><span class="mk">${MARK}</span>
      <div><h3>♛ KING OF THE BAGWORK</h3>
      ${top ? `<div class="who"><a href="#/earnings/${esc(top.w)}">${esc(top.x ? '@' + top.x : short(top.w))}</a></div><div class="meta">${top.n} payouts · last ${ago(top.last)}</div>` :
        `<div class="who">no king yet</div><div class="meta">top earner takes the crown. it updates from the chain.</div>`}</div>
      <div class="amt">${top ? sol(top.l) + ' SOL' : '<span class="dash">—</span>'}</div></div>
    <div class="mt">${stats()}</div>
  </div></section>

  <section class="sec"><div class="wrap">
    <div class="sec-h"><h2>the <span class="o">bagwork</span></h2><small>what devs pay for</small></div>
    <div class="grid g4">${Object.entries(TYPES).map(([k, t]) => { const top = Math.max(0, ...[...D.tasks.values()].filter(x => x.k === k && !x.closed && left(x) > 0).map(x => x.r)); return `<a class="card cat t-${k}" href="#/tasks?k=${k}"><span class="ic">${ICON[k]}</span><h3>${esc(t.name)}</h3><p>${esc(t.does)}</p><div class="pf">proof: ${esc(t.proof)}</div><div class="cat-row"><span class="n">${cnt(k)} open</span><span class="tp">top pay ${top ? sol(top) + ' SOL' : '<span class="dash">—</span>'}</span></div></a>`; }).join('')}</div>
  </div></section>

  <section class="sec" id="how"><div class="wrap">
    <div class="card term pad">
      <div class="sec-h"><h2>how it works <span class="or">● escrow on-chain</span></h2></div>
      <div class="pipe"><span>dev</span><i>→</i><span class="p-or">escrow</span><i>→</i><span>task</span><i>→</i><span>you</span><i>→</i><span>proof</span><i>→</i><span class="p-mint">approve</span><i>→</i><span class="p-mint">SOL</span></div>
      <div class="grid g2">
        <div>
          <h3>i'm doing the work</h3>
          <div class="step"><span class="num">1</span><div><b>connect a Solana wallet</b><div class="bar">Phantom, Solflare or Backpack. no signup, no email.</div></div></div>
          <div class="step"><span class="num">2</span><div><b>pick a task, do the bagwork</b><div class="bar">raid, meme, thread or video. the pay per slot is on the card.</div></div></div>
          <div class="step"><span class="num">3</span><div><b>drop the proof</b><div class="bar">paste your link. it's written on-chain as a memo from your wallet.</div></div></div>
          <div class="step"><span class="num">4</span><div><b>approved = paid</b> <span class="red">keep receipts</span><div class="bar">SOL leaves escrow for your wallet. the tx goes on the board next to your name.</div></div></div>
          <a class="btn btn-mint" href="#/tasks">find a task →</a>
        </div>
        <div>
          <h3>i'm a dev</h3>
          <div class="step"><span class="num">1</span><div><b>list your coin</b><div class="bar">mint, name, ticker, one line. one memo, network fee only.</div></div></div>
          <div class="step"><span class="num">2</span><div><b>fund the pool</b><div class="bar">send SOL to escrow tagged to your coin. that's the bounty pool.</div></div></div>
          <div class="step"><span class="num">3</span><div><b>post tasks</b><div class="bar">type, pay per slot, number of slots, what counts. the pool must cover it.</div></div></div>
          <div class="step"><span class="num">4</span><div><b>approve or reject</b><div class="bar">from your dashboard. approved proof gets paid from your pool.</div></div></div>
          <a class="btn btn-or" href="#/devs">list your coin →</a>
        </div>
      </div>
      <p class="dim mt">escrow: ${CFG.ESCROW ? `<code>${esc(CFG.ESCROW)}</code> · <a href="${acct(CFG.ESCROW)}" target="_blank" rel="noopener">solscan ↗</a>` : '<code>goes live with the CA</code>'}</p>
    </div>
  </div></section>

  <section class="sec"><div class="wrap grid g2">
    <div><div class="sec-h"><h2>recent payouts</h2><small>on-chain receipts</small></div>
      ${recent.length ? `<ul class="card feed">${recent.map(payRow).join('')}</ul>` : `<div class="empty">no payouts yet. the first one prints here.</div>`}</div>
    <div><div class="sec-h"><h2>approved · <span class="o">unpaid</span></h2><small>the clock we can't hide</small></div>
      ${up.length ? `<ul class="card feed">${up.slice(0, 8).map(unpaidRow).join('')}</ul>` : `<div class="empty">nothing waiting. approved work that isn't paid shows here with a running timer.</div>`}</div>
  </div></section>

  <section class="sec"><div class="wrap">
    <div class="sec-h"><h2>live <span class="o">activity</span></h2><a class="muted" href="#/receipts">all receipts →</a></div>
    ${D.ev.length ? `<ul class="card feed act">${D.ev.slice(-10).reverse().map(actRow).join('')}</ul>` : (loadingNote() || '<div class="empty">nothing has happened on the board yet. every listing, task, proof and payout lands here with its tx.</div>')}
  </div></section>

  <section class="sec" id="board"><div class="wrap">
    <div class="sec-h"><h2>the board</h2><small>live from the chain · refreshes every ${Math.round(CFG.REFRESH_MS / 1000)}s</small></div>
    <div class="tools"><label class="search"><span aria-hidden="true">⌕</span><input id="board-q" placeholder="look up a coin, ticker or CA…" value="${esc(boardQ)}" autocomplete="off"></label>
      <select id="board-sort" aria-label="sort">${[['newest', 'newest'], ['pool', 'biggest pool'], ['tasks', 'most open tasks'], ['paid', 'most paid']].map(([v, l]) => `<option value="${v}"${boardSort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div id="board-grid">${boardGrid()}</div>
  </div></section>

  <section class="sec"><div class="wrap">
    <div class="sec-h"><h2>open tasks</h2><a href="#/tasks" class="muted">all tasks →</a></div>
    ${openT.length ? `<div class="grid g3">${openT.map(taskCard).join('')}</div>` : (loadingNote() || `<div class="empty">no open tasks yet. when a dev posts one, it lands here.</div>`)}
  </div></section>

  <section class="sec" id="tools"><div class="wrap">
    <div class="sec-h"><h2>free <span class="o">tools</span></h2><small>they run in your browser, nothing is sent</small></div>
    <div class="grid g2">
      <form class="card pad form tool" id="f-check" novalidate>
        <h3><span class="ic">${ICON.raid}</span>proof checker</h3>
        <p class="muted" style="margin:0">check a link before you spend a transaction on it.</p>
        <div class="row2"><label>task type<select name="k">${Object.keys(TYPES).map(k => `<option value="${k}">${k}</option>`).join('')}</select></label><label>your X handle<input class="inp" name="x" placeholder="@you" maxlength="16" autocomplete="off"></label></div>
        <label>proof link<input class="inp" name="url" placeholder="https://x.com/you/status/…" autocomplete="off"></label>
        <div class="tool-out" id="check-out">paste a link to check it.</div>
      </form>
      <form class="card pad form tool" id="f-plan" novalidate>
        <h3><span class="ic">${ICON.meme}</span>bounty planner</h3>
        <p class="muted" style="margin:0">what a round of tasks locks before you post it.</p>
        <div class="row2"><label>pay per slot (SOL)<input class="inp" name="r" inputmode="decimal" placeholder="0.05"></label><label>slots per task<input class="inp" name="n" inputmode="numeric" placeholder="20"></label></div>
        <label>how many tasks<input class="inp" name="m" inputmode="numeric" placeholder="1"></label>
        <div class="tool-out" id="plan-out">enter pay per slot and slots to see what to lock.</div>
        <a class="btn btn-or" href="#/devs">fund the pool &amp; post →</a>
      </form>
    </div>
  </div></section>

  <section class="sec"><div class="wrap grid g2">
    <div class="card pad trust"><h3>where you should not trust us yet</h3>
      <p>in v1 the escrow is one wallet we run, not an on-chain program. each coin's pool is counted from on-chain memos. that means you trust us to send when a dev approves.</p>
      <p>where you'd see it if we didn't: approved work with no payout sits in <b>approved · unpaid</b> with a timer running. if the timer gets long, call it out.</p>
      <p>moving escrow to a program is next. until then, this is the hole, and this is where it would show.</p></div>
    <div class="card pad trust"><h3>a dash is not a zero</h3>
      <p>if something hasn't happened yet, the board shows <span class="dash">—</span>, not a zero. a zero would be a claim.</p>
      <p>a dev taking unspent SOL back shows as a <b>withdrawal</b>, never as a payout. what's owed to approved work and reserved for open slots can't be withdrawn.</p>
      <p>every number here is read from the escrow's history. none of it is typed in by us.</p></div>
  </div></section>

  <section class="sec"><div class="wrap">
    <div class="sec-h"><h2>faq</h2></div>
    ${faq()}
  </div></section>

  <section class="wrap"><div class="card closer"><h2 class="title">clock in.</h2>
    <p class="sub center" style="margin:0 auto 18px">the bag is locked before you work.</p>
    <div class="ctas" style="justify-content:center"><a class="btn btn-mint" href="#/tasks">browse tasks</a><a class="btn btn-or" href="#/devs">list your coin →</a></div></div></section>`;
}
function faq() {
  const q = [
    ['how do i know i\'ll actually get paid?', 'the SOL sits in escrow before the task goes up, and a task can only be posted if the coin\'s pool covers every slot. approved work that isn\'t paid shows in "approved · unpaid" with a running timer. every payout is a tx you can open on solscan.'],
    ['what do i need to start?', 'a Solana wallet (Phantom, Solflare or Backpack) and the X account you post from. connect, pick a task, do it, paste the link. each action is a small on-chain memo, so you only pay the network fee.'],
    ['i\'m a dev. why list my coin here?', 'raiders, memers, thread writers and editors who only get paid when you approve. you set the price, the slots and what counts. your pool, tasks and payouts are public, and that\'s the point: workers pick the coins that pay.'],
    ['what stops people farming tasks with bot accounts?', 'devs approve every proof and see the account behind it. one live proof per wallet per task. X proof links must come from the handle you enter. rejected proofs stay on the record with the reason, so farmers are visible to every dev.'],
    ['who holds the escrow?', 'in v1, one escrow wallet run by the bagwork team; its address is on this page. each coin\'s pool is counted from on-chain memos. moving escrow to an on-chain program is next.'],
    ['can a dev pull their pool back?', 'a dev can request unspent SOL back from their dashboard. only the free part: never what\'s owed to approved work or reserved for open slots. it shows as a withdrawal, never as a payout.'],
    ['what does $BAGWORK do?', 'it\'s the flag on the board. holding it doesn\'t pay you. bagwork does.']
  ];
  return q.map(([a, b], i) => `<details class="q"${i === 1 ? ' open' : ''}><summary>${esc(a)}</summary><div class="a">${esc(b)}</div></details>`).join('');
}
function tasksPage() {
  return `<section class="wrap ph"><h1>tasks</h1><p>every open bounty on the board. pay per slot is locked in the coin's pool before the task goes up.</p></section>
  <section class="sec"><div class="wrap">
    <div class="tools"><div class="filters">${['all', ...Object.keys(TYPES)].map(k => `<button class="fchip${taskK === k ? ' on' : ''}" data-act="tk" data-k="${k}">${k === 'all' ? 'all' : TYPES[k].name}</button>`).join('')}</div></div>
    <div class="tools"><label class="search"><span aria-hidden="true">⌕</span><input id="task-q" placeholder="search coin, ticker or words…" value="${esc(taskQ)}" autocomplete="off"></label>
      <select id="task-sort" aria-label="sort">${[['newest', 'newest'], ['pay', 'highest pay'], ['slots', 'most slots left']].map(([v, l]) => `<option value="${v}"${taskSort === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label class="fchip" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="task-open"${taskOpen ? ' checked' : ''}> open only</label></div>
    <div id="task-grid">${taskGrid()}</div>
    ${taskK !== 'all' ? `<div class="card pad mt"><b>what counts as proof for ${esc(TYPES[taskK].name)}:</b> ${esc(TYPES[taskK].proof)}. ${esc(TYPES[taskK].does)}</div>` : ''}
  </div></section>`;
}
let taskOpen = true;
function taskGrid() {
  let list = [...D.tasks.values()];
  if (taskK !== 'all') list = list.filter(t => t.k === taskK);
  if (taskOpen) list = list.filter(t => !t.closed && left(t) > 0);
  const q = taskQ.trim().toLowerCase();
  if (q) list = list.filter(t => (t.c.name + ' ' + t.c.tk + ' ' + t.txt + ' ' + t.mint).toLowerCase().includes(q));
  const s = { newest: (a, b) => b.time - a.time, pay: (a, b) => b.r - a.r, slots: (a, b) => left(b) - left(a) };
  list.sort(s[taskSort] || s.newest);
  if (!list.length) return loadingNote() || `<div class="empty">no ${taskK === 'all' ? '' : esc(TYPES[taskK].name) + ' '}tasks ${taskOpen ? 'open ' : ''}right now.</div>`;
  return `<div class="grid g3">${list.map(taskCard).join('')}</div>`;
}
function coinPage(mint) {
  const c = D.coins.get(mint);
  if (!c) return `<section class="wrap ph"><a class="back" href="#/">← board</a><h1>not on the board</h1><p>${esc(short(mint))} hasn't been listed${S.synced || !CFG.ESCROW ? '' : ' (still reading the chain)'}.</p><div class="ctas mt"><a class="btn btn-or" href="#/devs">list a coin →</a></div></section>`;
  const d = S.dex[c.mint], mine = wallet.pk === c.owner;
  const evs = D.ev.filter(e => evCoin(e) === c).slice(-40).reverse();
  return `<section class="wrap ph"><a class="back" href="#/">← board</a>
    <div class="coin-top" style="gap:14px">${avatar(c)}<div><h1 style="font-size:clamp(34px,5vw,54px)">${esc(c.name)}</h1><div class="tk" style="font-size:16px">$${esc(c.tk)}</div></div></div>
    <p>${esc(c.d)}</p>
    <div class="chips mt"><span class="chip"><b>mint</b><code>${esc(c.mint)}</code><button data-act="copy" data-v="${esc(c.mint)}">copy</button></span><span class="chip"><b>dev</b><code>${esc(short(c.owner))}</code></span></div>
    <div class="linkrow"><a class="btn btn-sm" href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener">pump.fun ↗</a><a class="btn btn-sm" href="${esc((d && d.url) || 'https://dexscreener.com/solana/' + c.mint)}" target="_blank" rel="noopener">dexscreener ↗</a><a class="btn btn-sm" href="https://solscan.io/token/${esc(c.mint)}" target="_blank" rel="noopener">solscan ↗</a>${c.x ? `<a class="btn btn-sm" href="${esc(c.x)}" target="_blank" rel="noopener nofollow">X ↗</a>` : ''}</div></section>
  <section class="sec"><div class="wrap">
    <div class="kv">
      <div class="card"><div class="v">${sol(c.pool)}</div><div class="l">SOL in pool</div></div>
      <div class="card"><div class="v">${sol(Math.max(0, c.free))}</div><div class="l">free (not reserved)</div></div>
      <div class="card"><div class="v">${dash(c.owed, sol)}</div><div class="l">owed to approved work</div></div>
      <div class="card"><div class="v">${dash(c.funded, sol)}</div><div class="l">SOL funded</div></div>
      <div class="card"><div class="v">${dash(c.paid, sol)}</div><div class="l">SOL paid out</div></div>
      <div class="card"><div class="v">${dash(c.out, sol)}</div><div class="l">withdrawn by dev</div></div>
      <div class="card"><div class="v">${d && d.mcap ? usd(d.mcap) : '<span class="dash">—</span>'}</div><div class="l">mcap · dexscreener</div></div>
    </div>
    <div class="ctas mt"><button class="btn btn-mint" data-act="fund" data-mint="${esc(c.mint)}">fund this pool</button>
      ${mine ? `<a class="btn btn-or" href="#/devs?mint=${esc(c.mint)}">post a task</a><button class="btn" data-act="req" data-mint="${esc(c.mint)}">request withdrawal</button>` : ''}</div>
  </div></section>
  <section class="sec"><div class="wrap"><div class="sec-h"><h2>tasks</h2><small>${c.tasks.length} posted</small></div>
    ${c.tasks.length ? `<div class="grid g3">${c.tasks.slice().reverse().map(taskCard).join('')}</div>` : '<div class="empty">no tasks posted yet.</div>'}</div></section>
  <section class="sec"><div class="wrap"><div class="sec-h"><h2>ledger</h2><small>every line has a tx</small></div>${evTable(evs)}</div></section>`;
}
function evCoin(e) { return e.c || (e.t && e.t.c) || (e.p && e.p.t.c) || (e.x && (e.x.c || (e.x.p && e.x.p.t.c))); }
function evText(e) {
  const c = evCoin(e), tk = c ? '$' + c.tk : '';
  switch (e.k) {
    case 'list': return ['listed', `${tk} joined the board`, 0];
    case 'fund': return ['fund', `${tk} pool funded`, e.l];
    case 'task': return ['task', `new ${e.t.k} on ${tk} · ${sol(e.t.r)} SOL × ${e.t.n}`, 0];
    case 'close': return ['closed', `${e.t.k} task on ${tk} closed`, 0];
    case 'proof': return ['proof', `proof in for a ${e.p.t.k} on ${tk}`, 0];
    case 'ok': return ['approved', `${e.p.t.k} on ${tk} approved`, 0];
    case 'no': return ['rejected', `${e.p.t.k} on ${tk} rejected${e.p.why ? ': ' + e.p.why : ''}`, 0];
    case 'pay': return ['payout', `${e.x.p.x ? '@' + e.x.p.x : short(e.x.to)} paid for a ${e.x.p.t.k} on ${tk}`, e.x.l];
    case 'req': return ['request', `${tk} dev asked to withdraw ${sol(e.l)} SOL`, 0];
    case 'out': return ['withdrawal', `${tk} dev withdrew`, e.x.l];
  }
  return [e.k, '', 0];
}
function evTable(evs) {
  if (!evs.length) return loadingNote() || '<div class="empty">nothing on the record yet.</div>';
  return `<div class="tbl-wrap"><table><thead><tr><th>when</th><th>what</th><th>detail</th><th>from</th><th class="r">SOL</th><th>tx</th></tr></thead><tbody>
    ${evs.map(e => { const [k, t, l] = evText(e); return `<tr><td>${ago(e.r.time)}</td><td><b>${esc(k)}</b></td><td>${esc(t)}</td><td><a href="${acct(e.r.signer)}" target="_blank" rel="noopener">${esc(short(e.r.signer))}</a></td><td class="r">${l ? sol(l) : ''}</td><td><a href="${tx(e.r.sig)}" target="_blank" rel="noopener">${esc(short(e.r.sig))} ↗</a></td></tr>`; }).join('')}
  </tbody></table></div>`;
}
function leaderboardPage() {
  const since = { all: 0, '7d': Date.now() / 1000 - 7 * 86400, '24h': Date.now() / 1000 - 86400 }[lbWin];
  const rows = leaders(since);
  return `<section class="wrap ph"><h1>leaderboard</h1><p>ranked by SOL actually paid out of escrow. no points, no self-reported numbers.</p></section>
  <section class="sec"><div class="wrap">
    <div class="tools filters">${['all', '7d', '24h'].map(k => `<button class="fchip${lbWin === k ? ' on' : ''}" data-act="lb" data-k="${k}">${k === 'all' ? 'all time' : k}</button>`).join('')}</div>
    ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>#</th><th>worker</th><th class="r">SOL earned</th><th class="r">payouts</th><th class="r">raids</th><th class="r">memes</th><th class="r">threads</th><th class="r">videos</th><th>last paid</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td class="rank rank-${i + 1}">${i === 0 ? '♛' : i + 1}</td><td><a href="#/earnings/${esc(r.w)}"><b>${esc(r.x ? '@' + r.x : short(r.w))}</b></a> <span class="muted">${esc(short(r.w))}</span></td><td class="r"><b>${sol(r.l)}</b></td><td class="r">${r.n}</td><td class="r">${r.k.raid || ''}</td><td class="r">${r.k.meme || ''}</td><td class="r">${r.k.thread || ''}</td><td class="r">${r.k.video || ''}</td><td>${ago(r.last)}</td></tr>`).join('')}
    </tbody></table></div>` : (loadingNote() || '<div class="empty">no one has been paid yet. the first payout takes the crown.</div>')}
  </div></section>`;
}
function earningsPage(addr) {
  addr = addr || '';
  const valid = B58.test(addr);
  let body = '';
  if (addr && !valid) body = '<div class="empty">that doesn\'t look like a Solana address.</div>';
  else if (valid) {
    const ps = [...D.proofs.values()].filter(p => p.worker === addr).sort((a, b) => b.time - a.time);
    const earned = ps.filter(p => p.status === 'paid').reduce((s, p) => s + p.paid, 0);
    const cnt = st => ps.filter(p => p.status === st).length;
    const owed = ps.filter(p => p.status === 'approved').reduce((s, p) => s + p.t.r, 0);
    body = `<div class="kv">
      <div class="card"><div class="v">${dash(earned, sol)}</div><div class="l">SOL earned</div></div>
      <div class="card"><div class="v">${dash(cnt('paid'))}</div><div class="l">paid</div></div>
      <div class="card"><div class="v">${dash(owed, sol)}</div><div class="l">approved · unpaid (SOL)</div></div>
      <div class="card"><div class="v">${dash(cnt('pending'))}</div><div class="l">pending review</div></div>
      <div class="card"><div class="v">${dash(cnt('rejected'))}</div><div class="l">rejected</div></div></div>
      <div class="mt">${ps.length ? `<div class="tbl-wrap"><table><thead><tr><th>task</th><th>coin</th><th>status</th><th class="r">SOL</th><th>sent</th><th>proof</th><th>receipt</th></tr></thead><tbody>
        ${ps.map(p => `<tr><td>${typeBadge(p.t.k)}</td><td><a href="#/coin/${esc(p.t.mint)}">$${esc(p.t.c.tk)}</a></td><td><span class="st st-${p.status}">${p.status === 'approved' ? 'approved · unpaid' : p.status}</span>${p.why ? ` <span class="muted">${esc(p.why)}</span>` : ''}</td><td class="r">${sol(p.paid || p.t.r)}</td><td>${ago(p.time)}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow ugc">link ↗</a></td><td>${p.paySig ? `<a href="${tx(p.paySig)}" target="_blank" rel="noopener">tx ↗</a>` : p.status === 'approved' ? `<span class="timer" data-since="${p.okTime}">${dur(p.okTime)}</span>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : (loadingNote() || '<div class="empty">no proofs from this wallet yet.</div>')}</div>`;
  }
  return `<section class="wrap ph"><h1>earnings</h1><p>look up any wallet. everything here is rebuilt from the escrow's on-chain history.</p></section>
  <section class="sec"><div class="wrap">
    <form class="tools" id="f-earn"><label class="search"><span aria-hidden="true">⌕</span><input name="addr" placeholder="paste a Solana wallet address" value="${esc(addr)}" autocomplete="off"></label>
      <button class="btn btn-mint" type="submit">look up</button>${wallet.pk ? `<a class="btn" href="#/earnings/${esc(wallet.pk)}">my wallet</a>` : `<button class="btn" type="button" data-act="wallet">connect</button>`}</form>
    ${body}
  </div></section>`;
}
function dashboardPage() {
  if (!wallet.pk) return `<section class="wrap ph"><h1>dashboard</h1><p>connect a wallet to see your work, your coins, and anything waiting on you.</p><div class="ctas mt"><button class="btn btn-mint" data-act="wallet">connect wallet</button></div></section>
    <section class="sec"><div class="wrap grid g3"><div class="card pad"><h3>workers</h3><p class="muted">every proof you sent, where it stands, and the tx for each payout.</p></div><div class="card pad"><h3>devs</h3><p class="muted">approve or reject proofs, close tasks, request unspent SOL back.</p></div><div class="card pad"><h3>escrow desk</h3><p class="muted">only for the escrow wallet: the payout queue, oldest first.</p></div></div></section>`;
  const me = wallet.pk;
  const mine = [...D.proofs.values()].filter(p => p.worker === me).sort((a, b) => b.time - a.time);
  const coins = [...D.coins.values()].filter(c => c.owner === me);
  const earned = mine.filter(p => p.status === 'paid').reduce((s, p) => s + p.paid, 0);
  let h = `<section class="wrap ph"><h1>dashboard</h1><p>${esc(wallet.name)} · <code>${esc(short(me))}</code> <button class="btn btn-sm" data-act="copy" data-v="${esc(me)}">copy</button></p></section>`;
  if (isOp()) {
    const q = unpaid(), rq = [...D.reqs.values()].filter(r => !r.done);
    h += `<section class="sec"><div class="wrap"><div class="card term pad"><div class="sec-h"><h2>escrow desk</h2><small class="dim">oldest first · each send is a transfer + memo</small></div>
      ${q.length ? `<div class="tbl-wrap" style="background:#12261a"><table><thead><tr><th>waiting</th><th>worker</th><th>task</th><th class="r">SOL</th><th>proof</th><th></th></tr></thead><tbody>
        ${q.map(p => `<tr><td><span class="timer" data-since="${p.okTime}">${dur(p.okTime)}</span></td><td>${esc(p.x ? '@' + p.x : '')} <code>${esc(short(p.worker))}</code></td><td>${p.t.k} · $${esc(p.t.c.tk)}</td><td class="r">${sol(p.t.r)}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow ugc">link ↗</a></td><td><button class="btn btn-sm btn-mint" data-act="pay" data-p="${esc(p.sig)}">send</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="dim">no approved work waiting. queue is clear.</p>'}
      <h3 class="mt">withdrawal requests</h3>
      ${rq.length ? rq.map(r => `<div class="bar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">$${esc(r.c.tk)} asks ${sol(r.l)} SOL · free now ${sol(Math.max(0, r.c.free))} · ${ago(r.time)} <button class="btn btn-sm btn-or" data-act="out" data-req="${esc(r.sig)}">send ${sol(Math.min(r.l, Math.max(0, r.c.free)))} SOL</button></div>`).join('') : '<p class="dim">none.</p>'}
    </div></div></section>`;
  }
  h += `<section class="sec"><div class="wrap"><div class="sec-h"><h2>your work</h2><a class="muted" href="#/earnings/${esc(me)}">earnings →</a></div>
    <div class="kv"><div class="card"><div class="v">${dash(earned, sol)}</div><div class="l">SOL earned</div></div><div class="card"><div class="v">${dash(mine.filter(p => p.status === 'pending').length)}</div><div class="l">pending</div></div><div class="card"><div class="v">${dash(mine.filter(p => p.status === 'approved').length)}</div><div class="l">approved · unpaid</div></div></div>
    <div class="mt">${mine.length ? `<ul class="card feed">${mine.slice(0, 12).map(p => `<li>${typeBadge(p.t.k)}<a href="#/coin/${esc(p.t.mint)}">$${esc(p.t.c.tk)}</a><span class="st st-${p.status}">${p.status === 'approved' ? 'approved · unpaid' : p.status}</span><span class="muted">${ago(p.time)}</span><span class="amt">${sol(p.paid || p.t.r)} SOL</span>${p.paySig ? `<a class="tx" href="${tx(p.paySig)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</li>`).join('')}</ul>` : `<div class="empty">no proofs yet. <a href="#/tasks">find a task →</a></div>`}</div></div></section>`;
  h += `<section class="sec"><div class="wrap"><div class="sec-h"><h2>your coins</h2><a class="muted" href="#/devs">list a coin →</a></div>
    ${coins.length ? coins.map(c => {
      const pend = c.tasks.flatMap(t => t.proofs.filter(p => p.status === 'pending'));
      const open = c.tasks.filter(t => !t.closed && left(t) > 0);
      return `<div class="card pad mt">
        <div class="coin-top">${avatar(c)}<div><h3 style="margin:0"><a href="#/coin/${esc(c.mint)}">${esc(c.name)}</a></h3><div class="tk">$${esc(c.tk)}</div></div><span class="age">pool ${sol(c.pool)} · free ${sol(Math.max(0, c.free))} SOL</span></div>
        <div class="ctas mt"><button class="btn btn-sm btn-mint" data-act="fund" data-mint="${esc(c.mint)}">fund</button><a class="btn btn-sm btn-or" href="#/devs?mint=${esc(c.mint)}">post a task</a><button class="btn btn-sm" data-act="req" data-mint="${esc(c.mint)}">request withdrawal</button></div>
        <h3 class="mt">proofs to review (${pend.length})</h3>
        ${pend.length ? `<ul class="feed">${pend.map(p => `<li>${typeBadge(p.t.k)}<b>${esc(p.x ? '@' + p.x : short(p.worker))}</b><span class="muted">${ago(p.time)}</span><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow ugc">open proof ↗</a><span class="amt"><button class="btn btn-sm btn-mint" data-act="approve" data-p="${esc(p.sig)}">approve</button> <button class="btn btn-sm btn-red" data-act="reject" data-p="${esc(p.sig)}">reject</button></span></li>`).join('')}</ul>` : '<p class="muted">nothing waiting.</p>'}
        <h3 class="mt">open tasks (${open.length})</h3>
        ${open.length ? `<ul class="feed">${open.map(t => `<li>${typeBadge(t.k)}<span>${esc(t.txt.slice(0, 60)) || esc(TYPES[t.k].does)}</span><span class="muted">${filled(t)}/${t.n} · ${sol(t.r)} SOL</span><span class="amt"><button class="btn btn-sm" data-act="close-task" data-task="${esc(t.sig)}">close</button></span></li>`).join('')}</ul>` : '<p class="muted">none open.</p>'}
      </div>`;
    }).join('') : '<div class="empty">you haven\'t listed a coin from this wallet.</div>'}
  </div></section>`;
  return h;
}
function devsPage(pre) {
  const all = [...D.coins.values()];
  const own = all.filter(c => wallet.pk && c.owner === wallet.pk);
  const opt = (list, sel) => list.map(c => `<option value="${esc(c.mint)}"${c.mint === sel ? ' selected' : ''}>$${esc(c.tk)} · ${esc(c.name)}</option>`).join('');
  return `<section class="wrap ph"><h1>for devs</h1><p>list your coin, lock the pool, post the bagwork. every step is a transaction from your wallet, so the board knows the tasks are really yours.</p>
    ${!CFG.ESCROW ? '<div class="notice mt">▲ the escrow goes live with the CA. you can fill these in now; sending opens then.</div>' : ''}</section>
  <section class="sec"><div class="wrap grid g3">
    <form class="card pad form" id="f-list" novalidate>
      <h3><span class="stepno">1</span>list your coin</h3>
      <label>token mint (CA)<input class="inp" name="mint" placeholder="pump.fun mint address" autocomplete="off"></label>
      <div class="row2"><label>name<input class="inp" name="name" maxlength="32" placeholder="my coin"></label><label>ticker<input class="inp" name="tk" maxlength="12" placeholder="$TICKER"></label></div>
      <label>one line<span class="hint">what the coin is, max 140</span><textarea name="d" rows="2" maxlength="140"></textarea></label>
      <label>X link <span class="hint">optional</span><input class="inp" name="x" placeholder="https://x.com/yourcoin"></label>
      <div class="err" data-err></div>
      <button class="btn btn-or" type="submit">list it (network fee only)</button>
    </form>
    <form class="card pad form" id="f-fund" novalidate>
      <h3><span class="stepno">2</span>fund the pool</h3>
      <label>coin<select name="mint">${all.length ? opt(all, pre) : '<option value="">list a coin first</option>'}</select></label>
      <label>amount (SOL)<input class="inp" name="sol" inputmode="decimal" placeholder="1.5"></label>
      <p class="hint muted" style="margin:0">goes to the escrow tagged to this coin. anyone can top up a pool.</p>
      <div class="err" data-err></div>
      <button class="btn btn-mint" type="submit">send to escrow</button>
    </form>
    <form class="card pad form" id="f-task" novalidate>
      <h3><span class="stepno">3</span>post a task</h3>
      <label>coin <span class="hint">only coins you listed</span><select name="mint">${own.length ? opt(own, pre) : `<option value="">${wallet.pk ? 'no coins listed from this wallet' : 'connect the wallet you listed with'}</option>`}</select></label>
      <div class="row2"><label>type<select name="k">${Object.keys(TYPES).map(k => `<option value="${k}">${k}</option>`).join('')}</select></label>
        <label>slots<input class="inp" name="n" inputmode="numeric" placeholder="10"></label></div>
      <label>pay per slot (SOL)<input class="inp" name="r" inputmode="decimal" placeholder="0.05"></label>
      <label>what counts<textarea name="txt" rows="2" maxlength="200" placeholder="reply with a meme, RT, no bots"></textarea></label>
      <label>target link <span class="hint">the tweet to raid, optional for other types</span><input class="inp" name="url" placeholder="https://x.com/.../status/..."></label>
      <p class="hint muted" style="margin:0" id="task-cover">${coverNote(own.find(c => c.mint === pre) || own[0])}</p>
      <div class="err" data-err></div>
      <button class="btn btn-or" type="submit">post task</button>
    </form>
  </div></section>
  <section class="sec"><div class="wrap grid g2">
    <div class="card pad"><h3>rules the board enforces</h3><ul>
      <li>only the wallet that listed a coin can post its tasks and approve its proofs.</li>
      <li>a task only goes up if the pool's free SOL covers every slot.</li>
      <li>one live proof per wallet per task. a task stops taking approvals when its slots are full.</li>
      <li>withdrawals only come from free SOL, never from what's owed or reserved.</li>
      <li>payouts only count if they come from the escrow wallet to the worker who sent the proof.</li></ul></div>
    <div class="card pad term"><h3>what gets written on-chain</h3><p class="dim">each action is a tiny transaction to the escrow with a memo like:</p>
      <p><code>bagwork|v1|{"t":"task","mint":"…","k":"raid","r":0.05,"n":10}</code></p>
      <p class="dim">that's the whole database. anyone can rebuild this board from the escrow's history.</p></div>
  </div></section>`;
}
function coverNote(c) {
  if (!c) return 'the pool has to cover pay × slots.';
  return `free in $${esc(c.tk)} pool: <b>${sol(Math.max(0, c.free))} SOL</b>. pay × slots must fit.`;
}
function receiptsPage() {
  const kinds = { all: null, payouts: ['pay'], funding: ['fund'], withdrawals: ['out', 'req'], tasks: ['task', 'close'], proofs: ['proof', 'ok', 'no'], listings: ['list'] };
  const evs = D.ev.filter(e => !kinds[rcK] || kinds[rcK].includes(e.k)).slice().reverse().slice(0, 300);
  return `<section class="wrap ph"><h1>receipts</h1><p>every line the board is built from, newest first. each one links to its transaction.</p><div class="chips mt">${escrowChip()}</div></section>
  <section class="sec"><div class="wrap">
    <div class="tools filters">${Object.keys(kinds).map(k => `<button class="fchip${rcK === k ? ' on' : ''}" data-act="rc" data-k="${k}">${k}</button>`).join('')}</div>
    ${evTable(evs)}
  </div></section>`;
}

/* ---------- task modals ---------- */
function proofModal(t) {
  const k = t.k;
  return `<h3>${typeBadge(k)} ${esc(t.c.name)} · ${sol(t.r)} SOL</h3>
    <p class="muted">${esc(t.txt || TYPES[k].does)}</p>
    ${t.url ? `<p><a class="btn btn-sm" href="${esc(t.url)}" target="_blank" rel="noopener nofollow ugc">open the target ↗</a></p>` : ''}
    <form class="form" id="f-proof" data-task="${esc(t.sig)}" novalidate>
      <label>your X handle<input class="inp" name="x" placeholder="@you" maxlength="16" autocomplete="off"></label>
      <label>proof link<span class="hint">${esc(TYPES[k].proof)}</span><input class="inp" name="url" placeholder="${k === 'video' ? 'https://www.tiktok.com/@you/video/…' : 'https://x.com/you/status/…'}" autocomplete="off"></label>
      <div class="err" data-err></div>
      <button class="btn btn-mint" type="submit">submit proof</button>
      <p class="hint muted" style="margin:0">this writes a memo from your wallet to the escrow. network fee only. the dev reviews it; approved = paid.</p>
    </form>`;
}

/* ---------- router ---------- */
function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  return { name: parts[0] || '', arg: parts[1] || '', q };
}
let lastRoute = '';
function render(soft) {
  const r = parseRoute();
  const key = location.hash;
  if (!soft && key !== lastRoute) {
    if (r.name === 'tasks') taskK = TYPES[r.q.get('k')] ? r.q.get('k') : 'all';
  }
  // keep what the user typed across a background refresh
  const keep = {}; let focusId = null, sel = null;
  $$('#app form').forEach(f => { keep[f.id] = [...new FormData(f).entries()]; });
  const ae = document.activeElement;
  if (ae && app.contains(ae) && (ae.id || ae.name)) { focusId = ae.id ? '#' + ae.id : `#${ae.form ? ae.form.id : ''} [name="${ae.name}"]`; try { sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) {} }
  const pages = { '': home, tasks: tasksPage, coin: () => coinPage(r.arg), leaderboard: leaderboardPage, earnings: () => earningsPage(r.arg), dashboard: dashboardPage, devs: () => devsPage(r.q.get('mint') || ''), receipts: receiptsPage };
  app.innerHTML = (pages[r.name] || notFound)();
  if (soft && key === lastRoute) {
    for (const [id, entries] of Object.entries(keep)) {
      const f = document.getElementById(id); if (!f) continue;
      for (const [n, v] of entries) { const el = f.elements[n]; if (el && typeof v === 'string') el.value = v; }
    }
    if (focusId) { const el = $(focusId); if (el) { el.focus(); try { if (sel) el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
  } else if (key !== lastRoute) { window.scrollTo(0, 0); }
  lastRoute = key;
  $$('#links a[data-r]').forEach(a => a.classList.toggle('on', a.dataset.r === r.name));
  $('#wallet-label').textContent = wallet.pk ? short(wallet.pk) : 'connect wallet';
  pill(); updateTools();
  const xl = $('[data-x-link]'); if (CFG.X_URL) { xl.href = CFG.X_URL; xl.hidden = false; }
  strip();
}
function notFound() { return `<section class="wrap ph"><h1>lost?</h1><p>that page isn't on the board.</p><div class="ctas mt"><a class="btn btn-mint" href="#/">back to the board</a></div></section>`; }
function strip() {
  const items = D.ev.slice(-14).reverse().map(e => { const [k, t, l] = evText(e); return `<span><b>${esc(k)}</b> · ${esc(t)}${l ? ' · ' + sol(l) + ' SOL' : ''}</span>`; });
  const base = items.length >= 4 ? items : items.concat(
    (CFG.ESCROW ? [] : ['<span><b>board</b> · opens with the CA</span>']).concat([
      '<span><b>escrow first</b> · work second</span>', '<span>raids · memes · threads · videos</span>',
      '<span><b>approved</b> = paid from escrow</span>', '<span>every payout gets a tx</span>', '<span>a dash is not a zero</span>']));
  const html = base.join('');
  const el = $('#strip'); if (el.dataset.h !== html) { el.innerHTML = html + html; el.dataset.h = html; }
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (a.tagName === 'BUTTON' || act === 'scroll') e.preventDefault();
  switch (act) {
    case 'enter': enterSite(); break;
    case 'menu': { const l = $('#links'); l.classList.toggle('open'); a.setAttribute('aria-expanded', l.classList.contains('open')); break; }
    case 'wallet': openModal(walletModal()); break;
    case 'pick-wallet': connectWith(providers()[+a.dataset.i]); break;
    case 'disconnect': disconnect(); break;
    case 'close-modal': closeModal(); break;
    case 'copy': copy(a.dataset.v); break;
    case 'ca-soon': toast('the CA drops at launch. follow along so you catch it.'); break;
    case 'scroll': { const t = document.getElementById(a.dataset.to); if (t) t.scrollIntoView({ behavior: 'smooth' }); break; }
    case 'retry': S.err = null; render(true); sync(); break;
    case 'tk': taskK = a.dataset.k; history.replaceState(null, '', '#/tasks' + (taskK !== 'all' ? '?k=' + taskK : '')); lastRoute = location.hash; render(true); break;
    case 'lb': lbWin = a.dataset.k; render(true); break;
    case 'rc': rcK = a.dataset.k; render(true); break;
    case 'take': {
      const t = D.tasks.get(a.dataset.task); if (!t) return;
      if (!wallet.pk) { openModal(walletModal()); toast('connect a wallet to take tasks'); return; }
      openModal(proofModal(t)); break;
    }
    case 'fund': {
      const c = D.coins.get(a.dataset.mint); if (!c) return;
      openModal(`<h3>fund $${esc(c.tk)}</h3><p class="muted">SOL goes to the escrow, tagged to ${esc(c.name)}. it becomes bounty pool.</p>
        <form class="form" id="f-fund-m" data-mint="${esc(c.mint)}" novalidate><label>amount (SOL)<input class="inp" name="sol" inputmode="decimal" placeholder="1"></label><div class="err" data-err></div><button class="btn btn-mint" type="submit">send to escrow</button></form>`);
      break;
    }
    case 'req': {
      const c = D.coins.get(a.dataset.mint); if (!c) return;
      openModal(`<h3>request withdrawal · $${esc(c.tk)}</h3><p class="muted">free right now: <b>${sol(Math.max(0, c.free))} SOL</b>. owed and reserved SOL stays in. it shows publicly as a withdrawal.</p>
        <form class="form" id="f-req" data-mint="${esc(c.mint)}" novalidate><label>amount (SOL)<input class="inp" name="sol" inputmode="decimal" placeholder="${sol(Math.max(0, c.free))}"></label><div class="err" data-err></div><button class="btn btn-or" type="submit">send request</button></form>`);
      break;
    }
    case 'approve': {
      const p = D.proofs.get(a.dataset.p); if (!p) return;
      await send({ t: 'ok', p: p.sig }); break;
    }
    case 'reject': {
      const p = D.proofs.get(a.dataset.p); if (!p) return;
      openModal(`<h3>reject proof</h3><p class="muted">the reason is public and stays on the record.</p><form class="form" id="f-no" data-p="${esc(p.sig)}" novalidate><label>reason<input class="inp" name="why" maxlength="100" placeholder="bot account / wrong tweet / no meme"></label><div class="err" data-err></div><button class="btn btn-red" type="submit">reject</button></form>`);
      break;
    }
    case 'close-task': await send({ t: 'close', task: a.dataset.task }); break;
    case 'pay': {
      const p = D.proofs.get(a.dataset.p); if (!p || !isOp()) return;
      if (p.t.c.pool < p.t.r) { toast('this pool can\'t cover that payout', true); return; }
      await send({ t: 'pay', p: p.sig }, { to: p.worker, lamports: p.t.r }); break;
    }
    case 'out': {
      const q = D.reqs.get(a.dataset.req); if (!q || !isOp()) return;
      const l = Math.min(q.l, Math.max(0, q.c.free));
      if (l <= 0) { toast('nothing free to send back', true); return; }
      await send({ t: 'out', mint: q.c.mint, req: q.sig }, { to: q.c.owner, lamports: l }); break;
    }
  }
});

function formErr(f, m) { const e = f.querySelector('[data-err]'); if (e) e.textContent = m || ''; return !m; }
function num(v) { v = String(v || '').replace(',', '.').trim(); return /^\d+(\.\d{1,9})?$/.test(v) ? Number(v) : NaN; }
document.addEventListener('submit', async e => {
  const f = e.target; if (!f.id) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f).entries());
  switch (f.id) {
    case 'f-earn': { const a = str(v.addr, 60); location.hash = '#/earnings/' + encodeURIComponent(a); break; }
    case 'f-list': {
      const mint = str(v.mint, 60), name = str(v.name, 32), tk = str(v.tk, 12).replace(/^\$/, ''), d = str(v.d, 140), x = str(v.x, 200);
      if (!B58.test(mint)) return formErr(f, 'that mint address doesn\'t look right.');
      if (D.coins.has(mint)) return formErr(f, 'that coin is already on the board.');
      if (!name) return formErr(f, 'give it a name.');
      if (!/^[A-Za-z0-9]{1,12}$/.test(tk)) return formErr(f, 'ticker: letters and numbers, up to 12.');
      if (x && !safeUrl(x)) return formErr(f, 'X link must start with https://');
      formErr(f, '');
      if (await send({ t: 'list', mint, name, tk: tk.toUpperCase(), d, x })) f.reset();
      break;
    }
    case 'f-fund': case 'f-fund-m': {
      const mint = f.dataset.mint || v.mint, amt = num(v.sol);
      if (!D.coins.has(mint)) return formErr(f, 'pick a listed coin.');
      if (!(amt > 0)) return formErr(f, 'enter an amount in SOL, like 0.5');
      if (amt > 10000) return formErr(f, 'that\'s more than this form takes in one go.');
      formErr(f, '');
      if (await send({ t: 'fund', mint }, { lamports: Math.round(amt * LPS) })) { f.reset(); if (f.id === 'f-fund-m') closeModal(); }
      break;
    }
    case 'f-task': {
      const c = D.coins.get(v.mint), n = Math.floor(num(v.n)), r = num(v.r), url = str(v.url, 200), txt = str(v.txt, 200);
      if (!c) return formErr(f, wallet.pk ? 'pick a coin you listed from this wallet.' : 'connect the wallet you listed with.');
      if (c.owner !== wallet.pk) return formErr(f, 'only the wallet that listed this coin can post its tasks.');
      if (!TYPES[v.k]) return formErr(f, 'pick a task type.');
      if (!(n >= 1 && n <= 1000)) return formErr(f, 'slots: a whole number from 1 to 1000.');
      if (!(r > 0)) return formErr(f, 'pay per slot in SOL, like 0.05');
      if (url && !safeUrl(url)) return formErr(f, 'target link must start with https://');
      if (v.k === 'raid' && !XRE.test(url)) return formErr(f, 'raids need the tweet to raid (an x.com status link).');
      if (Math.round(r * LPS) * n > c.free) return formErr(f, `pool can't cover it: needs ${sol(Math.round(r * LPS) * n)} SOL, free is ${sol(Math.max(0, c.free))}. fund the pool first.`);
      formErr(f, '');
      if (await send({ t: 'task', mint: c.mint, k: v.k, r, n, txt, url })) f.reset();
      break;
    }
    case 'f-proof': {
      const t = D.tasks.get(f.dataset.task); if (!t) return;
      const x = str(v.x, 16).replace(/^@/, ''), url = str(v.url, 200);
      if (!/^[A-Za-z0-9_]{1,15}$/.test(x)) return formErr(f, 'enter your X handle.');
      const xm = url.match(XRE);
      if (t.k === 'video' ? !(xm || VRE.test(url)) : !xm) return formErr(f, 'that link isn\'t ' + TYPES[t.k].proof + '.');
      if (xm && xm[1].toLowerCase() !== x.toLowerCase()) return formErr(f, `that post is from @${xm[1]}, not @${x}.`);
      if (t.url && url.split('?')[0] === t.url.split('?')[0]) return formErr(f, 'that\'s the target, not your proof.');
      formErr(f, '');
      if (await send({ t: 'proof', task: t.sig, url, x })) closeModal();
      break;
    }
    case 'f-no': {
      const why = str(v.why, 100);
      if (!why) return formErr(f, 'give a short reason.');
      if (await send({ t: 'no', p: f.dataset.p, why })) closeModal();
      break;
    }
    case 'f-req': {
      const c = D.coins.get(f.dataset.mint), amt = num(v.sol);
      if (!c) return;
      if (!(amt > 0)) return formErr(f, 'enter an amount in SOL.');
      if (Math.round(amt * LPS) > c.free) return formErr(f, `only ${sol(Math.max(0, c.free))} SOL is free.`);
      if (await send({ t: 'req', mint: c.mint, sol: amt })) closeModal();
      break;
    }
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'board-q') { boardQ = t.value; $('#board-grid').innerHTML = boardGrid(); }
  if (t.id === 'task-q') { taskQ = t.value; $('#task-grid').innerHTML = taskGrid(); }
  if (t.form && (t.form.id === 'f-check' || t.form.id === 'f-plan')) updateTools();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'board-sort') { boardSort = t.value; $('#board-grid').innerHTML = boardGrid(); }
  if (t.id === 'task-sort') { taskSort = t.value; $('#task-grid').innerHTML = taskGrid(); }
  if (t.id === 'task-open') { taskOpen = t.checked; $('#task-grid').innerHTML = taskGrid(); }
  if (t.form && (t.form.id === 'f-check' || t.form.id === 'f-plan')) updateTools();
  if (t.form && t.form.id === 'f-task' && t.name === 'mint') { const n = $('#task-cover'); if (n) n.innerHTML = coverNote(D.coins.get(t.value)); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); if (e.key === 'Enter' && intro.ready && !intro.done) enterSite(); });
window.addEventListener('hashchange', () => { $('#links').classList.remove('open'); closeModal(); render(); });
setInterval(() => { $$('[data-since]').forEach(el => { el.textContent = dur(+el.dataset.since); }); $$('[data-synced]').forEach(el => { el.textContent = syncedTxt(); }); pill(); }, 1000);
setInterval(() => { if (!document.hidden) sync(); }, CFG.REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

/* ---------- boot ---------- */
$$('[data-mark]').forEach(el => { el.innerHTML = MARK; });
render();
introStep(35, CFG.ESCROW ? 'unlocking the escrow…' : 'setting up the board…');
if (!CFG.ESCROW) introReady('the board opens with the CA.');
setTimeout(() => introReady('taking a while. the board keeps loading inside.'), 7000);
sync();
(function autoConnect() {
  const n = LS.get('bw:wallet'); if (!n) return;
  const tryIt = () => { const x = providers().find(p => p.name === n); if (x) connectWith(x, true); };
  if (document.readyState === 'complete') setTimeout(tryIt, 300); else window.addEventListener('load', () => setTimeout(tryIt, 300));
})();
})();
