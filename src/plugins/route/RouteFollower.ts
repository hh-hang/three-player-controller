import { Vector3 } from "three";
import type { playerController } from "../../PlayerController";
import type { PlayerInput } from "../../types";
import type { PlayerPlugin } from "../types";
import type { RouteEndReason, RouteOptions, RoutePoint, RouteState } from "./types";

/** 沿给定世界坐标移动；碰撞、重力与动画仍由玩家控制器处理。 */
export class RouteFollower implements PlayerPlugin {
    readonly name = "route-follower";
    private player: playerController | null = null;
    private disposed = false;
    private defaults: RouteOptions;
    private options!: Required<Omit<RouteOptions, "onEnd">> & Pick<RouteOptions, "onEnd">;
    private points: Vector3[] = [];
    private _state: RouteState = "idle";
    private index = -1;
    private requestId = 0;
    private routeId = 0;
    private blockedTime = 0;
    private bestDistance = Infinity;
    private foot = new Vector3();
    private direction = new Vector3();

    /** 保存路线默认配置，单次移动时可覆盖。 */
    constructor(options: RouteOptions = {}) { this.defaults = { ...options }; }

    /** 获取当前路线状态。 */
    get state(): RouteState { return this._state; }
    /** 获取当前目标下标，空闲时为 -1。 */
    get currentIndex() { return this.index; }

    /** 挂载到玩家控制器，禁止重复挂载到不同玩家。 */
    onAttach(player: playerController) {
        if (this.disposed) throw new Error("路线插件已销毁，无法再次挂载。");
        if (this.player && this.player !== player) throw new Error("路线插件已挂载到其他玩家，不能重复挂载。");
        this.player = player;
    }

    /** 移动到单个地面点。 */
    moveTo(point: RoutePoint, options: RouteOptions = {}) {
        return this.follow([point], { ...options, loop: false });
    }

    /** 校验并替换当前路线，连续移动时保留速度和动画播放进度。 */
    follow(points: readonly RoutePoint[], options: RouteOptions = {}) {
        const player = this.player;
        if (!player?.playerCapsule || this.disposed) throw new Error("请先将路线插件挂载到已初始化的玩家控制器。");
        if (player.isFlying || player.controllerMode !== 0) throw new Error("飞行或驾驶状态下不能启动路线移动。");
        if (!points.length) throw new Error("路线至少需要一个目标点。");
        const cloned = points.map(point => {
            const value = Array.isArray(point) ? new Vector3(...point) : (point as Vector3).clone();
            if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error("路线目标点坐标必须为有限数值。");
            return value;
        });
        const radius = player.playerCapsule.capsuleInfo.radius;
        const resolved = {
            run: false, loop: false, arrivalRadius: radius * 0.25,
            heightTolerance: radius * 0.5, blockedTimeout: 2,
            ...this.defaults, ...options,
        };
        for (const key of ["arrivalRadius", "heightTolerance", "blockedTimeout"] as const) {
            if (!Number.isFinite(resolved[key]) || resolved[key] < 0 || (key === "arrivalRadius" && resolved[key] === 0)) {
                throw new Error(`路线参数 ${key} 无效。`);
            }
        }
        const command = player.input.getAutomaticMove();
        const previousMove = this._state === "moving" && command?.owner === this ? command : null;
        const request = ++this.requestId;
        try {
            this.finish("cancelled", player, previousMove !== null);
            // 结束回调可能启动另一条路线或卸载插件，尊重回调中的新决定。
            if (request !== this.requestId || this.player !== player || this.disposed) return this;
            this.points = cloned;
            this.options = resolved;
            this.routeId = request;
            this.index = 0;
            this._state = "moving";
            this.resetProgress();
            return this;
        } finally {
            if (previousMove && player.playerCapsule && !player.input.getAutomaticMove()) {
                if (this.player === player && this._state === "moving") {
                    // 连续交接移动指令，方向和速度将在下一物理步按新目标重算。
                    player.input.setAutomaticMove(this, previousMove.direction, this.options.run, previousMove.speedScale, previousMove.maxDistance);
                } else {
                    // 回调中止交接或抛出异常时，按真正停止处理，避免残留移动。
                    player.playerVelocity.x = 0;
                    player.playerVelocity.z = 0;
                    player.animation.setAnimationByPressed();
                }
            }
        }
    }

    /** 切换当前路线的跑步状态，保留目标、进度和暂停状态。 */
    setRun(enabled: boolean) {
        if (this._state !== "idle") this.options.run = enabled;
        return this;
    }

    /** 保留路线和目标，停止路线驱动；物理继续更新。 */
    pause() {
        if (this._state === "moving") {
            this._state = "paused";
            this.player?.input.clearAutomaticMove(this);
        }
        return this;
    }

    /** 从当前位置继续前往保留的目标点。 */
    resume() {
        if (this._state === "paused") {
            this._state = "moving";
            this.resetProgress();
        }
        return this;
    }

    /** 取消当前路线并触发结束通知。 */
    cancel() { this.finish("cancelled"); return this; }

    /** 收到人工移动、跳跃或模式切换输入时取消路线。 */
    onInput(input: Readonly<PlayerInput>) {
        if (Math.abs(input.moveX ?? 0) > 1e-4 || Math.abs(input.moveY ?? 0) > 1e-4 ||
            input.jump || input.toggleFly || input.toggleVehicle) this.cancel();
    }

    /** 物理更新前检查路线状态，并生成朝向当前目标的移动指令。 */
    onBeforeUpdate(delta: number) {
        const player = this.player;
        if (!player || this._state === "idle") return;
        if (player.isFlying || player.controllerMode !== 0 || player.input.hasManualMovement()) {
            this.cancel();
            return;
        }
        if (this._state !== "moving") return;
        const routeId = this.routeId;
        this.consumeReached();
        if (this._state !== "moving" || routeId !== this.routeId) return;
        this.updateFoot();
        this.direction.subVectors(this.points[this.index], this.foot).setY(0);
        const distance = this.direction.length();
        this.direction.normalize();
        const speed = this.options.run ? player.playerRunSpeed : player.playerSpeed;
        // 接近目标时减速，同时限制单步距离，避免高速越过目标后反复折返。
        const deceleration = player.playerDeceleration * player.decelBase;
        const stoppingSpeed = deceleration > 0
            ? Math.sqrt(2 * deceleration * Math.max(0, distance - this.options.arrivalRadius * 0.5))
            : speed;
        const speedScale = speed > 0 ? Math.min(1, stoppingSpeed / speed, distance / (speed * delta)) : 0;
        player.input.setAutomaticMove(this, this.direction, this.options.run, speedScale, distance);
    }

    /** 物理更新后检查到达情况，并在持续受阻超时时结束路线。 */
    onAfterUpdate(delta: number) {
        if (this._state !== "moving") return;
        const routeId = this.routeId;
        this.consumeReached();
        if (this._state !== "moving" || routeId !== this.routeId) return;
        this.updateFoot();
        const distance = this.foot.distanceTo(this.points[this.index]);
        const progress = Math.max(this.options.arrivalRadius * 0.05, 1e-6);
        if (distance < this.bestDistance - progress) {
            this.bestDistance = distance;
            this.blockedTime = 0;
        } else {
            this.blockedTime += delta;
            if (this.options.blockedTimeout > 0 && this.blockedTime >= this.options.blockedTimeout) this.finish("blocked");
        }
    }

    /** 切换玩家模型时取消路线，避免沿用旧模型的移动状态。 */
    onPlayerModelChange() { this.cancel(); }

    /** 卸载时解除玩家引用，并清理当前路线和移动指令。 */
    onDetach() {
        const player = this.player;
        this.player = null;
        this.finish("cancelled", player);
    }

    /** 销毁插件并清理路线，重复调用时忽略。 */
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.onDetach();
    }

    /** 根据胶囊世界坐标和接地高度计算脚底位置。 */
    private updateFoot() {
        this.player!.playerCapsule.getWorldPosition(this.foot);
        this.foot.y -= this.player!.getCapsuleGroundHeight();
    }

    /** 跳过已到达的目标点，并处理路线循环或完成。 */
    private consumeReached() {
        this.updateFoot();
        // 重合点和循环路线每步最多遍历一圈，避免无限循环。
        for (let count = 0; count < this.points.length; count++) {
            const target = this.points[this.index];
            if (!this.player!.playerIsOnGround || Math.hypot(target.x - this.foot.x, target.z - this.foot.z) > this.options.arrivalRadius ||
                Math.abs(target.y - this.foot.y) > this.options.heightTolerance) return;
            if (this.index + 1 < this.points.length) this.index++;
            else if (this.options.loop) this.index = 0;
            else { this.finish("completed"); return; }
            this.resetProgress();
        }
    }

    /** 重置当前目标的距离记录和受阻计时。 */
    private resetProgress() { this.blockedTime = 0; this.bestDistance = Infinity; }

    /** 清理路线后通知结束；连续替换时延后停止和动画同步。 */
    private finish(reason: RouteEndReason, player = this.player, preserveMovement = false) {
        if (this._state === "idle") return;
        const onEnd = this.options.onEnd;
        const event = { reason, routeId: this.routeId, waypointIndex: this.index, waypointCount: this.points.length };
        this._state = "idle";
        this.points = [];
        this.index = -1;
        this.resetProgress();
        player?.input.clearAutomaticMove(this, !preserveMovement, !preserveMovement);
        onEnd?.(event);
    }
}
