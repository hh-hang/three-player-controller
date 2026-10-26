import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MobileButtonOptions, MobileControlsOptions } from "../types";

type MobileButtonName = "jump" | "fly" | "view" | "vehicle";
type MobileIconName = MobileButtonName | "brake";

const iconLabels: Record<MobileIconName, string> = {
    jump: "JUMP",
    brake: "BRAKE",
    fly: "FLY",
    view: "VIEW",
    vehicle: "CAR",
};

type SetInputFn = (input: Partial<{
    moveX: number;
    moveY: number;
    lookDeltaX: number;
    lookDeltaY: number;
    jump: boolean;
    shift: boolean;
    toggleView: boolean;
    toggleFly: boolean;
    toggleVehicle: boolean;
}>) => void;

class VirtualJoystick {
    private baseEl: HTMLDivElement;
    private stickEl: HTMLDivElement;
    private pointerId: number | null = null;
    private center = { x: 0, y: 0 };
    private radius: number;
    private onMove: (data: { vector: { x: number; y: number }; distance: number }) => void;
    private onEnd: () => void;

    constructor(
        zone: HTMLDivElement,
        size: number,
        onMove: (data: { vector: { x: number; y: number }; distance: number }) => void,
        onEnd: () => void,
    ) {
        this.radius = size / 2;
        this.onMove = onMove;
        this.onEnd = onEnd;

        // 外环
        this.baseEl = document.createElement("div");
        Object.assign(this.baseEl.style, {
            position: "absolute",
            left: "50%",
            bottom: "50%",
            transform: "translate(-50%, 50%)",
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: "50%",
            border: "2px solid rgba(0,0,0,0.5)",
            backgroundColor: "rgba(0,0,0,0.2)",
            boxSizing: "border-box",
            pointerEvents: "none",
        });
        zone.appendChild(this.baseEl);

        // 内点
        const stickSize = size * 0.2;
        this.stickEl = document.createElement("div");
        Object.assign(this.stickEl.style, {
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: `${stickSize}px`,
            height: `${stickSize}px`,
            borderRadius: "50%",
            backgroundColor: "rgba(255,255,255,0.7)",
            pointerEvents: "none",
        });
        this.baseEl.appendChild(this.stickEl);

        zone.addEventListener("pointerdown", this.onPointerDown, { passive: false });
        zone.addEventListener("pointermove", this.onPointerMove, { passive: false });
        zone.addEventListener("pointerup", this.onPointerUp, { passive: false });
        zone.addEventListener("pointercancel", this.onPointerUp, { passive: false });
    }

    private onPointerDown = (e: PointerEvent) => {
        if (this.pointerId !== null) return;
        this.pointerId = e.pointerId;
        const rect = this.baseEl.parentElement!.getBoundingClientRect();
        this.center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        this.baseEl.parentElement!.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.updateStick(e.clientX, e.clientY);
    };

    private onPointerMove = (e: PointerEvent) => {
        if (e.pointerId !== this.pointerId) return;
        e.preventDefault();
        this.updateStick(e.clientX, e.clientY);
    };

    private onPointerUp = (e: PointerEvent) => {
        if (e.pointerId !== this.pointerId) return;
        this.pointerId = null;
        this.stickEl.style.transform = "translate(-50%, -50%)";
        this.onEnd();
    };

    private updateStick(clientX: number, clientY: number) {
        const dx = clientX - this.center.x;
        const dy = clientY - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clampedDist = Math.min(dist, this.radius);
        const angle = Math.atan2(dy, dx);
        const ox = Math.cos(angle) * clampedDist;
        const oy = Math.sin(angle) * clampedDist;

        this.stickEl.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;

        // 归一化向量，y 轴取反
        const scale = dist > 0 ? clampedDist / this.radius / dist : 0;
        this.onMove({ vector: { x: dx * scale, y: -dy * scale }, distance: clampedDist });
    }

    destroy() {
        const zone = this.baseEl.parentElement;
        if (zone) {
            zone.removeEventListener("pointerdown", this.onPointerDown);
            zone.removeEventListener("pointermove", this.onPointerMove);
            zone.removeEventListener("pointerup", this.onPointerUp);
            zone.removeEventListener("pointercancel", this.onPointerUp);
        }
        this.baseEl.remove();
    }
}

export class MobileControls {
    setInput: SetInputFn;
    controls: OrbitControls;
    private options: MobileControlsOptions = {};
    private manageCamera = true;
    private bindLookEvents = true;

    // 摇杆状态
    joystick: VirtualJoystick | null = null;
    prevJoyState = { moveX: 0, moveY: 0, shift: false };

    // DOM 元素
    joystickZoneEl: HTMLDivElement | null = null;
    lookAreaEl: HTMLDivElement | null = null;
    jumpBtnEl: HTMLButtonElement | null = null;
    flyBtnEl: HTMLButtonElement | null = null;
    viewBtnEl: HTMLButtonElement | null = null;
    vehicleBtnEl: HTMLButtonElement | null = null;

    // 触摸状态
    lookPointerId: number | null = null;
    isLookDown = false;
    lastTouchX = 0;
    lastTouchY = 0;

    constructor(setInput: SetInputFn, controls: OrbitControls) {
        this.setInput = setInput;
        this.controls = controls;
    }

    // 初始化移动端控制
    init(opts: MobileControlsOptions = {}, manageCamera = true) {
        this.options = opts;
        const showJoystick = opts.joystick ?? true;
        const showJump = opts.jump !== false;
        const showFly = opts.fly !== false;
        const showView = opts.view !== false;
        const showVehicle = opts.vehicle !== false;

        if (manageCamera) {
            this.controls.maxPolarAngle = Math.PI * (300 / 360);
            this.controls.touches = { ONE: null as any, TWO: null as any };
        }

        const JOY_SIZE = 120;
        const container = document.body;

        // 创建摇杆区域
        if (showJoystick) {
            this.joystickZoneEl = document.createElement("div");
            this.joystickZoneEl.id = "joy-zone";
            Object.assign(this.joystickZoneEl.style, {
                position: "absolute",
                left: "16px",
                bottom: "16px",
                width: `${JOY_SIZE + 40}px`,
                height: `${JOY_SIZE + 40}px`,
                touchAction: "none",
                zIndex: "999",
                pointerEvents: "auto",
                WebkitUserSelect: "none",
                userSelect: "none",
            });
            container.appendChild(this.joystickZoneEl);
            this.blockTouch(this.joystickZoneEl);

            // 初始化自定义摇杆
            this.joystick = new VirtualJoystick(
                this.joystickZoneEl,
                JOY_SIZE,
                (data) => {
                    const rawX = data.vector?.x ?? 0;
                    const rawY = data.vector?.y ?? 0;
                    const distance = data.distance ?? 0;
                    const deadzone = 0.2;
                    const magnitude = Math.hypot(rawX, rawY);
                    const moveX = magnitude > deadzone ? rawX / magnitude : 0;
                    const moveY = magnitude > deadzone ? rawY / magnitude : 0;
                    const isSprinting = distance >= JOY_SIZE / 2;
                    const prev = this.prevJoyState;
                    if (Math.abs(moveX - prev.moveX) < 0.0001 && Math.abs(moveY - prev.moveY) < 0.0001 && isSprinting === prev.shift) return;
                    this.prevJoyState = { moveX, moveY, shift: isSprinting };
                    this.setInput({ moveX, moveY, shift: isSprinting });
                },
                () => {
                    const prev = this.prevJoyState;
                    if (prev.moveX !== 0 || prev.moveY !== 0 || prev.shift) {
                        this.prevJoyState = { moveX: 0, moveY: 0, shift: false };
                        this.setInput({ moveX: 0, moveY: 0, shift: false });
                    }
                },
            );
        }

        // 创建视角区域
        this.lookAreaEl = document.createElement("div");
        Object.assign(this.lookAreaEl.style, {
            position: "absolute",
            right: "0",
            bottom: "0",
            width: "50%",
            height: "100%",
            zIndex: "998",
            touchAction: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
        });
        container.appendChild(this.lookAreaEl);
        this.blockTouch(this.lookAreaEl);

        // 绑定视角触摸事件
        this.lookAreaEl.addEventListener("pointerdown", this.onPointerDown, { passive: false });
        this.lookAreaEl.addEventListener("pointermove", this.onPointerMove, { passive: false });
        this.lookAreaEl.addEventListener("pointerup", this.onPointerUp, { passive: false });
        this.lookAreaEl.addEventListener("pointercancel", this.onPointerUp, { passive: false });

        // 创建操作按钮
        if (showJump) {
            this.jumpBtnEl = this.createBtn(container, "jump", 14, 14);
            this.jumpBtnEl.addEventListener("touchstart", (e) => { e.preventDefault(); this.setInput({ jump: true }); }, { passive: false });
            this.jumpBtnEl.addEventListener("touchend", (e) => { e.preventDefault(); this.setInput({ jump: false }); }, { passive: false });
            this.jumpBtnEl.addEventListener("touchcancel", (e) => { e.preventDefault(); this.setInput({ jump: false }); }, { passive: false });
        }
        if (showFly) {
            this.flyBtnEl = this.createBtn(container, "fly", 14, 14 + 80);
            this.flyBtnEl.addEventListener("touchstart", (e) => { e.preventDefault(); this.setInput({ toggleFly: true }); }, { passive: false });
        }
        if (showView) {
            this.viewBtnEl = this.createBtn(container, "view", 14, 14 + 200);
            this.viewBtnEl.addEventListener("touchstart", (e) => { e.preventDefault(); this.setInput({ toggleView: true }); }, { passive: false });
        }
        if (showVehicle) {
            this.vehicleBtnEl = this.createBtn(container, "vehicle", 14 + 100, 14 + 120);
            this.vehicleBtnEl.style.display = "none";
            this.vehicleBtnEl.addEventListener("touchstart", (e) => { e.preventDefault(); this.setInput({ toggleVehicle: true }); }, { passive: false });
        }
    }

    /** 应用管理镜头时，让出右侧触摸区域并隐藏内置视角切换按钮。 */
    setManageCamera(enabled: boolean) {
        this.manageCamera = enabled;
        this.syncLookControls();
        if (this.viewBtnEl) this.viewBtnEl.style.display = enabled ? "flex" : "none";
    }

    /** 切换内置触摸视角，不影响摇杆、按钮和外部输入。 */
    setBindLookEvents(enabled: boolean) {
        this.bindLookEvents = enabled;
        this.syncLookControls();
    }

    /** 同步视角区域显隐，关闭时释放当前触摸操作。 */
    private syncLookControls() {
        const enabled = this.manageCamera && this.bindLookEvents;
        if (!enabled) {
            if (this.lookPointerId !== null && this.lookAreaEl?.hasPointerCapture(this.lookPointerId)) {
                this.lookAreaEl.releasePointerCapture(this.lookPointerId);
            }
            this.isLookDown = false;
            this.lookPointerId = null;
        }
        if (this.lookAreaEl) this.lookAreaEl.style.display = enabled ? "" : "none";
    }

    // 销毁移动端控制
    destroy() {
        try {
            this.joystick?.destroy();
            this.joystick = null;

            if (this.lookAreaEl) {
                this.lookAreaEl.removeEventListener("pointerdown", this.onPointerDown);
                this.lookAreaEl.removeEventListener("pointermove", this.onPointerMove);
                this.lookAreaEl.removeEventListener("pointerup", this.onPointerUp);
                this.lookAreaEl.removeEventListener("pointercancel", this.onPointerUp);
            }

            // 移除所有 DOM 元素
            [this.joystickZoneEl, this.lookAreaEl, this.jumpBtnEl, this.flyBtnEl, this.viewBtnEl, this.vehicleBtnEl]
                .forEach(el => el?.parentElement?.removeChild(el));

            this.joystickZoneEl = this.lookAreaEl = this.jumpBtnEl =
                this.flyBtnEl = this.viewBtnEl = this.vehicleBtnEl = null;
        } catch (e) {
            console.warn("销毁移动端控制时出错：", e);
        }
    }

    // 同步车辆按钮显隐
    syncVehicleBtn(show: boolean) {
        if (this.vehicleBtnEl) this.vehicleBtnEl.style.display = show ? "flex" : "none";
    }

    // 同步控制模式按钮
    syncControllerModeBtn(mode: 0 | 1) {
        if (!this.jumpBtnEl) return;
        if (mode === 0) {
            if (this.flyBtnEl) this.flyBtnEl.style.display = "flex";
            this.setButtonIcon(this.jumpBtnEl, "jump");
        } else {
            if (this.flyBtnEl) this.flyBtnEl.style.display = "none";
            this.setButtonIcon(this.jumpBtnEl, "brake");
        }
    }

    // 触摸按下
    private onPointerDown = (e: PointerEvent) => {
        if (e.pointerType !== "touch" || !this.manageCamera || !this.bindLookEvents) return;
        this.isLookDown = true;
        this.lookPointerId = e.pointerId;
        this.lastTouchX = e.clientX;
        this.lastTouchY = e.clientY;
        this.lookAreaEl?.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    };

    // 触摸移动
    private onPointerMove = (e: PointerEvent) => {
        if (!this.isLookDown || e.pointerId !== this.lookPointerId) return;
        const dx = e.clientX - this.lastTouchX;
        const dy = e.clientY - this.lastTouchY;
        this.lastTouchX = e.clientX;
        this.lastTouchY = e.clientY;
        this.setInput({ lookDeltaX: dx, lookDeltaY: dy });
        e.preventDefault();
    };

    // 触摸抬起
    private onPointerUp = (e: PointerEvent) => {
        if (e.pointerId !== this.lookPointerId) return;
        this.isLookDown = false;
        this.lookPointerId = null;
        this.lookAreaEl?.releasePointerCapture?.(e.pointerId);
    };

    // 阻止默认触摸
    private blockTouch(el: HTMLElement) {
        ["touchstart", "touchmove", "touchend", "touchcancel"].forEach(name => {
            el.addEventListener(name, e => e.preventDefault(), { passive: false });
        });
    }

    private getButtonOptions(name: MobileButtonName): MobileButtonOptions | undefined {
        const options = this.options[name];
        return typeof options === "object" ? options : undefined;
    }

    private getIconUrl(iconName: MobileIconName): string | undefined {
        if (iconName === "brake") {
            const jumpOptions = this.options.jump;
            return typeof jumpOptions === "object" ? jumpOptions.brakeIcon : undefined;
        }
        return this.getButtonOptions(iconName)?.icon;
    }

    // 创建圆形按钮
    private createBtn(container: HTMLElement, name: MobileButtonName, defaultRight: number, defaultBottom: number): HTMLButtonElement {
        const btn = document.createElement("button");
        const layout = this.getButtonOptions(name);
        const size = layout?.size ?? 56;
        const idleShadow = "0 6px 12px rgba(0,0,0,0.45), 0 2px 4px rgba(0,0,0,0.35), inset 0 2px 2px rgba(255,255,255,0.24), inset 0 -2px 3px rgba(0,0,0,0.5)";
        const pressedShadow = "0 2px 5px rgba(0,0,0,0.35), inset 0 2px 4px rgba(0,0,0,0.65), inset 0 -1px 1px rgba(255,255,255,0.12)";
        Object.assign(btn.style, {
            position: "absolute",
            right: `${layout?.right ?? defaultRight}px`,
            bottom: `${layout?.bottom ?? defaultBottom}px`,
            width: `${size}px`,
            height: `${size}px`,
            zIndex: "1000",
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.45)",
            padding: "0",
            opacity: "0.95",
            touchAction: "none",
            fontSize: "14px",
            userSelect: "none",
            overflow: "hidden",
            boxSizing: "border-box",
            appearance: "none",
            WebkitAppearance: "none",
            WebkitTapHighlightColor: "transparent",
            background: "linear-gradient(145deg, rgba(82,82,82,0.95) 0%, rgba(34,34,34,0.96) 55%, rgba(10,10,10,0.98) 100%)",
            boxShadow: idleShadow,
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transform: "translateY(0) scale(1)",
            transition: "transform 80ms ease, box-shadow 80ms ease, background 80ms ease",
            willChange: "transform",
        });
        if (layout?.left !== undefined) {
            btn.style.left = `${layout.left}px`;
            if (layout.right === undefined) btn.style.right = "auto";
        }
        if (layout?.top !== undefined) {
            btn.style.top = `${layout.top}px`;
            if (layout.bottom === undefined) btn.style.bottom = "auto";
        }
        this.setButtonIcon(btn, name);
        container.appendChild(btn);

        const setPressed = (pressed: boolean) => {
            btn.style.transform = pressed ? "translateY(2px) scale(0.98)" : "translateY(0) scale(1)";
            btn.style.boxShadow = pressed ? pressedShadow : idleShadow;
            btn.style.background = pressed
                ? "linear-gradient(145deg, rgba(22,22,22,0.98), rgba(52,52,52,0.96))"
                : "linear-gradient(145deg, rgba(82,82,82,0.95) 0%, rgba(34,34,34,0.96) 55%, rgba(10,10,10,0.98) 100%)";
        };
        btn.addEventListener("pointerdown", () => setPressed(true));
        ["pointerup", "pointercancel", "pointerleave"].forEach(eventName => {
            btn.addEventListener(eventName, () => setPressed(false));
        });
        ["touchstart", "touchend", "touchcancel"].forEach(name => {
            btn.addEventListener(name, e => e.preventDefault(), { passive: false });
        });
        return btn;
    }

    // 设置按钮内容
    private setButtonIcon(btn: HTMLButtonElement, iconName: MobileIconName) {
        const customIconUrl = this.getIconUrl(iconName);
        let icon: HTMLImageElement | HTMLSpanElement;

        if (customIconUrl !== undefined) {
            const image = document.createElement("img");
            image.src = customIconUrl;
            image.alt = "";
            image.draggable = false;
            icon = image;
        } else {
            const label = document.createElement("span");
            label.textContent = iconLabels[iconName];
            icon = label;
        }

        Object.assign(icon.style, {
            width: "80%",
            height: "80%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            objectFit: "contain",
            pointerEvents: "none",
            flex: "none",
            fontSize: "11px",
            fontWeight: "700",
            fontFamily: "system-ui, sans-serif",
            lineHeight: "1",
            letterSpacing: "0.04em",
            textShadow: "0 1px 2px rgba(0,0,0,0.9)",
        });
        btn.replaceChildren(icon);
    }
}
