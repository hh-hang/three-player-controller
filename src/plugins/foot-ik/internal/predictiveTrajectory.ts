import { MathUtils, Quaternion, Vector3, type Object3D } from "three";
import { sampleFootPhasePose } from "./footPhase";
import {
    PREDICTION_DEMAND_ENTER,
    getPointPlaneLift,
    type PredictiveFootCandidate,
    type PredictivePlacementContext,
} from "./predictivePlacement";
import type {
    FootPhaseDatabase,
    FootPhaseRuntimeState,
    ReadyFootIKLeg,
} from "../types";

/** 完整线路验证使用的最小地形采样数。 */
export const PREDICTION_MIN_TERRAIN_SAMPLE_COUNT = 4;
/** 完整线路验证使用的最大地形采样数。 */
export const PREDICTION_MAX_TERRAIN_SAMPLE_COUNT = 12;
/** 相邻地形采样点的设计尺度间距。 */
export const PREDICTION_TERRAIN_SAMPLE_SPACING = 10;
/** 预测启用后的剩余摆腿达到该比例时开始对齐支撑面。 */
export const PREDICTION_ROTATION_WARP_START = 0.55;

/** 单个地形采样点对摆动轨迹提出的上抬要求。 */
export type PredictiveClearanceSample = {
    progress: number;
    requiredLift: number;
};

/** 已完成地形净空验证的预测摆动线路。 */
export type PredictiveTrajectoryPlan = {
    /** 整段摆腿需要追加的最大中段抬脚量。 */
    clearance: number;
    /** 路径采样得到的最大上台高度，供进入/退出预测使用。 */
    terrainDemand: number;
    points: Vector3[];
};

/** 轨迹规划在候选评估配置之上额外需要的动画相位数据。 */
export type PredictiveTrajectoryContext = PredictivePlacementContext & {
    model: Object3D;
    footPhaseClips: FootPhaseDatabase;
    clipName: string;
    normalizedTime: number;
    swingClearance: number;
    maxPredictionClearance: number;
};

// 返回两端为零、中段平滑抬高的净空权重。
export function getPredictiveClearanceShape(progress: number): number {
    const t = MathUtils.clamp(progress, 0, 1);
    return 4 * t * (1 - t);
}

/** 把启用后的剩余摆腿进度重新映射到 0 到 1。 */
export function getPredictiveLocalProgress(
    progress: number,
    startProgress: number,
): number {
    const remainingProgress = Math.max(1e-6, 1 - startProgress);
    return MathUtils.clamp((progress - startProgress) / remainingProgress, 0, 1);
}

// 根据整段地形采样求满足所有点的最小额外净空。
export function solvePredictiveClearance(
    samples: readonly PredictiveClearanceSample[],
    margin: number,
    maxClearance: number,
    sampleCount = samples.length,
): number | null {
    let requiredClearance = 0;
    let obstructed = false;
    const count = Math.min(sampleCount, samples.length);

    for (let i = 0; i < count; i++) {
        const sample = samples[i];
        if (sample.requiredLift <= 0) continue;
        const shape = getPredictiveClearanceShape(sample.progress);
        // 净空曲线在两端为 0，若障碍落在两端则无法用中段抬脚躲开。
        if (shape <= 1e-6) return null;
        obstructed = true;
        requiredClearance = Math.max(
            requiredClearance,
            sample.requiredLift / shape,
        );
    }

    if (!obstructed) return 0;
    const clearance = requiredClearance + Math.max(0, margin);
    return clearance <= Math.max(0, maxClearance) ? clearance : null;
}

/** 沿剩余动画摆腿路径采样地形，并生成满足鞋底净空的预测线路。 */
export function planPredictiveFootTrajectory(
    ctx: PredictiveTrajectoryContext,
    leg: ReadyFootIKLeg,
    phase: FootPhaseRuntimeState,
    footWorld: Vector3,
    trajectoryStart: Vector3,
    trajectoryStartProgress: number,
    candidate: PredictiveFootCandidate,
): PredictiveTrajectoryPlan | null {
    const phaseClip = ctx.footPhaseClips.get(ctx.clipName);
    if (!phaseClip || phaseClip.duration <= 0) return null;

    const sideData = phaseClip[leg.side];
    const scratch = ctx.scratch;
    if (!sampleFootPhasePose(
        sideData,
        ctx.normalizedTime,
        scratch.currentLocalPosition,
        scratch.currentLocalRotation,
    )) {
        return null;
    }

    const currentSampleWorld = scratch.currentLocalPosition.applyMatrix4(
        ctx.model.matrixWorld,
    );
    scratch.animationBias.subVectors(footWorld, currentSampleWorld);
    scratch.landingCorrection.subVectors(
        candidate.target,
        leg.predictive.animatedLanding,
    );
    const currentTrajectoryProgress = getPredictiveLocalProgress(
        leg.predictive.trajectoryProgress,
        trajectoryStartProgress,
    );
    const startWarpAlpha = MathUtils.smoothstep(currentTrajectoryProgress, 0, 1);
    // 当前输出已经叠了部分落点修正，起点残差里要扣掉这部分，避免重规划把脚再推一次。
    scratch.continuityOffset
        .subVectors(trajectoryStart, footWorld)
        .addScaledVector(scratch.landingCorrection, -startWarpAlpha);
    ctx.model.getWorldQuaternion(scratch.modelWorldRotation);
    ctx.getConstrainedFootAlign(
        candidate.normal,
        ctx.footAlignWeight,
        scratch.q1,
    );
    scratch.landingRotation
        .copy(scratch.q1)
        .multiply(leg.predictive.animatedLandingRotation);
    leg.foot.getWorldScale(scratch.worldScale);
    const remainingPhase = phase.timeToLand / phaseClip.duration;

    // 沿剩余动画摆腿取点：底是相位姿势，只叠加速度、起点连续和落点差量。
    const samplePath = (
        progress: number,
        position: Vector3,
        rotation: Quaternion,
    ): boolean => {
        const t = MathUtils.clamp(progress, 0, 1);
        const normalizedTime = ctx.normalizedTime + remainingPhase * t;
        if (!sampleFootPhasePose(
            sideData,
            normalizedTime,
            scratch.localPosition,
            scratch.localRotation,
        )) {
            return false;
        }

        const trajectoryProgress = MathUtils.lerp(currentTrajectoryProgress, 1, t);
        const warpAlpha = MathUtils.smoothstep(trajectoryProgress, 0, 1);
        position
            .copy(scratch.localPosition)
            .applyMatrix4(ctx.model.matrixWorld)
            .addScaledVector(
                ctx.predictionVelocity,
                Math.min(phase.timeToLand * t, ctx.predictionHorizon),
            )
            .addScaledVector(scratch.animationBias, 1 - t)
            .addScaledVector(scratch.continuityOffset, 1 - t)
            .addScaledVector(scratch.landingCorrection, warpAlpha);
        // 末段才把脚掌旋到落点法线，避免摆腿中段提前贴坡。
        rotation
            .copy(scratch.modelWorldRotation)
            .multiply(scratch.localRotation)
            .slerp(
                scratch.landingRotation,
                MathUtils.smoothstep(
                    trajectoryProgress,
                    PREDICTION_ROTATION_WARP_START,
                    1,
                ),
            );
        return true;
    };

    if (!samplePath(0, scratch.pathPosition, scratch.pathRotation)) return null;

    let startSupportY = -Infinity;
    const startRayOriginY = Math.max(scratch.pathPosition.y, candidate.target.y)
        + ctx.sampleRayOriginY;
    for (const sample of leg.soleSamples) {
        scratch.soleOffset
            .copy(sample.local)
            .multiply(scratch.worldScale)
            .applyQuaternion(scratch.pathRotation);
        scratch.solePoint.copy(scratch.pathPosition).add(scratch.soleOffset);
        const hit = ctx.castGroundFrom(
            scratch.solePoint.x,
            startRayOriginY,
            scratch.solePoint.z,
        );
        if (hit) startSupportY = Math.max(startSupportY, hit.point.y);
    }
    const currentSupport = ctx.castCapsuleGround();
    if (!Number.isFinite(startSupportY)) {
        startSupportY = currentSupport?.point.y ?? -Infinity;
    }
    if (!Number.isFinite(startSupportY)) startSupportY = candidate.point.y;
    // 低于进入阈值的凸起当作平地，不计入摆腿净空需求。
    const terrainEpsilon = Math.max(
        ctx.snapEpsilon,
        PREDICTION_DEMAND_ENTER * ctx.appliedScale,
    );
    const horizontalDistance = Math.hypot(
        candidate.target.x - scratch.pathPosition.x,
        candidate.target.z - scratch.pathPosition.z,
    );
    const sampleSpacing = Math.max(
        ctx.snapEpsilon,
        PREDICTION_TERRAIN_SAMPLE_SPACING * ctx.appliedScale,
    );
    const terrainSampleCount = MathUtils.clamp(
        Math.ceil(horizontalDistance / sampleSpacing),
        PREDICTION_MIN_TERRAIN_SAMPLE_COUNT,
        PREDICTION_MAX_TERRAIN_SAMPLE_COUNT,
    );
    let maxPlaneLift = 0;
    scratch.clearanceSampleCount = 0;

    // 在起点和终点之间采样鞋底净空；两端不采，避免把落点本身当成中途障碍。
    for (let i = 1; i <= terrainSampleCount; i++) {
        const progress = i / (terrainSampleCount + 1);
        if (!samplePath(progress, scratch.pathPosition, scratch.pathRotation)) {
            return null;
        }

        let requiredLift = 0;
        const rayOriginY = Math.max(scratch.pathPosition.y, candidate.target.y)
            + ctx.sampleRayOriginY;
        for (const sample of leg.soleSamples) {
            scratch.soleOffset
                .copy(sample.local)
                .multiply(scratch.worldScale)
                .applyQuaternion(scratch.pathRotation);
            scratch.solePoint.copy(scratch.pathPosition).add(scratch.soleOffset);
            const hit = ctx.castGroundFrom(
                scratch.solePoint.x,
                rayOriginY,
                scratch.solePoint.z,
            );
            if (!hit) continue;
            const planeLift = getPointPlaneLift(
                currentSupport,
                hit.point,
                startSupportY,
                scratch.v5,
            );
            if (planeLift <= terrainEpsilon) continue;
            maxPlaneLift = Math.max(maxPlaneLift, planeLift);
            requiredLift = Math.max(requiredLift, hit.point.y - scratch.solePoint.y);
        }
        const clearanceSample = scratch.clearanceSamples[scratch.clearanceSampleCount++];
        clearanceSample.progress = MathUtils.lerp(
            currentTrajectoryProgress,
            1,
            progress,
        );
        clearanceSample.requiredLift = Math.max(0, requiredLift);
    }

    const clearance = solvePredictiveClearance(
        scratch.clearanceSamples,
        ctx.swingClearance,
        ctx.maxPredictionClearance,
        scratch.clearanceSampleCount,
    );
    if (clearance === null) return null;

    const points = scratch.plannedPoints;
    for (let i = 0; i < points.length; i++) {
        const progress = i / (points.length - 1);
        if (!samplePath(progress, points[i], scratch.pathRotation)) return null;
        const trajectoryProgress = MathUtils.lerp(
            currentTrajectoryProgress,
            1,
            progress,
        );
        // 重规划时当前帧已经带了一截净空，后面的点要扣掉这份，避免整条线再抬一次。
        const carriedClearance = clearance
            * getPredictiveClearanceShape(currentTrajectoryProgress)
            * (1 - progress);
        points[i].addScaledVector(
            ctx.up,
            clearance * getPredictiveClearanceShape(trajectoryProgress)
                - carriedClearance,
        );
    }

    return {
        clearance,
        terrainDemand: Math.max(0, maxPlaneLift),
        points,
    };
}
