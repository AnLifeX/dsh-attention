/**
 * dsh-attention — 浏览器半边。
 *
 * 网页休眠 / 标签冻结后 mux WebSocket 经常半开：页面看起来还在跑，审批卡片
 * 其实已经丢了。这里不改官方 ConnectionController，只在「醒过来」时做一次
 * 等同 F5 的重载——宿主会重放仍待处理的 approval/question 帧。
 *
 * 判定：
 * - 隐藏超过 hiddenReloadMs（默认 8s，可被 /dsh-attention/config 覆盖）
 * - Page Lifecycle 的 freeze/resume
 * - setInterval 墙钟跳变（整机睡眠后定时器补火）
 *
 * 正在输入时不刷新，避免草稿丢掉。
 */
window.__ModuleLoader__.load({
	id: "dsh-attention",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const STORAGE_KEY = "dsh-attention:reload-lock";
		const DEFAULT_HIDDEN_RELOAD_MS = 8000;
		const CLOCK_JUMP_MS = 45000;
		const HEARTBEAT_MS = 4000;
		const INPUT_GRACE_MS = 2000;

		function typingRecently(lastInputAt, now) {
			return now - lastInputAt < INPUT_GRACE_MS;
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
				const data = await response.json();
				const hiddenReloadMs = Number(data?.hiddenReloadMs);
				return {
					hiddenReloadMs: Number.isFinite(hiddenReloadMs) && hiddenReloadMs >= 0
						? hiddenReloadMs
						: DEFAULT_HIDDEN_RELOAD_MS,
				};
			} catch {
				return { hiddenReloadMs: DEFAULT_HIDDEN_RELOAD_MS };
			}
		}

		function apply(ctx) {
			let hiddenAt = 0;
			let lastBeat = Date.now();
			let lastInputAt = 0;
			let hiddenReloadMs = DEFAULT_HIDDEN_RELOAD_MS;
			let disposed = false;

			const onInput = () => { lastInputAt = Date.now(); };
			document.addEventListener("input", onInput, true);
			document.addEventListener("keydown", onInput, true);

			const maybeReload = (reason) => {
				if (disposed) return;
				if (typingRecently(lastInputAt, Date.now())) {
					console.info("[dsh-attention] skip reload, user is typing:", reason);
					return;
				}
				reloadOnce(reason);
			};

			const onVisibility = () => {
				if (document.visibilityState === "hidden") {
					hiddenAt = Date.now();
					return;
				}
				if (hiddenAt > 0 && Date.now() - hiddenAt >= hiddenReloadMs) {
					maybeReload("visibilitychange");
				}
				hiddenAt = 0;
			};

			const onFreeze = () => { hiddenAt = Date.now(); };
			const onResume = () => {
				if (hiddenAt > 0 && Date.now() - hiddenAt >= hiddenReloadMs) {
					maybeReload("page-resume");
				}
				hiddenAt = 0;
			};

			document.addEventListener("visibilitychange", onVisibility);
			document.addEventListener("freeze", onFreeze);
			document.addEventListener("resume", onResume);

			const timer = setInterval(() => {
				const now = Date.now();
				if (now - lastBeat >= CLOCK_JUMP_MS) maybeReload("clock-jump");
				lastBeat = now;
			}, HEARTBEAT_MS);

			void readConfig().then((config) => {
				if (!disposed) hiddenReloadMs = config.hiddenReloadMs;
			});

			const dispose = () => {
				disposed = true;
				clearInterval(timer);
				document.removeEventListener("visibilitychange", onVisibility);
				document.removeEventListener("freeze", onFreeze);
				document.removeEventListener("resume", onResume);
				document.removeEventListener("input", onInput, true);
				document.removeEventListener("keydown", onInput, true);
			};
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(() => dispose, "dsh-attention: wake");
			}
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
