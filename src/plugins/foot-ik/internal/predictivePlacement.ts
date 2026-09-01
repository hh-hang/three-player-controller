import { MathUtils, Quaternion, Vector3 } from "three";
import type { PredictiveFootState } from "../types";

/** 创建单只脚的预测落脚运行时状态。 */
export function createPredictiveFootState(): PredictiveFootState {
    return {
        mode: "none",
        landingTarget: new Vector3(),
        landingNormal: new Vector3(0, 1, 0),
        supportPoint: new Vector3(),
        animatedLanding: new Vector3(),
        animatedLandingRotation: new Quaternion(),
        trajectoryStart: new Vector3(),
        trajectoryCurrentTarget: new Vector3(),
        trajectoryRootForward: new Vector3(0, 0, 1),
        trajectoryStartProgress: 0,
        trajectoryClearance: 0,
        supportObject: null,
        supportLocalTarget: new Vector3(),
        supportLocalPoint: new Vector3(),
        supportLocalNormal: new Vector3(0, 1, 0),
        probeElapsed: Infinity,
        score: Infinity,
        debugTrajectory: Array.from({ length: 13 }, () => new Vector3()),
        debugTrajectoryVisible: false,
        debugCandidates: Array.from({ length: 5 }, () => ({
            point: new Vector3(),
            evaluated: false,
            valid: false,
            selected: false,
        })),
    };
}

/** 清空预测目标并保留已分配的向量对象。 */
export function resetPredictiveFootState(state: PredictiveFootState): void {
    state.mode = "none";
    state.supportObject = null;
    state.probeElapsed = Infinity;
    state.score = Infinity;
    state.trajectoryCurrentTarget.set(0, 0, 0);
    state.trajectoryRootForward.set(0, 0, 0);
    state.trajectoryStartProgress = 0;
    state.trajectoryClearance = 0;
    state.debugTrajectoryVisible = false;
    for (const candidate of state.debugCandidates) {
        candidate.evaluated = false;
        candidate.valid = false;
        candidate.selected = false;
    }
}

/** 按已提交的世界空间起点、终点和净空高度采样唯一的摆动轨迹。 */
export function samplePredictiveTrajectory(
    start: Vector3,
    end: Vector3,
    clearance: number,
    progress: number,
    target: Vector3,
): Vector3 {
    const t = MathUtils.clamp(progress, 0, 1);
    target.lerpVectors(start, end, t);
    target.y += Math.max(0, clearance) * 4 * t * (1 - t);
    return target;
}
