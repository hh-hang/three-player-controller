// 按键文字 -> KeyboardEvent.code（可被 data-code 覆盖）
const LABEL_CODES = {
    W: ["KeyW", "ArrowUp"],
    A: ["KeyA", "ArrowLeft"],
    S: ["KeyS", "ArrowDown"],
    D: ["KeyD", "ArrowRight"],
    Shift: ["ShiftLeft", "ShiftRight"],
    Space: ["Space"],
    RMB: ["Mouse2"],
    LMB: ["Mouse0"],
    1: ["Digit1"],
    4: ["Digit4"],
};

// 在 GUI / 输入框里操作时不点亮 HUD
function shouldIgnore(el) {
    if (!(el instanceof Element)) return false;
    return Boolean(el.closest("input, textarea, select, [contenteditable='true'], .lil-gui"));
}

// 解析 kbd 对应的键码：优先 data-code，否则按显示文字查表
function codesFor(kbd) {
    const explicit = kbd.getAttribute("data-code");
    if (explicit) return explicit.trim().split(/\s+/).filter(Boolean);
    const label = kbd.textContent.replace(/\s+/g, " ").trim();
    if (LABEL_CODES[label]) return LABEL_CODES[label];
    if (/^[A-Za-z]$/.test(label)) return [`Key${label.toUpperCase()}`];
    return [];
}

const LOOK_SCALE = 0.28; // 鼠标位移换算到指示点的系数
const LOOK_MAX = 5; // 指示点最大偏移（px）
const LOOK_DECAY = 0.84; // 每帧回弹衰减
const LOOK_REST = 0.04; // 小于此值视为静止

// 确保每个移动提示块都有鼠标图标（HTML 未写时补一个）
function ensureLookMice(hud) {
    const mice = [];
    for (const move of hud.querySelectorAll(".hint-move")) {
        let mouse = move.querySelector(".hint-mouse");
        if (!mouse) {
            const cluster = document.createElement("div");
            cluster.className = "hint-cluster";
            cluster.innerHTML = '<div class="hint-mouse" aria-hidden="true"><div class="hint-mouse-body"><span class="hint-mouse-wheel"></span><span class="hint-mouse-nub"></span></div></div><span class="hint-text">Look</span>';
            move.append(cluster);
            mouse = cluster.querySelector(".hint-mouse");
        }
        mice.push(mouse);
    }
    return mice;
}

// 绑定 HUD 按键高亮与鼠标 Look 指示
export function bindControlHints(hud = document.querySelector(".hud")) {
    if (!hud) return;

    const keys = [...hud.querySelectorAll("kbd")];
    const mice = ensureLookMice(hud);
    if (!keys.length && !mice.length) return;

    const pressed = new Set(); // 当前按下的 KeyboardEvent.code / MouseN
    let lookX = 0;
    let lookY = 0;
    let lookRaf = 0;

    // 同步 kbd.is-down
    const syncKeys = () => {
        for (const kbd of keys) {
            kbd.classList.toggle("is-down", codesFor(kbd).some((code) => pressed.has(code)));
        }
    };

    // 把 Look 偏移写到鼠标图标
    const applyLook = () => {
        const x = `${lookX}px`;
        const y = `${lookY}px`;
        const active = Math.hypot(lookX, lookY) > LOOK_REST;
        for (const mouse of mice) {
            mouse.style.setProperty("--look-x", x);
            mouse.style.setProperty("--look-y", y);
            mouse.classList.toggle("is-active", active);
        }
    };

    // 指示点回弹；静止后停掉 rAF
    const tickLook = () => {
        lookX *= LOOK_DECAY;
        lookY *= LOOK_DECAY;
        if (Math.abs(lookX) < LOOK_REST && Math.abs(lookY) < LOOK_REST) {
            lookX = 0;
            lookY = 0;
            lookRaf = 0;
            applyLook();
            return;
        }
        applyLook();
        lookRaf = requestAnimationFrame(tickLook);
    };

    // 键盘按下 / 抬起
    const onKey = (event, down) => {
        if (down && shouldIgnore(event.target)) return;
        if (down) pressed.add(event.code);
        else pressed.delete(event.code);
        syncKeys();
    };

    // 鼠标按键（LMB / RMB 等）
    const onMouse = (event, down) => {
        if (down && shouldIgnore(event.target)) return;
        const code = `Mouse${event.button}`;
        if (down) pressed.add(code);
        else pressed.delete(code);
        syncKeys();
    };

    // 指针锁定时始终跟踪；否则仅在按住拖拽转视角时跟踪
    const onMouseMove = (event) => {
        if (!document.pointerLockElement && event.buttons === 0) return;
        if (!document.pointerLockElement && shouldIgnore(event.target)) return;
        lookX = Math.max(-LOOK_MAX, Math.min(LOOK_MAX, lookX + event.movementX * LOOK_SCALE));
        lookY = Math.max(-LOOK_MAX, Math.min(LOOK_MAX, lookY + event.movementY * LOOK_SCALE));
        applyLook();
        if (!lookRaf) lookRaf = requestAnimationFrame(tickLook);
    };

    // 失焦时清掉按下态和 Look 偏移
    const clear = () => {
        pressed.clear();
        syncKeys();
        lookX = 0;
        lookY = 0;
        if (lookRaf) {
            cancelAnimationFrame(lookRaf);
            lookRaf = 0;
        }
        applyLook();
    };

    window.addEventListener("keydown", (event) => onKey(event, true));
    window.addEventListener("keyup", (event) => onKey(event, false));
    window.addEventListener("mousedown", (event) => onMouse(event, true));
    window.addEventListener("mouseup", (event) => onMouse(event, false));
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) clear();
    });
}

// 按上下车切换走路 / 载具两套提示，并转调原有回调
export function bindVehicleHintMode(player, hud = document.querySelector(".hud")) {
    if (!player || !hud) return;

    const setMode = (mode) => {
        hud.dataset.hintMode = mode;
    };

    setMode(player.getControllerMode?.() === 1 ? "vehicle" : "on-foot");

    const prevEnter = player.onVehicleEnter;
    const prevExit = player.onVehicleExit;
    player.onVehicleEnter = (vehicle) => {
        setMode("vehicle");
        prevEnter?.(vehicle);
    };
    player.onVehicleExit = (vehicle) => {
        setMode("on-foot");
        prevExit?.(vehicle);
    };
}

bindControlHints();
