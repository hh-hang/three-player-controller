import type { Vector3 } from "three";

/** 世界坐标中的地面目标点。 */
export type RoutePoint = Vector3 | readonly [number, number, number];
export type RouteState = "idle" | "moving" | "paused";
export type RouteEndReason = "completed" | "cancelled" | "blocked";

export interface RouteEndEvent {
    reason: RouteEndReason;
    routeId: number;
    waypointIndex: number;
    waypointCount: number;
}

export interface RouteOptions {
    /** 使用角色的跑步速度；默认 false。 */
    run?: boolean;
    /** 循环整条路线；默认 false。 */
    loop?: boolean;
    /** 水平到达距离，世界单位；默认胶囊半径的 1/4。 */
    arrivalRadius?: number;
    /** 脚底与目标点的高度容差，世界单位；默认胶囊半径的 1/2。 */
    heightTolerance?: number;
    /** 连续无法接近目标的超时秒数；默认 2，设为 0 关闭。 */
    blockedTimeout?: number;
    /** 路线结束且移动指令已清理后调用；暂停不会触发。 */
    onEnd?: (event: RouteEndEvent) => void;
}
