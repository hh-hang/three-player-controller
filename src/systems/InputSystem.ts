import type { playerController } from "../PlayerController";
import { Vector3 } from "three";
import type { KeyAction, KeyMap, PlayerInput } from "../types";

/** 插件生成的世界空间移动指令。 */
type AutomaticMove = {
    owner: object;
    direction: Vector3;
    run: boolean;
    speedScale: number;
    maxDistance: number;
};

// 默认键位表（动作 -> KeyboardEvent.code 列表）
const defaultKeyMap: Record<KeyAction, string[]> = {
    forward: ["KeyW", "ArrowUp"],
    backward: ["KeyS", "ArrowDown"],
    left: ["KeyA", "ArrowLeft"],
    right: ["KeyD", "ArrowRight"],
    sprint: ["ShiftLeft", "ShiftRight"],
    jump: ["Space"],
    toggleView: ["KeyV"],
    toggleFly: ["KeyF"],
    toggleVehicle: ["KeyE"],
};

export class InputSystem {
    private ctrl: playerController; // 主控制器引用

    fwd = false; // 前进键
    bkd = false; // 后退键
    lft = false; // 左移键
    rgt = false; // 右移键
    space = false; // 跳跃键
    shift = false; // 加速键

    private keyFwd = false;
    private keyBkd = false;
    private keyLft = false;
    private keyRgt = false;
    private analogMoveX = 0;
    private analogMoveY = 0;
    private eventsBound = false;
    private keyboardEventsBound = false;
    private lookEventsBound = false;
    private keyShift = false;
    private keySpace = false;
    private externalSpace = false;
    private manualShift = false;
    private automaticMove: AutomaticMove | null = null;

    private boundKeydown = async (e: KeyboardEvent) => this.onKeydown(e); // 键盘按下绑定
    private boundKeyup = (e: KeyboardEvent) => this.onKeyup(e); // 键盘抬起绑定
    private boundMouseMove = (e: MouseEvent) => this.onMouseMove(e); // 鼠标移动绑定
    private boundMouseClick = (e: MouseEvent) => {
        if (e.target === this.ctrl.controls.domElement) this.ctrl.cam.setPointerLock(); // 鼠标点击绑定
    };
    private boundBlur = () => this.resetKeys(); // 页面失焦时重置按键状态

    private codeToAction = new Map<string, KeyAction>(); // 键码 -> 动作 反查表

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
        this.buildKeyMap();
    }

    // 构建键码：动作 反查表：未传的动作用默认键，传 string/数组则覆盖，传 null 则禁用
    buildKeyMap(userMap?: KeyMap) {
        this.codeToAction.clear();  // 清空旧表
        for (const action of Object.keys(defaultKeyMap) as KeyAction[]) {
            let codes: string[];
            if (userMap && action in userMap) {
                const v = userMap[action];
                if (v == null) continue; // null：禁用该动作
                codes = Array.isArray(v) ? v : [v]; // 覆盖默认键
            } else {
                codes = defaultKeyMap[action];  // 未传：用默认键
            }
            for (const code of codes) this.codeToAction.set(code, action);
        }
    }

    // 程序化输入接口
    setInput(input: PlayerInput) {
        const c = this.ctrl;
        c.notifyInput(input);
        if (!c.playerCapsule) return;

        // 连续移动轴，供摇杆或手柄输入使用
        const prevFwd = this.fwd;
        const prevBkd = this.bkd;
        const prevLft = this.lft;
        const prevRgt = this.rgt;
        let moveChanged = false;
        if (typeof input.moveX === "number") {
            this.analogMoveX = Math.max(-1, Math.min(1, input.moveX));
            moveChanged = true;
        }
        if (typeof input.moveY === "number") {
            this.analogMoveY = Math.max(-1, Math.min(1, input.moveY));
            moveChanged = true;
        }
        if (moveChanged) {
            this.syncDirectionFlags();
            if (prevFwd !== this.fwd || prevBkd !== this.bkd || prevLft !== this.lft || prevRgt !== this.rgt) {
                c.animation.setAnimationByPressed();
            }
        }

        // 视角朝向
        if (typeof input.lookDeltaX === "number" && typeof input.lookDeltaY === "number") {
            c.cam.setToward(input.lookDeltaX, input.lookDeltaY, 0.002);
        }

        // 持续状态
        if (typeof input.jump === "boolean") this.applyAction("jump", input.jump);
        if (typeof input.shift === "boolean") this.applyAction("sprint", input.shift);

        // 触发式切换
        if (input.toggleView) this.applyAction("toggleView", true);
        if (input.toggleFly) this.applyAction("toggleFly", true);
        if (input.toggleVehicle) this.applyAction("toggleVehicle", true);
    }

    /** @internal 写入自动移动，不覆盖键盘、摇杆或外部输入。 */
    setAutomaticMove(owner: object, direction: Vector3, run: boolean, speedScale: number, maxDistance: number) {
        const command = this.automaticMove ?? {
            owner, direction: new Vector3(), run, speedScale, maxDistance,
        };
        command.owner = owner;
        command.direction.copy(direction);
        command.run = run;
        command.speedScale = speedScale;
        command.maxDistance = maxDistance;
        this.automaticMove = command;
        this.syncDirectionFlags();
    }

    /** @internal 只清除当前插件的指令；连续替换时可保留速度并延后动画同步。 */
    clearAutomaticMove(owner: object, stop = false, syncAnimation = true) {
        if (this.automaticMove?.owner !== owner) return;
        this.automaticMove = null;
        if (stop) {
            this.ctrl.playerVelocity.x = 0;
            this.ctrl.playerVelocity.z = 0;
        }
        this.syncDirectionFlags();
        if (syncAnimation) this.ctrl.animation.setAnimationByPressed();
    }

    /** @internal 当前自动移动指令。 */
    getAutomaticMove() { return this.automaticMove; }

    /** 是否存在人工移动输入，包含按住的键盘按键与外部移动轴。 */
    hasManualMovement() {
        return this.keyFwd || this.keyBkd || this.keyLft || this.keyRgt
            || Math.abs(this.analogMoveX) > 1e-4 || Math.abs(this.analogMoveY) > 1e-4;
    }

    // 绑定输入事件
    bindEvents() {
        if (this.eventsBound) return;
        this.eventsBound = true;
        this.ctrl.cam.syncInputEvents();
        this.bindKeyboardEvents();
        this.bindLookEvents();
        window.addEventListener("blur", this.boundBlur);
    }

    // 解绑输入事件
    unbindEvents() {
        this.unbindKeyboardEvents();
        this.unbindLookEvents();
        if (!this.eventsBound) return;
        this.eventsBound = false;
        window.removeEventListener("blur", this.boundBlur);
        this.resetKeys();
    }

    /** 绑定键盘事件，不影响鼠标和外部输入。 */
    bindKeyboardEvents() {
        if (this.keyboardEventsBound || !this.ctrl.bindKeyboardEvents || !this.ctrl.isupdate) return;
        this.keyboardEventsBound = true;
        window.addEventListener("keydown", this.boundKeydown);
        window.addEventListener("keyup", this.boundKeyup);
    }

    /** 解绑键盘事件并清除键盘状态，保留摇杆和外部输入。 */
    unbindKeyboardEvents() {
        if (!this.keyboardEventsBound) return;
        this.keyboardEventsBound = false;
        window.removeEventListener("keydown", this.boundKeydown);
        window.removeEventListener("keyup", this.boundKeyup);
        this.resetKeys(false);
    }

    /** 绑定内置鼠标视角事件，不影响键盘或外部视角输入。 */
    bindLookEvents() {
        if (this.lookEventsBound || !this.ctrl.bindLookEvents || !this.ctrl.manageCamera || !this.ctrl.isupdate) return;
        this.lookEventsBound = true;
        window.addEventListener("mousemove", this.boundMouseMove);
        window.addEventListener("click", this.boundMouseClick);
        this.ctrl.cam.setPointerLock();
    }

    /** 解绑内置鼠标视角事件并释放本控制器的指针锁定。 */
    unbindLookEvents() {
        this.ctrl.cam.releasePointerLock();
        if (!this.lookEventsBound) return;
        this.lookEventsBound = false;
        window.removeEventListener("mousemove", this.boundMouseMove);
        window.removeEventListener("click", this.boundMouseClick);
    }

    /** 重置键盘状态；失焦或解绑全部事件时同时清除外部输入。 */
    private resetKeys(clearExternal = true) {
        const c = this.ctrl;
        this.keyFwd = false;
        this.keyBkd = false;
        this.keyLft = false;
        this.keyRgt = false;
        this.keyShift = false;
        this.keySpace = false;
        if (clearExternal) {
            this.analogMoveX = 0;
            this.analogMoveY = 0;
            this.externalSpace = false;
            this.manualShift = false;
        }
        this.space = this.externalSpace;
        this.syncDirectionFlags();
        if (c.manageCamera) c.controls.mouseButtons = this.manualShift
            ? { LEFT: 2, MIDDLE: 1, RIGHT: 0 }
            : { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
        c.animation.setAnimationByPressed();
    }

    // 统一动作派发
    private applyAction(action: KeyAction, pressed: boolean, source: "keyboard" | "external" = "external") {
        const c = this.ctrl;
        switch (action) {
            // 前进
            case "forward": this.keyFwd = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 后退
            case "backward": this.keyBkd = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 左移
            case "left": this.keyLft = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 右移
            case "right": this.keyRgt = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 冲刺
            case "sprint":
                if (source === "keyboard") this.keyShift = pressed;
                else this.manualShift = pressed;
                this.syncDirectionFlags();
                c.animation.setAnimationByPressed();
                // 切换轨道拖拽键位
                if (c.manageCamera) {
                    c.controls.mouseButtons = (this.keyShift || this.manualShift)
                        ? { LEFT: 2, MIDDLE: 1, RIGHT: 0 }
                        : { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
                }
                break;
            // 跳跃
            case "jump":
                if (source === "keyboard") this.keySpace = pressed;
                else this.externalSpace = pressed;
                this.space = this.keySpace || this.externalSpace;
                if (pressed) {
                    if (c.controllerMode === 1) return; // 载具模式不跳跃
                    if (c.isFlying) { c.animation.setAnimationByPressed(); return; } // 飞行中仅切动画
                    if (!c.playerIsOnGround) return; // 不在地面不能跳
                    if (c.animation.isJumping()) return;  // 跳跃中不重复触发
                    c.animation.startJump();
                    c.playerVelocity.y = c.jumpHeight;
                    c.setOnGround(false); // 跳跃后设置为不在地面
                } else {
                    if (c.isFlying) c.animation.setAnimationByPressed();
                }
                break;
            // 切换第一 / 第三人称视角
            case "toggleView":
                if (pressed) c.cam.changeView();
                break;
            // 切换飞行模式
            case "toggleFly":
                if (pressed && c.controllerMode === 0) {
                    c.isFlying = !c.isFlying;
                    if (c.isFlying) c.playerVelocity.set(0, 0, 0);
                    c.animation.setAnimationByPressed();
                    if (!c.isFlying && !c.playerIsOnGround) c.animation.startJump(true); 
                }
                break;
            // 上 / 下车
            case "toggleVehicle":
                if (pressed) {
                    if (c.isFlying) return;
                    if (c.controllerMode === 0) c.vehicle.enter(); else c.vehicle.exit();
                }
                break;
        }
    }

    // 获取最终移动轴：模拟输入优先，否则使用键盘八方向
    getMoveAxes() {
        if (this.automaticMove) return { x: 0, y: Number(this.fwd), isAnalog: true };
        const hasAnalogInput = this.analogMoveX !== 0 || this.analogMoveY !== 0;
        if (hasAnalogInput) return { x: this.analogMoveX, y: this.analogMoveY, isAnalog: true };
        return {
            x: Number(this.keyRgt) - Number(this.keyLft),
            y: Number(this.keyFwd) - Number(this.keyBkd),
            isAnalog: false,
        };
    }

    // 合并键盘与模拟输入，供动画和车辆等现有布尔逻辑使用
    private syncDirectionFlags() {
        this.shift = this.automaticMove?.run ?? (this.keyShift || this.manualShift);
        if (this.automaticMove) {
            this.fwd = this.automaticMove.direction.lengthSq() > 0;
            this.bkd = this.lft = this.rgt = false;
            return;
        }
        const threshold = 0.2;
        this.fwd = this.keyFwd || this.analogMoveY > threshold;
        this.bkd = this.keyBkd || this.analogMoveY < -threshold;
        this.lft = this.keyLft || this.analogMoveX < -threshold;
        this.rgt = this.keyRgt || this.analogMoveX > threshold;
    }

    // 键盘按下处理
    private onKeydown(e: KeyboardEvent) {
        const action = this.codeToAction.get(e.code);
        if (!action) return;
        const input: PlayerInput = {};
        if (action === "forward") input.moveY = 1;
        if (action === "backward") input.moveY = -1;
        if (action === "left") input.moveX = -1;
        if (action === "right") input.moveX = 1;
        if (action === "jump") input.jump = true;
        if (action === "toggleFly") input.toggleFly = true;
        if (action === "toggleVehicle") input.toggleVehicle = true;
        this.ctrl.notifyInput(input);
        if (!this.ctrl.playerCapsule) return;
        this.applyAction(action, true, "keyboard");
    }

    // 键盘抬起处理
    private onKeyup(e: KeyboardEvent) {
        const action = this.codeToAction.get(e.code);
        if (action) this.applyAction(action, false, "keyboard");
    }

    // 鼠标移动处理
    private onMouseMove(e: MouseEvent) {
        if (!this.ctrl.bindLookEvents || !this.ctrl.manageCamera || !this.ctrl.isupdate) return;
        const lockTarget = this.ctrl.controls.domElement;
        if (lockTarget && document.pointerLockElement === lockTarget) {
            this.ctrl.cam.setToward(e.movementX, e.movementY, 0.0001);
        }
    }
}
