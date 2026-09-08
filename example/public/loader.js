(function () {
    const script = document.currentScript || document.querySelector("script[src*='loader.js']");
    const demo = script?.dataset?.demo || "";
    const fade = 600;

    if (!document.querySelector('link[href*="Cinzel"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://fonts.googleapis.com/css2?family=Cinzel:wght@900&family=Nunito:wght@700&display=swap";
        document.head.appendChild(link);
    }

    const style = document.createElement("style");
    style.id = "__loader-style__";
    style.textContent = `
        html { height: 100%; }

        #__loading-overlay__ {
            position: fixed;
            inset: 0;
            z-index: 99999;
            background: #ececec;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: opacity ${fade}ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        #__loading-overlay__.fade-out {
            opacity: 0;
            pointer-events: none;
        }
        .__ldr-content__ {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 0 1.5rem;
            user-select: none;
        }
        .__ldr-play__ {
            width: 3.25rem;
            height: 3.25rem;
            border-radius: 50%;
            background: #e8a020;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 1.4rem;
            box-shadow: 0 2px 8px rgba(232, 160, 32, 0.35);
            animation: __ldr-pulse__ 1.6s ease-in-out infinite;
        }
        .__ldr-play__ svg {
            width: 14px;
            height: 14px;
            fill: #fff;
            margin-left: 2px;
        }
        .__ldr-title__ {
            font-family: "Cinzel", serif;
            font-size: clamp(1.4rem, 3.5vw, 2.2rem);
            font-weight: 900;
            letter-spacing: 0.06em;
            color: #1a1a2e;
            text-align: center;
            margin-bottom: 0.3rem;
        }
        .__ldr-meta__ {
            display: flex;
            align-items: baseline;
            justify-content: center;
            flex-wrap: wrap;
            gap: 0.45em;
            margin-bottom: 1.5rem;
        }
        .__ldr-kicker__ {
            font-family: "Nunito", sans-serif;
            font-size: 0.78rem;
            font-weight: 700;
            color: #999;
            letter-spacing: 0.14em;
            text-transform: uppercase;
        }
        .__ldr-status__ {
            font-family: "Nunito", sans-serif;
            font-size: 0.88rem;
            font-weight: 700;
            color: #555;
            line-height: 1.4;
        }
        .__ldr-status__:empty {
            display: none;
        }
        .__ldr-progress__ {
            width: min(220px, 70vw);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
        }
        .__ldr-track__ {
            width: 100%;
            height: 4px;
            background: rgba(0, 0, 0, 0.12);
            border-radius: 2px;
            overflow: hidden;
        }
        .__ldr-fill__ {
            height: 100%;
            width: 40%;
            background: #e8a020;
            border-radius: 2px;
            transform: translateX(-120%);
            animation: __ldr-slide__ 1.35s ease-in-out infinite;
        }
        .__ldr-fill__.is-determinate {
            width: 0%;
            transform: none;
            animation: none;
            transition: width 0.25s ease;
        }
        .__ldr-pct__ {
            font-family: "Nunito", system-ui, sans-serif;
            font-size: 12px;
            font-weight: 700;
            color: #555;
            letter-spacing: 0.05em;
            min-height: 1em;
        }
        @keyframes __ldr-pulse__ {
            0%, 100% {
                transform: scale(1);
                box-shadow: 0 2px 8px rgba(232, 160, 32, 0.35);
            }
            50% {
                transform: scale(1.08);
                background: #f5b535;
                box-shadow: 0 8px 24px rgba(232, 160, 32, 0.45);
            }
        }
        @keyframes __ldr-slide__ {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(350%); }
        }
        @media (prefers-reduced-motion: reduce) {
            .__ldr-play__,
            .__ldr-fill__ {
                animation: none;
            }
            .__ldr-fill__:not(.is-determinate) {
                width: 100%;
                transform: none;
            }
            #__loading-overlay__ {
                transition: none;
            }
        }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "__loading-overlay__";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-busy", "true");
    overlay.setAttribute("aria-live", "polite");
    overlay.innerHTML = `
        <div class="__ldr-content__">
            <div class="__ldr-play__" aria-hidden="true">
                <svg viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9" /></svg>
            </div>
            <div class="__ldr-title__">three-player-controller</div>
            <div class="__ldr-meta__">
                <div class="__ldr-kicker__">Loading</div>
                <div class="__ldr-status__" id="__ldr-status__"></div>
            </div>
            <div class="__ldr-progress__" id="__ldr-progress__">
                <div class="__ldr-track__"><div class="__ldr-fill__" id="__ldr-fill__"></div></div>
                <div class="__ldr-pct__" id="__ldr-pct__"></div>
            </div>
        </div>`;
    document.documentElement.appendChild(overlay);

    const fill = overlay.querySelector("#__ldr-fill__");
    const pct = overlay.querySelector("#__ldr-pct__");
    const status = overlay.querySelector("#__ldr-status__");
    if (demo) status.textContent = demo;

    window.setLoaderStatus = function (text) {
        if (status) status.textContent = text || "";
    };

    window.setLoaderProgress = function (loaded, total) {
        if (!fill) return;
        if (total > 0) {
            fill.classList.add("is-determinate");
            const p = Math.min(100, Math.round((loaded / total) * 100));
            fill.style.width = p + "%";
            if (pct) pct.textContent = p + "%";
        } else {
            fill.classList.remove("is-determinate");
            fill.style.width = "";
            if (pct) pct.textContent = (loaded / 1048576).toFixed(1) + " MB";
        }
    };

    window.hideLoader = function () {
        const el = document.getElementById("__loading-overlay__");
        if (!el || el.dataset.hiding) return;
        el.dataset.hiding = "1";
        el.classList.add("fade-out");
        el.setAttribute("aria-busy", "false");

        let cleaned = false;
        const done = () => {
            if (cleaned) return;
            cleaned = true;
            el.remove();
            document.getElementById("__loader-style__")?.remove();
        };
        el.addEventListener("transitionend", done, { once: true });
        setTimeout(done, fade + 80);
    };
})();
