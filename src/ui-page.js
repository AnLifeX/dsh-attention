/**
 * 回复小窗（浏览器备选）。主路径是右下角 WPF 毛玻璃卡片。
 */
export function renderReplyHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>提醒</title>
  <style>
    :root {
      color-scheme: light;
      --page: #d7e4e1;
      --card: #fafcfb;
      --chip: #ecf2f0;
      --line: #b0c4be;
      --border: #0f766e;
      --text: #1c2422;
      --muted: #5a6c68;
      --accent: #0f766e;
      --accent-hover: #0d5e58;
      --accent-soft: #dcf2ee;
      --accent-fg: #0f5e58;
      --danger: #dc2626;
      --ok: #059669;
      --glow: rgba(15, 118, 110, .42);
      --glow-strong: rgba(20, 184, 166, .55);
      --on-accent: #fff;
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --page: #121618;
      --card: #1c2022;
      --chip: #2a3234;
      --line: #405450;
      --border: #2dd4bf;
      --text: #ecf2f0;
      --muted: #9caead;
      --accent: #2dd4bf;
      --accent-hover: #14b8a6;
      --accent-soft: #123632;
      --accent-fg: #99f6e4;
      --danger: #f87171;
      --ok: #34d399;
      --glow: rgba(45, 212, 191, .38);
      --glow-strong: rgba(45, 212, 191, .7);
      --on-accent: #08201c;
    }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme="light"]) {
        color-scheme: dark;
        --page: #121618;
        --card: #1c2022;
        --chip: #2a3234;
        --line: #405450;
        --border: #2dd4bf;
        --text: #ecf2f0;
        --muted: #9caead;
        --accent: #2dd4bf;
        --accent-hover: #14b8a6;
        --accent-soft: #123632;
        --accent-fg: #99f6e4;
        --danger: #f87171;
        --ok: #34d399;
        --glow: rgba(45, 212, 191, .38);
        --glow-strong: rgba(45, 212, 191, .7);
        --on-accent: #08201c;
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background: var(--page);
      color: var(--text);
      font: 14px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    body { padding: 28px 22px 32px; }
    .card {
      max-width: 480px;
      margin: 0 auto;
      background: rgba(250, 252, 251, var(--card-alpha, .78));
      border: 1px solid rgba(255, 255, 255, .5);
      border-radius: 18px;
      padding: 20px 20px 12px;
      box-sizing: border-box;
      backdrop-filter: blur(18px);
      box-shadow: 0 16px 40px rgba(0, 0, 0, .18);
    }
    html[data-theme="dark"] .card,
    html:not([data-theme="light"]) .card {
      background: rgba(28, 32, 34, var(--card-alpha, .78));
      border-color: rgba(255, 255, 255, .14);
    }
    @media (prefers-color-scheme: light) {
      html:not([data-theme="dark"]) .card {
        background: rgba(250, 252, 251, var(--card-alpha, .78));
        border-color: rgba(255, 255, 255, .5);
      }
    }
    .kicker {
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 650;
    }
    h1 { font-size: 18px; margin: 6px 0 4px; font-weight: 650; color: var(--text); }
    .sub { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
    .q { border-top: 1px solid var(--line); padding: 14px 0 4px; }
    .q h2 { font-size: 14px; margin: 0 0 8px; font-weight: 600; color: var(--text); }
    .opt {
      display: block;
      width: 100%;
      text-align: left;
      padding: 12px 16px;
      border: 1px solid var(--line);
      border-radius: 14px;
      margin: 0 0 8px;
      cursor: pointer;
      background: var(--chip);
      color: var(--text);
      font: inherit;
      transition: border-color .15s ease, background .15s ease, transform .12s ease, box-shadow .15s ease;
    }
    .opt:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
      transform: translateY(-1px);
    }
    .opt.on {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent-fg);
    }
    .opt .lab { font-weight: 600; }
    .opt .desc { color: var(--muted); font-size: 12px; margin-top: 2px; }
    textarea, input[type=text] {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--chip);
      color: var(--text);
      border-radius: 14px;
      padding: 10px 14px;
      font: inherit;
      outline: none;
    }
    textarea { min-height: 120px; resize: vertical; }
    textarea:focus, input[type=text]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--glow);
    }
    .actions { display: flex; justify-content: space-between; gap: 8px; margin-top: 16px; }
    .primary, .ghost, .session {
      appearance: none;
      border: 0;
      border-radius: 12px;
      padding: 8px 16px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .ghost { background: #f43f5e; color: #fff; border: 0; }
    .session { background: #2563eb; color: #fff; }
    .primary { background: var(--accent); color: var(--on-accent); }
    .primary:hover { background: var(--accent-hover); }
    .primary:disabled, .opt:disabled { opacity: .45; cursor: default; transform: none; box-shadow: none; }
    .err { color: var(--danger); font-size: 13px; min-height: 18px; margin: 8px 0 0; }
    .ok { color: var(--ok); }
    .gone { color: var(--muted); padding: 24px 8px; text-align: center; }
    .timer { height: 6px; border-radius: 99px; background: rgba(0,0,0,.12); margin: 14px 0 2px; overflow: hidden; }
    .timer > i { display: block; height: 100%; width: 100%; border-radius: 99px; background: #10b981; }
  </style>
</head>
<body>
  <div class="card" id="root"><p class="sub">加载中…</p></div>
  <script>
    const token = new URLSearchParams(location.search).get('t') || '';
    const root = document.getElementById('root');
    const headers = { 'x-dsh-attention': '1', 'accept': 'application/json' };

    function applyTheme(theme) {
      const next = theme === 'dark' || theme === 'light' ? theme : '';
      if (!next) return;
      document.documentElement.setAttribute('data-theme', next);
      document.documentElement.style.colorScheme = next;
    }

    function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
    function timerColor(ratio) {
      const g = [16, 185, 129], y = [234, 179, 8], r = [239, 68, 68];
      const p = ratio >= 0.5 ? (1 - ratio) / 0.5 : (0.5 - ratio) / 0.5;
      const from = ratio >= 0.5 ? g : y;
      const to = ratio >= 0.5 ? y : r;
      return 'rgb(' + lerp(from[0], to[0], p) + ',' + lerp(from[1], to[1], p) + ',' + lerp(from[2], to[2], p) + ')';
    }
    function startTimer(sec) {
      const n = Number(sec);
      if (!n || n <= 0) return;
      const wrap = el('div', { class: 'timer' });
      const bar = document.createElement('i');
      wrap.appendChild(bar);
      root.appendChild(wrap);
      const t0 = Date.now();
      const tick = () => {
        const left = n - (Date.now() - t0) / 1000;
        if (left <= 0) { try { window.close(); } catch {} return; }
        const ratio = Math.max(0, left / n);
        bar.style.width = (ratio * 100) + '%';
        bar.style.background = timerColor(ratio);
        requestAnimationFrame(tick);
      };
      tick();
    }

    function el(tag, attrs, kids) {
      const node = document.createElement(tag);
      if (attrs) Object.entries(attrs).forEach(([k, v]) => {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (v != null) node.setAttribute(k, v);
      });
      (kids || []).forEach((c) => c && node.appendChild(c));
      return node;
    }

    function renderGone(text) {
      root.replaceChildren(el('p', { class: 'gone', text }));
    }

    async function submit(payload) {
      const res = await fetch('/dsh-attention/act', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ t: token, ...payload }),
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    function markDone(err, text) {
      err.className = 'err ok';
      err.textContent = text || '已提交，可以关掉这个窗口。';
      setTimeout(() => window.close(), 700);
    }

    function fail(err, error) {
      const message = String(error && error.message ? error.message : error);
      err.className = 'err';
      err.textContent = message;
      try { window.alert(message); } catch {}
    }

    function renderIdle() {
      const area = el('textarea', { id: 'task', placeholder: '下一步想让它做什么…' });
      const err = el('p', { class: 'err' });
      const send = el('button', { class: 'primary', type: 'button', text: '发送' });
      send.addEventListener('click', async () => {
        const text = area.value.trim();
        if (!text) { err.textContent = '先写一句再发送。'; return; }
        send.disabled = true;
        err.textContent = '';
        try {
          await submit({ a: 'send', text });
          markDone(err);
        } catch (e) {
          send.disabled = false;
          fail(err, e);
        }
      });
      root.replaceChildren(
        el('div', { class: 'kicker', text: '提醒' }),
        el('h1', { text: '会话已结束' }),
        el('p', { class: 'sub', text: '写下一步任务，直接发给这条会话。' }),
        area,
        err,
        el('div', { class: 'actions' }, [send])
      );
      area.focus();
    }

    function renderQuestion(data) {
      const questions = data.questions || [];
      const err = el('p', { class: 'err' });
      const picked = {};
      questions.forEach((q) => { picked[q.id] = []; });
      const needSubmit = questions.length > 1 || questions.some((q) => q.multiSelect === true);

      async function sendAnswers() {
        const answers = questions.map((q) => ({ id: q.id, selected: picked[q.id] || [] }));
        const missing = answers.findIndex((a) => a.selected.length === 0);
        if (missing >= 0) { err.textContent = '还有问题没选。'; return; }
        try {
          await submit({ a: 'answer', answers });
          markDone(err);
        } catch (e) {
          fail(err, e);
        }
      }

      const blocks = questions.map((q) => {
        const options = (q.options || []).map((opt) => {
          const btn = el('button', { class: 'opt', type: 'button' }, [
            el('div', { class: 'lab', text: opt.label }),
            opt.description ? el('div', { class: 'desc', text: opt.description }) : null,
          ]);
          btn.addEventListener('click', async () => {
            if (q.multiSelect === true) {
              const cur = picked[q.id];
              const at = cur.indexOf(opt.label);
              if (at >= 0) { cur.splice(at, 1); btn.classList.remove('on'); }
              else { cur.push(opt.label); btn.classList.add('on'); }
              return;
            }
            picked[q.id] = [opt.label];
            btn.classList.add('on');
            if (needSubmit) return;
            btn.disabled = true;
            err.textContent = '';
            await sendAnswers();
          });
          return btn;
        });
        return el('section', { class: 'q' }, [
          el('h2', { text: q.question || '请选择' }),
          ...options,
        ]);
      });

      const kids = [
        el('div', { class: 'kicker', text: '提醒' }),
        el('h1', { text: questions.length > 1 ? '需要你做几项选择' : '需要你做选择' }),
        el('p', { class: 'sub', text: needSubmit ? '先点选项，再点提交。' : '点一个选项就会提交，会话会继续。' }),
        ...blocks,
        err,
      ];
      if (needSubmit) {
        const send = el('button', { class: 'primary', type: 'button', text: '提交' });
        send.addEventListener('click', async () => {
          send.disabled = true;
          err.textContent = '';
          try { await sendAnswers(); }
          catch (e) { send.disabled = false; fail(err, e); }
        });
        kids.push(el('div', { class: 'actions' }, [send]));
      }
      root.replaceChildren(...kids);
    }

    function renderApproval() {
      const err = el('p', { class: 'err' });
      const allow = el('button', { class: 'primary', type: 'button', text: '允许一次' });
      const deny = el('button', { class: 'ghost', type: 'button', text: '拒绝' });
      const go = async (a) => {
        allow.disabled = deny.disabled = true;
        try {
          await submit({ a });
          markDone(err);
        } catch (e) {
          allow.disabled = deny.disabled = false;
          fail(err, e);
        }
      };
      allow.addEventListener('click', () => go('allow'));
      deny.addEventListener('click', () => go('reject'));
      root.replaceChildren(
        el('div', { class: 'kicker', text: '提醒' }),
        el('h1', { text: '需要审批' }),
        el('p', { class: 'sub', text: '允许一次或拒绝这次提权。' }),
        err,
        el('div', { class: 'actions' }, [deny, allow])
      );
    }

    fetch('/dsh-attention/pending?t=' + encodeURIComponent(token), { headers, cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        applyTheme(data && data.theme);
        if (data && typeof data.cardOpacity === 'number') {
          document.documentElement.style.setProperty('--card-alpha', String(data.cardOpacity));
        }
        if (!data || !data.ok) return renderGone('这条通知已经失效，请回到原来的 dsh 窗口。');
        if (data.kind === 'idle') renderIdle();
        else if (data.kind === 'question') renderQuestion(data);
        else if (data.kind === 'approval') renderApproval();
        else return renderGone('没有可处理的内容。');
        startTimer(data.timeoutSec);
      })
      .catch(() => renderGone('连不上 dsh。请确认 dsh web 还在跑。'));
  </script>
</body>
</html>`
}