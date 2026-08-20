/**
 * 回复小窗（浏览器备选）。主路径是右下角 WinForms，点选项立刻提交。
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
      color-scheme: dark;
      --bg: #101216;
      --card: #1a1d24;
      --line: rgba(255,255,255,.08);
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #0f766e;
      --accent-2: #14b8a6;
      --danger: #ef4444;
      --ok: #10b981;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    body { padding: 20px 18px 24px; }
    .card {
      max-width: 480px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px 18px 16px;
      box-sizing: border-box;
      box-shadow: 0 18px 40px rgba(0,0,0,.35);
    }
    .kicker {
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--accent-2);
      font-weight: 650;
    }
    h1 { font-size: 18px; margin: 6px 0 4px; font-weight: 650; }
    .sub { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
    .q { border-top: 1px solid var(--line); padding: 14px 0 4px; }
    .q h2 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
    .opt {
      display: block;
      width: 100%;
      text-align: left;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      margin: 0 0 8px;
      cursor: pointer;
      background: #12141a;
      color: var(--text);
      font: inherit;
    }
    .opt:hover { border-color: rgba(20,184,166,.45); }
    .opt.on { border-color: var(--accent-2); background: #103532; }
    .opt .lab { font-weight: 600; }
    .opt .desc { color: var(--muted); font-size: 12px; margin-top: 2px; }
    textarea, input[type=text] {
      width: 100%;
      border: 1px solid var(--line);
      background: #12141a;
      color: var(--text);
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
      outline: none;
    }
    textarea { min-height: 120px; resize: vertical; }
    textarea:focus, input[type=text]:focus { border-color: var(--accent-2); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .primary, .ghost {
      appearance: none;
      border: 0;
      border-radius: 10px;
      padding: 8px 16px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); }
    .primary { background: var(--accent); color: #fff; }
    .primary:disabled, .opt:disabled { opacity: .45; cursor: default; }
    .err { color: var(--danger); font-size: 13px; min-height: 18px; margin: 8px 0 0; }
    .ok { color: var(--ok); }
    .gone { color: var(--muted); padding: 24px 8px; text-align: center; }
  </style>
</head>
<body>
  <div class="card" id="root"><p class="sub">加载中…</p></div>
  <script>
    const token = new URLSearchParams(location.search).get('t') || '';
    const root = document.getElementById('root');
    const headers = { 'x-dsh-attention': '1', 'accept': 'application/json' };

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
        if (!data || !data.ok) return renderGone('这条通知已经失效，请回到原来的 dsh 窗口。');
        if (data.kind === 'idle') return renderIdle();
        if (data.kind === 'question') return renderQuestion(data);
        if (data.kind === 'approval') return renderApproval();
        renderGone('没有可处理的内容。');
      })
      .catch(() => renderGone('连不上 dsh。请确认 dsh web 还在跑。'));
  </script>
</body>
</html>`
}