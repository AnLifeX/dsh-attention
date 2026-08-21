/**
 * dsh-attention — 浏览器半边。
 *
 * - 休眠/隐藏后唤醒重连
 * - 向宿主汇报标签是否聚焦
 * - 消费 /dsh-attention/focus 切到对应会话
 * - 设置 → 提醒：卡片式配置入口
 */
window.__ModuleLoader__.load({
	id: "dsh-attention",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = null;
		try { react = require("react"); } catch { react = null; }

		const STORAGE_KEY = "dsh-attention:reload-lock";
		const DEFAULT_HIDDEN_RELOAD_MS = 8000;
		const CLOCK_JUMP_MS = 45000;
		const HEARTBEAT_MS = 4000;
		const PRESENCE_MS = 2000;
		const FOCUS_POLL_MS = 800;
		const INPUT_GRACE_MS = 2000;
		const NS = "dsh-attention";
		const BELL_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23000' d='M8 1.5C5.9 1.5 4.2 3.2 4.2 5.3v1.6c0 .7-.3 1.4-.8 1.9L2.4 10v.9h11.2V10l-1-1.2c-.5-.5-.8-1.2-.8-1.9V5.3C11.8 3.2 10.1 1.5 8 1.5zM6.1 12.4C6.5 13.4 7.4 14 8.5 14s2-.6 2.4-1.6H6.1z'/%3E%3Ccircle cx='11.6' cy='3.5' r='2.1'/%3E%3C/svg%3E\") 50%/contain no-repeat";

		const zh = {
			nav: "提醒",
			cardNotify: "通知",
			cardNotifyDesc: "什么时候提醒，以及用系统卡片还是自制卡片。",
			cardWake: "休眠唤醒",
			cardWakeDesc: "标签被冻住后再回来时，是否强制刷新把卡片重放出来。",
			enabled: "启用通知",
			enabledHint: "关掉后不再提醒，设置页仍然可用。",
			notifyStyle: "卡片样式",
			notifyStyleHint: "二选一，不会同时弹两种。",
			styleSystem: "系统通知卡片",
			styleSystemHint: "只支持点一下回到会话。点通知本体走自定义协议，尽量前置已有窗口。没反应时用「打开会话」：会打开 dsh 并切到那条会话（可能是新标签，不再闪一下就关）。不能在通知里选择、回复或提权。",
			styleCustom: "自制卡片",
			styleCustomHint: "右下角窗口。支持单选、多选、自定义输入、提权允许/拒绝，以及一轮结束后写下一步。卡片上的「回到会话」按下面的复用 / 新开设置执行。",
			notifyApproval: "提权审批",
			notifyQuestion: "提问 / 选择",
			notifyIdle: "一轮对话结束",
			rootsOnly: "只提醒根会话",
			rootsOnlyHint: "子代理的审批和提问不刷屏。",
			soundEnabled: "提示音",
			webUrl: "页面地址",
			webUrlHint: "系统卡片「打开会话」、自制卡片「回到会话」时用来找已有窗口，或作为新开时的地址。",
			openSessionMode: "回到会话",
			openSessionModeHint: "建议把 dsh 安装成 Edge 应用后选「复用已有窗口」；在普通浏览器标签里请选「新开」。",
			openReuse: "复用已有窗口",
			openReuseHint: "前置已经打开的 dsh 应用或窗口，并切到对应会话。Edge 应用下最稳。",
			openNew: "新开一个",
			openNewHint: "每次都新开一个页面打开该会话。普通浏览器标签请用这个。",
			openReuseWarn: "当前不是 Edge 应用，而是普通浏览器标签。这时选「复用已有窗口」经常找不到标签或看起来没反应，建议改成「新开」，或把本站安装成应用后再选复用。",
			hiddenReloadSec: "隐藏多久后刷新（秒）",
			hiddenReloadSecHint: "标签切走超过这么多秒再回来时，刷新一次，避免卡片卡住。改完点保存后立即生效。",
			cooldownMs: "同一会话提醒间隔（毫秒）",
			cooldownMsHint: "同一会话连续弹提醒的最短间隔，避免刷屏。",
			notifyTimeoutSec: "停留时间（秒）",
			notifyTimeoutSecHint: "到点自动消失。填 0 则一直留到你关掉。系统通知屏幕上只有约 7 秒 / 25 秒两档；自制卡片按填写的秒数。",
			saved: "已保存",
			saveFailed: "保存失败",
			unsaved: "未保存",
			discard: "放弃",
			save: "保存",
			saving: "保存中…",
			expand: "展开",
			collapse: "收起"
		};
		const en = {
			nav: "Attention",
			cardNotify: "Notifications",
			cardNotifyDesc: "When to notify, and whether to use the system toast or the custom card.",
			cardWake: "Wake after sleep",
			cardWakeDesc: "Reload the tab after it was frozen so pending cards come back.",
			enabled: "Enable notifications",
			enabledHint: "Turns off notifications only. This settings page stays available.",
			notifyStyle: "Card style",
			notifyStyleHint: "Pick one. Both styles never show together.",
			styleSystem: "System toast",
			styleSystemHint: "Click to return to the session. The toast body tries to focus an existing window. Use Open session if that does nothing: it opens dsh on that conversation (may use a new tab, and no longer flashes closed). No in-toast choices, replies, or approvals.",
			styleCustom: "Custom card",
			styleCustomHint: "A bottom-right window for single-select, multi-select, custom answers, allow/deny, and a next-step prompt when a turn ends. Return to session on the card follows the Reuse / Open new setting below.",
			notifyApproval: "Sandbox approvals",
			notifyQuestion: "Questions / choices",
			notifyIdle: "Turn ended",
			rootsOnly: "Root sessions only",
			rootsOnlyHint: "Ignore subagent approvals and questions.",
			soundEnabled: "Sound",
			webUrl: "Page URL",
			webUrlHint: "Used to find an existing window, or as the address when opening a new one.",
			openSessionMode: "Return to session",
			openSessionModeHint: "If dsh is installed as an Edge app, choose Reuse existing window. In a normal browser tab, choose Open new.",
			openReuse: "Reuse existing window",
			openReuseHint: "Bring the already-open dsh app or window to the front and switch to that session. Most reliable as an Edge app.",
			openNew: "Open new",
			openNewHint: "Always open a new page for that session. Use this in a normal browser tab.",
			openReuseWarn: "This window is a normal browser tab, not an Edge app. Reuse existing window often fails to find the tab. Choose Open new, or install this site as an app and then use Reuse.",
			hiddenReloadSec: "Reload after hidden (seconds)",
			hiddenReloadSecHint: "If the tab was away longer than this, reload once when you come back so pending cards return. Takes effect as soon as you save.",
			cooldownMs: "Minimum gap between alerts (ms)",
			cooldownMsHint: "Ignore another reminder for the same session until this many milliseconds have passed.",
			notifyTimeoutSec: "Stay on screen (seconds)",
			notifyTimeoutSecHint: "Auto-hide after this many seconds. 0 keeps it until you dismiss it. System toasts only stay about 7s or 25s on screen; the custom card uses the exact value.",
			saved: "Saved",
			saveFailed: "Save failed",
			unsaved: "Unsaved",
			discard: "Discard",
			save: "Save",
			saving: "Saving…",
			expand: "Expand",
			collapse: "Collapse"
		};

		const NOTIFY_KEYS = ["enabled", "notifyStyle", "notifyTimeoutSec", "notifyApproval", "notifyQuestion", "notifyIdle", "rootsOnly", "soundEnabled", "webUrl", "openSessionMode"];
		const WAKE_KEYS = ["hiddenReloadMs", "cooldownMs"];

		function pickKeys(obj, keys) {
			const out = {};
			for (const key of keys) {
				if (obj?.[key] !== undefined) out[key] = obj[key];
			}
			return out;
		}

		function samePick(a, b, keys) {
			for (const key of keys) {
				let left = a?.[key];
				let right = b?.[key];
				if (key === "hiddenReloadMs" || key === "cooldownMs") {
					left = Math.max(0, Math.floor(Number(left) || 0));
					right = Math.max(0, Math.floor(Number(right) || 0));
				} else if (key === "notifyTimeoutSec") {
					left = Number.isFinite(Number(left)) ? Math.max(0, Math.min(86400, Math.floor(Number(left)))) : 30;
					right = Number.isFinite(Number(right)) ? Math.max(0, Math.min(86400, Math.floor(Number(right)))) : 30;
				} else if (key === "webUrl" || key === "notifyStyle" || key === "openSessionMode") {
					left = String(left || "").trim();
					right = String(right || "").trim();
				}
				if (left !== right) return false;
			}
			return true;
		}

		function typingRecently(lastInputAt, now) {
			return now - lastInputAt < INPUT_GRACE_MS;
		}

		function pageFocused() {
			return document.visibilityState === "visible" && document.hasFocus();
		}

		function isStandaloneApp() {
			if (typeof window === "undefined") return false;
			try {
				if (window.matchMedia("(display-mode: standalone)").matches) return true;
				if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
				if (window.matchMedia("(display-mode: window-controls-overlay)").matches) return true;
			} catch { /* ignore */ }
			try {
				if (navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible) return true;
			} catch { /* ignore */ }
			try {
				if (navigator.standalone === true) return true;
			} catch { /* ignore */ }
			return false;
		}

		function reloadOnce(reason) {
			try {
				const now = Date.now();
				const prev = Number(sessionStorage.getItem(STORAGE_KEY) || 0);
				if (now - prev < 4000) return;
				sessionStorage.setItem(STORAGE_KEY, String(now));
			} catch {
				/* private mode */
			}
			console.info("[dsh-attention] reload after sleep/stale mux:", reason);
			location.reload();
		}

		async function readConfig() {
			try {
				const response = await fetch("/dsh-attention/config", { cache: "no-store" });
				if (!response.ok) return { hiddenReloadMs: DEFAULT_HIDDEN_RELOAD_MS };
				return await response.json();
			} catch {
				return { hiddenReloadMs: DEFAULT_HIDDEN_RELOAD_MS };
			}
		}

		function isDarkScheme() {
			if (typeof document === "undefined") return false;
			try {
				if (document.documentElement && document.documentElement.style.colorScheme !== "") {
					return document.body.hasAttribute("data-ds-dark-theme");
				}
			} catch { /* ignore */ }
			try {
				return window.matchMedia("(prefers-color-scheme: dark)").matches;
			} catch {
				return false;
			}
		}

		function currentTheme() {
			return isDarkScheme() ? "dark" : "light";
		}

		function postPresence(sessionId) {
			const body = JSON.stringify({
				focused: pageFocused(),
				sessionId: sessionId || undefined,
				title: (typeof document !== "undefined" && document.title) ? String(document.title) : undefined,
				theme: currentTheme()
			});
			fetch("/dsh-attention/presence", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				cache: "no-store",
				keepalive: true,
			}).catch(() => {});
		}

		function currentSessionId(sessions) {
			try {
				const snap = sessions?.list?.getSnapshot?.();
				return snap?.current || "";
			} catch {
				return "";
			}
		}

		const FOCUS_WINDOW_NAME = "dsh-web";
		const FOCUS_CHANNEL = "dsh-attention";
		const FOCUS_HASH_PREFIX = "dsh-attention=";
		const TITLE_MARK = " · dsh";

		function ensureTitleMark() {
			try {
				const title = String(document.title || "");
				if (!title) return;
				if (/\bdsh\b|DeepSeek|Harness/i.test(title)) return;
				document.title = title + TITLE_MARK;
			} catch { /* ignore */ }
		}

		function parseFocusHash(hash) {
			const raw = String(hash || "");
			const body = raw.charAt(0) === "#" ? raw.slice(1) : raw;
			if (body.indexOf(FOCUS_HASH_PREFIX) !== 0) return "";
			try {
				return decodeURIComponent(body.slice(FOCUS_HASH_PREFIX.length).split("&")[0] || "");
			} catch {
				return "";
			}
		}

		function takeFocusHash() {
			const id = parseFocusHash(location.hash);
			if (!id) return "";
			try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
			return id;
		}

		function openSession(sessions, sessionId) {
			if (!sessionId || !sessions || typeof sessions.open !== "function") return false;
			try {
				sessions.open(sessionId);
				return true;
			} catch {
				try { sessions.open(sessionId); return true; } catch { return false; }
			}
		}

		function consumeFocus(sessions) {
			fetch("/dsh-attention/focus", { cache: "no-store" })
				.then((response) => response.json())
				.then((data) => {
					const sessionId = data?.sessionId;
					if (sessionId) openSession(sessions, sessionId);
				})
				.catch(() => {});
		}

		function installStyles() {
			const id = "dsh-attention/styles.css";
			if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + id + '"]')) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-attention";
			tag.dataset.pluginCss = id;
			tag.textContent = [
				".dshatt_page{display:flex;flex-direction:column;gap:14px;min-width:0;width:100%;max-width:760px;box-sizing:border-box;padding:4px 2px 24px;white-space:normal}",
				".dshatt_list{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}",
				".dshatt_card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1,#fff));border-radius:12px;overflow:hidden}",
				".dshatt_card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.45))}",
				".dshatt_card_open{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.04))}",
				".dshatt_card_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;display:flex;align-items:center;gap:12px;padding:14px 16px}",
				".dshatt_card_text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
				".dshatt_card_name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.4}",
				".dshatt_card_desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-weight:400}",
				".dshatt_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
				".dshatt_chevron_open{transform:rotate(180deg)}",
				".dshatt_body{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12));margin:0 16px;padding:4px 0 12px;display:flex;flex-direction:column}",
				".dshatt_row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0}",
				".dshatt_row+.dshatt_row{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12))}",
				".dshatt_row_stack{flex-direction:column;align-items:stretch;gap:8px}",
				".dshatt_copy{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".dshatt_row>label.dshatt_copy{cursor:pointer}",
				".dshatt_label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:1.45}",
				".dshatt_hint{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}",
				".dshatt_check{width:16px;height:16px;margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary,#0f766e);cursor:pointer}",
				".dshatt_choice{display:flex;flex-direction:column;gap:10px;padding:4px 0 8px}",
				".dshatt_choice_item{display:flex;align-items:flex-start;gap:10px;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));border-radius:10px;cursor:pointer}",
				".dshatt_choice_item_on{border-color:var(--dsw-alias-brand-primary,#0f766e);background:rgba(15,118,110,.08)}",
				".dshatt_choice_item input{margin:3px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary,#0f766e);cursor:pointer}",
				".dshatt_unsaved{white-space:nowrap;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));border-radius:999px;flex:none;padding:2px 8px;font-size:11px;font-weight:500;line-height:16px}",
				".dshatt_footer{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12));display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 0 4px}",
				".dshatt_failed{min-width:0;color:var(--dsw-alias-state-error-primary,#ef4444);flex:1;margin:0;font-size:12px;line-height:1.5}",
				".dshatt_btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
				".dshatt_btn:disabled{opacity:.4;cursor:default}",
				".dshatt_btn_outline{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.25));color:var(--dsw-alias-label-secondary)}",
				".dshatt_btn_outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.45))}",
				".dshatt_btn_primary{background:var(--dsw-alias-label-primary,#111);color:var(--dsw-alias-bg-layer-3,#fff)}",
				".dshatt_warn{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warning-primary,#ca8a04)}",
				".dshatt_input{background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08)));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:6px;padding:8px 12px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;width:100%;box-sizing:border-box;outline:none}",
				".dshatt_input:focus{border-color:var(--dsw-alias-brand-primary,#0f766e);box-shadow:0 0 0 2px rgba(15,118,110,.22)}",
				".dshatt_toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-state-success-primary,#10b981);color:#fff;padding:8px 18px;border-radius:999px;font-size:12.5px;font-weight:500;z-index:100000}",
				".dshatt_toast_err{background:var(--dsw-alias-state-error-primary,#ef4444)}",
				"[data-dshatt-nav]>[class*='_navIcon']{display:none}",
				"[data-dshatt-nav]:before{content:'';background:currentColor;flex:none;width:16px;height:16px;-webkit-mask:" + BELL_MASK + ";mask:" + BELL_MASK + "}"
			].join("\n");
			document.head.appendChild(tag);
		}

		function StyleChoice({ t, value, disabled, onChange, name }) {
			const current = value === "system" ? "system" : "custom";
			const options = [
				{ id: "system", labelKey: "styleSystem", hintKey: "styleSystemHint" },
				{ id: "custom", labelKey: "styleCustom", hintKey: "styleCustomHint" }
			];
			return react.createElement("div", { className: "dshatt_row dshatt_row_stack" }, [
				react.createElement("span", { className: "dshatt_copy", key: "c" }, [
					react.createElement("span", { className: "dshatt_label", key: "l" }, t("notifyStyle")),
					react.createElement("span", { className: "dshatt_hint", key: "h" }, t("notifyStyleHint"))
				]),
				react.createElement("div", { className: "dshatt_choice", key: "opts" }, options.map((opt) => {
					const on = current === opt.id;
					return react.createElement("label", {
						key: opt.id,
						className: "dshatt_choice_item" + (on ? " dshatt_choice_item_on" : "")
					}, [
						react.createElement("input", {
							type: "radio",
							name: name || "dshatt-notify-style",
							value: opt.id,
							checked: on,
							disabled: disabled === true,
							onClick: (event) => event.stopPropagation(),
							onChange: (event) => {
								event.stopPropagation();
								if (event.target.checked) onChange(opt.id);
							},
							key: "i"
						}),
						react.createElement("span", { className: "dshatt_copy", key: "t" }, [
							react.createElement("span", { className: "dshatt_label", key: "l" }, t(opt.labelKey)),
							react.createElement("span", { className: "dshatt_hint", key: "h" }, t(opt.hintKey))
						])
					]);
				}))
			]);
		}

		function OpenSessionChoice({ t, value, disabled, onChange, name, standalone }) {
			const current = value === "new" ? "new" : "reuse";
			const options = [
				{ id: "reuse", labelKey: "openReuse", hintKey: "openReuseHint" },
				{ id: "new", labelKey: "openNew", hintKey: "openNewHint" }
			];
			return react.createElement("div", { className: "dshatt_row dshatt_row_stack" }, [
				react.createElement("span", { className: "dshatt_copy", key: "c" }, [
					react.createElement("span", { className: "dshatt_label", key: "l" }, t("openSessionMode")),
					react.createElement("span", { className: "dshatt_hint", key: "h" }, t("openSessionModeHint"))
				]),
				react.createElement("div", { className: "dshatt_choice", key: "opts" }, options.map((opt) => {
					const on = current === opt.id;
					return react.createElement("label", {
						key: opt.id,
						className: "dshatt_choice_item" + (on ? " dshatt_choice_item_on" : "")
					}, [
						react.createElement("input", {
							type: "radio",
							name: name || "dshatt-open-session-mode",
							value: opt.id,
							checked: on,
							disabled: disabled === true,
							onClick: (event) => event.stopPropagation(),
							onChange: (event) => {
								event.stopPropagation();
								if (event.target.checked) onChange(opt.id);
							},
							key: "i"
						}),
						react.createElement("span", { className: "dshatt_copy", key: "t" }, [
							react.createElement("span", { className: "dshatt_label", key: "l" }, t(opt.labelKey)),
							react.createElement("span", { className: "dshatt_hint", key: "h" }, t(opt.hintKey))
						])
					]);
				})),
				current === "reuse" && standalone !== true
					? react.createElement("p", { className: "dshatt_warn", role: "status", key: "warn" }, t("openReuseWarn"))
					: null
			]);
		}

		function ToggleRow({ t, labelKey, hintKey, checked, disabled, onChange }) {
			const id = "dshatt-" + labelKey;
			return react.createElement("div", { className: "dshatt_row" }, [
				react.createElement("label", { className: "dshatt_copy", htmlFor: id, key: "c" }, [
					react.createElement("span", { className: "dshatt_label", key: "l" }, t(labelKey)),
					hintKey ? react.createElement("span", { className: "dshatt_hint", key: "h" }, t(hintKey)) : null
				]),
				react.createElement("input", {
					id,
					type: "checkbox",
					className: "dshatt_check",
					checked: checked === true,
					disabled: disabled === true,
					onClick: (event) => event.stopPropagation(),
					onChange: (event) => {
						event.stopPropagation();
						onChange(event.target.checked);
					},
					key: "i"
				})
			]);
		}

		function FieldRow({ t, labelKey, hintKey, children }) {
			return react.createElement("div", { className: "dshatt_row dshatt_row_stack" }, [
				react.createElement("span", { className: "dshatt_copy", key: "c" }, [
					react.createElement("span", { className: "dshatt_label", key: "l" }, t(labelKey)),
					hintKey ? react.createElement("span", { className: "dshatt_hint", key: "h" }, t(hintKey)) : null
				]),
				children
			]);
		}

		function PluginCard({ t, title, description, dirty, open, onToggle, saving, failed, onDiscard, onSave, children }) {
			const blocked = !dirty || saving;
			return react.createElement("li", {
				className: "dshatt_card" + (open ? " dshatt_card_open" : "")
			}, [
				react.createElement("button", {
					type: "button",
					className: "dshatt_card_header",
					"aria-expanded": open,
					"aria-label": t(open ? "collapse" : "expand") + ": " + title,
					onClick: onToggle,
					key: "hdr"
				}, [
					react.createElement("span", { className: "dshatt_card_text", key: "txt" }, [
						react.createElement("span", { className: "dshatt_card_name", key: "n" }, title),
						react.createElement("span", { className: "dshatt_card_desc", key: "d" }, description)
					]),
					dirty ? react.createElement("span", { className: "dshatt_unsaved", key: "unsaved" }, t("unsaved")) : null,
					react.createElement("span", {
						className: "dshatt_chevron" + (open ? " dshatt_chevron_open" : ""),
						"aria-hidden": "true",
						key: "ch"
					}, "▾")
				]),
				open ? react.createElement("div", {
					className: "dshatt_body",
					key: "body",
					onClick: (event) => event.stopPropagation()
				}, [
					children,
					react.createElement("div", { className: "dshatt_footer", key: "ftr" }, [
						failed ? react.createElement("p", { className: "dshatt_failed", role: "status", key: "fail" }, t("saveFailed")) : null,
						react.createElement("button", {
							type: "button",
							className: "dshatt_btn dshatt_btn_outline",
							disabled: !dirty || saving,
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								onDiscard();
							},
							key: "discard"
						}, t("discard")),
						react.createElement("button", {
							type: "button",
							className: "dshatt_btn dshatt_btn_primary",
							disabled: blocked,
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								onSave();
							},
							key: "save"
						}, t(saving ? "saving" : "save"))
					])
				]) : null
			]);
		}

		function SettingsPage({ t }) {
			const [saved, setSaved] = react.useState(null);
			const [drafts, setDrafts] = react.useState({ notify: {}, wake: {} });
			const [toast, setToast] = react.useState("");
			const [toastErr, setToastErr] = react.useState(false);
			const [open, setOpen] = react.useState({ notify: true, wake: false });
			const [savingCard, setSavingCard] = react.useState(null);
			const [failedCard, setFailedCard] = react.useState(null);
			const radioName = react.useRef("dshatt-notify-style-" + Math.random().toString(36).slice(2)).current;
			const openModeName = react.useRef("dshatt-open-session-" + Math.random().toString(36).slice(2)).current;
			const [standalone, setStandalone] = react.useState(() => isStandaloneApp());

			react.useEffect(() => {
				let cancelled = false;
				readConfig().then((data) => {
					if (cancelled || !data) return;
					setSaved({ notifyTimeoutSec: 30, openSessionMode: "reuse", ...data });
				});
				return () => { cancelled = true; };
			}, []);

			react.useEffect(() => {
				const sync = () => setStandalone(isStandaloneApp());
				sync();
				const queries = [
					"(display-mode: standalone)",
					"(display-mode: minimal-ui)",
					"(display-mode: window-controls-overlay)"
				].map((q) => {
					try { return window.matchMedia(q); } catch { return null; }
				}).filter(Boolean);
				queries.forEach((mq) => {
					if (mq.addEventListener) mq.addEventListener("change", sync);
					else if (mq.addListener) mq.addListener(sync);
				});
				return () => {
					queries.forEach((mq) => {
						if (mq.removeEventListener) mq.removeEventListener("change", sync);
						else if (mq.removeListener) mq.removeListener(sync);
					});
				};
			}, []);

			const flash = (text, err) => {
				setToast(text);
				setToastErr(err === true);
				window.setTimeout(() => setToast(""), 1600);
			};

			const patchCard = (card, partial) => {
				setFailedCard(null);
				setDrafts((prev) => ({ ...prev, [card]: { ...prev[card], ...partial } }));
			};

			const viewOf = (card) => ({ ...saved, ...drafts[card] });
			const dirtyOf = (card, keys) => saved ? !samePick(saved, viewOf(card), keys) : false;

			const discardCard = (card) => {
				setFailedCard(null);
				setDrafts((prev) => ({ ...prev, [card]: {} }));
			};

			const saveCard = (card, keys) => {
				if (!saved || savingCard) return;
				const payload = pickKeys(viewOf(card), keys);
				if (Object.hasOwn(payload, "webUrl")) payload.webUrl = String(payload.webUrl || "").trim();
				if (Object.hasOwn(payload, "openSessionMode")) payload.openSessionMode = payload.openSessionMode === "new" ? "new" : "reuse";
				if (Object.hasOwn(payload, "hiddenReloadMs")) {
					const n = Number(payload.hiddenReloadMs);
					if (Number.isFinite(n)) payload.hiddenReloadMs = Math.max(0, Math.floor(n));
					else delete payload.hiddenReloadMs;
				}
				if (Object.hasOwn(payload, "cooldownMs")) {
					const n = Number(payload.cooldownMs);
					if (Number.isFinite(n)) payload.cooldownMs = Math.max(0, Math.floor(n));
					else delete payload.cooldownMs;
				}
				if (Object.hasOwn(payload, "notifyTimeoutSec")) {
					const n = Number(payload.notifyTimeoutSec);
					if (Number.isFinite(n)) payload.notifyTimeoutSec = Math.max(0, Math.min(86400, Math.floor(n)));
					else delete payload.notifyTimeoutSec;
				}
				if (Object.keys(payload).length === 0) return;
				setSavingCard(card);
				setFailedCard(null);
				fetch("/dsh-attention/config", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					cache: "no-store"
				}).then((response) => response.json().then((data) => ({ response, data })).catch(() => ({ response, data: null }))).then(({ response, data }) => {
					if (!response.ok || !data?.ok) throw new Error("save-failed");
					setSaved((prev) => ({ ...(prev || {}), ...data, ...payload }));
					setDrafts((prev) => ({ ...prev, [card]: {} }));
					flash(t("saved"), false);
					try { window.dispatchEvent(new CustomEvent("dsh-attention-config", { detail: data })); } catch { /* ignore */ }
				}).catch(() => {
					setFailedCard(card);
					flash(t("saveFailed"), true);
				}).finally(() => setSavingCard(null));
			};

			if (!saved) return react.createElement("div", { className: "dshatt_page" });

			const notifyView = viewOf("notify");
			const wakeView = viewOf("wake");
			const off = notifyView.enabled === false;
			const notifyDirty = dirtyOf("notify", NOTIFY_KEYS);
			const wakeDirty = dirtyOf("wake", WAKE_KEYS);

			return react.createElement("form", {
				className: "dshatt_page",
				onSubmit: (event) => event.preventDefault()
			}, [
				react.createElement("ul", { className: "dshatt_list", key: "list" }, [
					react.createElement(PluginCard, {
						t,
						key: "notify",
						title: t("cardNotify"),
						description: t("cardNotifyDesc"),
						dirty: notifyDirty,
						open: open.notify,
						onToggle: () => setOpen((prev) => ({ ...prev, notify: !prev.notify })),
						saving: savingCard === "notify",
						failed: failedCard === "notify",
						onDiscard: () => discardCard("notify"),
						onSave: () => saveCard("notify", NOTIFY_KEYS)
					}, [
						react.createElement(ToggleRow, { t, key: "enabled", labelKey: "enabled", hintKey: "enabledHint", checked: notifyView.enabled !== false, onChange: (v) => patchCard("notify", { enabled: v }) }),
						react.createElement(StyleChoice, { t, key: "style", name: radioName, value: notifyView.notifyStyle, disabled: off, onChange: (v) => patchCard("notify", { notifyStyle: v }) }),
						react.createElement(FieldRow, { t, key: "timeout", labelKey: "notifyTimeoutSec", hintKey: "notifyTimeoutSecHint" },
							react.createElement("input", {
								className: "dshatt_input",
								type: "number",
								min: "0",
								max: "86400",
								step: "5",
								disabled: off,
								value: String(notifyView.notifyTimeoutSec ?? 30),
								onChange: (event) => {
									const raw = event.target.value;
									patchCard("notify", { notifyTimeoutSec: raw === "" ? "" : Number(raw) });
								}
							})),
						react.createElement(ToggleRow, { t, key: "appr", labelKey: "notifyApproval", checked: notifyView.notifyApproval !== false, disabled: off, onChange: (v) => patchCard("notify", { notifyApproval: v }) }),
						react.createElement(ToggleRow, { t, key: "q", labelKey: "notifyQuestion", checked: notifyView.notifyQuestion !== false, disabled: off, onChange: (v) => patchCard("notify", { notifyQuestion: v }) }),
						react.createElement(ToggleRow, { t, key: "idle", labelKey: "notifyIdle", checked: notifyView.notifyIdle !== false, disabled: off, onChange: (v) => patchCard("notify", { notifyIdle: v }) }),
						react.createElement(ToggleRow, { t, key: "root", labelKey: "rootsOnly", hintKey: "rootsOnlyHint", checked: notifyView.rootsOnly !== false, disabled: off, onChange: (v) => patchCard("notify", { rootsOnly: v }) }),
						react.createElement(ToggleRow, { t, key: "snd", labelKey: "soundEnabled", checked: notifyView.soundEnabled !== false, disabled: off, onChange: (v) => patchCard("notify", { soundEnabled: v }) }),
						react.createElement(FieldRow, { t, key: "url", labelKey: "webUrl", hintKey: "webUrlHint" },
							react.createElement("input", {
								className: "dshatt_input",
								value: String(notifyView.webUrl || ""),
								disabled: off,
								onChange: (event) => patchCard("notify", { webUrl: event.target.value })
							})),
						react.createElement(OpenSessionChoice, {
							t,
							key: "openmode",
							name: openModeName,
							value: notifyView.openSessionMode,
							disabled: off,
							standalone,
							onChange: (v) => patchCard("notify", { openSessionMode: v })
						})
					]),
					react.createElement(PluginCard, {
						t,
						key: "wake",
						title: t("cardWake"),
						description: t("cardWakeDesc"),
						dirty: wakeDirty,
						open: open.wake,
						onToggle: () => setOpen((prev) => ({ ...prev, wake: !prev.wake })),
						saving: savingCard === "wake",
						failed: failedCard === "wake",
						onDiscard: () => discardCard("wake"),
						onSave: () => saveCard("wake", WAKE_KEYS)
					}, [
						react.createElement(FieldRow, { t, key: "hid", labelKey: "hiddenReloadSec", hintKey: "hiddenReloadSecHint" },
							react.createElement("input", {
								className: "dshatt_input",
								type: "number",
								min: "0",
								max: "86400",
								step: "1",
								value: String(Math.max(0, Math.round(Number(wakeView.hiddenReloadMs ?? 8000) / 1000) || 0)),
								onChange: (event) => {
									const raw = event.target.value;
									if (raw === "") {
										patchCard("wake", { hiddenReloadMs: "" });
										return;
									}
									const sec = Number(raw);
									if (!Number.isFinite(sec)) return;
									patchCard("wake", { hiddenReloadMs: Math.max(0, Math.min(86400, Math.floor(sec))) * 1000 });
								}
							})),
						react.createElement(FieldRow, { t, key: "cd", labelKey: "cooldownMs", hintKey: "cooldownMsHint" },
							react.createElement("input", {
								className: "dshatt_input",
								type: "number",
								min: "0",
								step: "100",
								value: String(wakeView.cooldownMs ?? 1500),
								onChange: (event) => patchCard("wake", { cooldownMs: event.target.value })
							}))
					])
				]),
				toast ? react.createElement("div", {
					className: "dshatt_toast" + (toastErr ? " dshatt_toast_err" : ""),
					role: "status",
					key: "toast"
				}, toast) : null
			]);
		}

		function makeSection(ctx) {
			return function AttentionSection() {
				const t = ctx.locale.bind(NS);
				return react.createElement(SettingsPage, { t });
			};
		}

		function syncSettingsNavIcon() {
			if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
			const lists = document.querySelectorAll("[class*='_navList']");
			for (const list of lists) {
				const cells = list.querySelectorAll(":scope > [class*='_navCell']");
				for (const cell of cells) {
					const text = String(cell.textContent ?? "").replace(/\s+/g, " ").trim();
					if (text === zh.nav || text === en.nav) cell.setAttribute("data-dshatt-nav", "attention");
					else if (cell.getAttribute("data-dshatt-nav")) cell.removeAttribute("data-dshatt-nav");
				}
			}
		}

		function startSettingsNavIconSync() {
			if (typeof document === "undefined") return () => {};
			const run = () => {
				try { syncSettingsNavIcon(); } catch { /* settings not mounted */ }
			};
			run();
			if (typeof MutationObserver !== "function") return () => {};
			const root = document.body || document.documentElement;
			if (!root) return () => {};
			const observer = new MutationObserver(run);
			observer.observe(root, { childList: true, subtree: true, characterData: true });
			return () => observer.disconnect();
		}

		function startWake(ctx) {
			let hiddenAt = 0;
			let lastBeat = Date.now();
			let lastInputAt = 0;
			let hiddenReloadMs = DEFAULT_HIDDEN_RELOAD_MS;
			let disposed = false;
			let sessions = ctx.sessions;
			let pendingSession = "";
			try { pendingSession = takeFocusHash(); } catch { pendingSession = ""; }
			try { window.name = FOCUS_WINDOW_NAME; } catch { /* ignore */ }

			const applyFocus = (sessionId) => {
				if (!sessionId) return;
				pendingSession = sessionId;
				openSession(sessions, sessionId);
				try {
					if (sessions?.list?.getSnapshot?.()?.current === sessionId) pendingSession = "";
				} catch { /* keep retrying */ }
			};

			let channel = null;
			try {
				channel = new BroadcastChannel(FOCUS_CHANNEL);
				channel.onmessage = (event) => {
					const id = event?.data?.sessionId;
					if (event?.data?.type === "focus" && id) applyFocus(id);
				};
			} catch { channel = null; }

			const onInput = () => { lastInputAt = Date.now(); };
			document.addEventListener("input", onInput, true);
			document.addEventListener("keydown", onInput, true);

			const applyHiddenReload = (config) => {
				if (!config || disposed) return;
				if (Number.isFinite(Number(config.hiddenReloadMs))) {
					hiddenReloadMs = Math.max(0, Math.floor(Number(config.hiddenReloadMs)));
				}
			};

			const onConfig = (event) => applyHiddenReload(event?.detail);
			window.addEventListener("dsh-attention-config", onConfig);

			const maybeReload = (reason) => {
				if (disposed) return;
				if (typingRecently(lastInputAt, Date.now())) {
					console.info("[dsh-attention] skip reload, user is typing:", reason);
					return;
				}
				reloadOnce(reason);
			};

			const consume = () => {
				if (pendingSession) applyFocus(pendingSession);
				consumeFocus(sessions);
			};

			const onVisibility = () => {
				ensureTitleMark();
				postPresence(currentSessionId(sessions));
				if (document.visibilityState === "hidden") {
					hiddenAt = Date.now();
					return;
				}
				consume();
				const elapsed = hiddenAt > 0 ? Date.now() - hiddenAt : 0;
				hiddenAt = 0;
				void readConfig().then((config) => {
					applyHiddenReload(config);
					if (elapsed >= hiddenReloadMs) maybeReload("visibilitychange");
				});
			};

			const onFreeze = () => { hiddenAt = Date.now(); };
			const onResume = () => {
				postPresence(currentSessionId(sessions));
				consume();
				const elapsed = hiddenAt > 0 ? Date.now() - hiddenAt : 0;
				hiddenAt = 0;
				void readConfig().then((config) => {
					applyHiddenReload(config);
					if (elapsed >= hiddenReloadMs) maybeReload("page-resume");
				});
			};

			const onWindowFocus = () => {
				ensureTitleMark();
				postPresence(currentSessionId(sessions));
				consume();
			};
			const onWindowBlur = () => {
				postPresence(currentSessionId(sessions));
			};

			document.addEventListener("visibilitychange", onVisibility);
			document.addEventListener("freeze", onFreeze);
			document.addEventListener("resume", onResume);
			window.addEventListener("focus", onWindowFocus);
			window.addEventListener("blur", onWindowBlur);
			const onHash = () => {
				const id = takeFocusHash();
				if (id) applyFocus(id);
			};
			window.addEventListener("hashchange", onHash);

			const timer = setInterval(() => {
				const now = Date.now();
				if (now - lastBeat >= CLOCK_JUMP_MS) maybeReload("clock-jump");
				lastBeat = now;
			}, HEARTBEAT_MS);

			const presenceTimer = setInterval(() => {
				ensureTitleMark();
				postPresence(currentSessionId(sessions));
			}, PRESENCE_MS);

			let stopThemeWatch = () => {};
			try {
				if (typeof MutationObserver === "function" && document.body) {
					const themeObs = new MutationObserver(() => {
						postPresence(currentSessionId(sessions));
					});
					themeObs.observe(document.body, {
						attributes: true,
						attributeFilter: ["data-ds-dark-theme"]
					});
					stopThemeWatch = () => themeObs.disconnect();
				}
			} catch { stopThemeWatch = () => {}; }

			const focusTimer = setInterval(() => {
				consume();
			}, FOCUS_POLL_MS);

			ensureTitleMark();
			postPresence(currentSessionId(sessions));
			consume();

			void readConfig().then(applyHiddenReload);

			const dispose = () => {
				disposed = true;
				clearInterval(timer);
				clearInterval(presenceTimer);
				clearInterval(focusTimer);
				try { stopThemeWatch(); } catch { /* ignore */ }
				try { channel?.close(); } catch { /* ignore */ }
				document.removeEventListener("visibilitychange", onVisibility);
				document.removeEventListener("freeze", onFreeze);
				document.removeEventListener("resume", onResume);
				window.removeEventListener("focus", onWindowFocus);
				window.removeEventListener("blur", onWindowBlur);
				window.removeEventListener("dsh-attention-config", onConfig);
				window.removeEventListener("hashchange", onHash);
				document.removeEventListener("input", onInput, true);
				document.removeEventListener("keydown", onInput, true);
			};

			const bindSessions = (value) => {
				if (value) sessions = value;
				if (pendingSession) applyFocus(pendingSession);
			};

			try {
				if (ctx && typeof ctx.inject === "function") {
					ctx.inject(["sessions"], (scope) => {
						bindSessions(scope.sessions || ctx.sessions);
					});
				} else {
					bindSessions(ctx.sessions);
				}
			} catch {
				bindSessions(ctx.sessions);
			}

			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(() => dispose, "dsh-attention: wake");
			}
		}

		function apply(ctx) {
			installStyles();
			startWake(ctx);
			if (!react || !ctx?.slots || !ctx?.locale) return;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-attention: dictionaries");
			ctx.effect(() => startSettingsNavIconSync(), "dsh-attention: settings nav icon");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-attention",
				order: 1100,
				label: () => ctx.locale.bind(NS)("nav"),
				locale: NS
			}, makeSection(ctx)));
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "sessions"];
		return module.exports;
	}
});
