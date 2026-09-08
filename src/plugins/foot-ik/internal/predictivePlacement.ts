import { Matrix3, Quaternion, Vector3, type Object3D } from "three";
import type {
    FootIKGroundHit,
    FootIKSoleSample,
    FootPhaseRuntimeState,
    PredictiveFootState,
    ReadyFootIKLeg,
} from "../types";

/** 最小踏步高度；低于该值不启用预测 IK。 */
export const PREDICTION_DEMAND_ENTER = 8;
/** 已启用预测时，需求回落到该高度后退出。 */
export const PREDICTION_DEMAND_EXIT = 4;

/** 预测候选保留脚骨目标、实际支撑面和评分，用于生成本次摆动线路。 */
export type PredictiveFootCandidate = {
    /** 鞋底贴合支撑面后的脚骨目标。 */
    target: Vector3;
    /** 四条鞋底射线共面合并后的地面接触。 */
    point: Vector3;
    normal: Vector3;
    object: Object3D | null;
    score: number;
    /** 0 为动画中心落点；非 0 表示相对动画做了水平偏移。 */
    debugIndex: number;
};

/** 预测落脚搜索、评估和轨迹规划共用的临时对象。 */
export type PredictiveScratch = {
    v1: Vector3;
    v2: Vector3;
    v4: Vector3;
    v5: Vector3;
    v6: Vector3;
    v7: Vector3;
    v8: Vector3;
    v9: Vector3;
    q1: Quaternion;
    q2: Quaternion;
    q3: Quaternion;
    normalMatrix: Matrix3;
    trajectoryStart: Vector3;
    demandEnter: number;
    demandExit: number;
    candidates: PredictiveFootCandidate[];
    /** 仅确认可站立的中心支撑，尚未通过抬降和腿长约束。 */
    centerSupport: PredictiveFootCandidate;
    plannedPoints: Vector3[];
    currentLocalPosition: Vector3;
    currentLocalRotation: Quaternion;
    /** 当前动画脚相对相位采样的偏差，规划起点与运行时脚对齐。 */
    animationBias: Vector3;
    /** 预测脚骨目标相对动画预计落点的世界空间差。 */
    landingCorrection: Vector3;
    /** 重规划时把线路起点钉在上一帧输出，避免轨迹跳变。 */
    continuityOffset: Vector3;
    modelWorldRotation: Quaternion;
    landingRotation: Quaternion;
    worldScale: Vector3;
    localPosition: Vector3;
    localRotation: Quaternion;
    pathPosition: Vector3;
    pathRotation: Quaternion;
    solePoint: Vector3;
    soleOffset: Vector3;
    supportHits: FootIKGroundHit[];
    supportHitList: FootIKGroundHit[];
    clearanceSamples: Array<{ progress: number; requiredLift: number }>;
    clearanceSampleCount: number;
};

/** 候选搜索和落点评估所需的只读配置与回调。 */
export type PredictivePlacementContext = {
    up: Vector3;
    appliedScale: number;
    snapEpsilon: number;
    sampleRayOriginY: number;
    maxPredictionCorrection: number;
    predictionMinNormalY: number;
    maxFootRaise: number;
    maxFootDrop: number;
    pelvisKneeBend: number;
    footAlignWeight: number;
    predictionHorizon: number;
    predictionVelocity: Vector3;
    scratch: PredictiveScratch;
    /** 关闭时跳过支撑面四边形和调试轨迹写入。 */
    debug: boolean;
    castGroundFrom: (x: number, y: number, z: number) => FootIKGroundHit | null;
    castCapsuleGround: () => FootIKGroundHit | null;
    getConstrainedFootAlign: (
        normal: Vector3,
        alignWeight: number,
        target: Quaternion,
    ) => Quaternion;
    mergeCoplanarHits: (
        hits: Array<FootIKGroundHit | null>,
        highest: FootIKGroundHit,
        supportPoint: Vector3,
        supportNormal: Vector3,
    ) => number;
    getSafeLegReach: (upperLen: number, lowerLen: number, kneeBend: number) => number;
};

/** 创建预测落脚搜索和规划使用的临时对象。 */
export function createPredictiveScratch(): PredictiveScratch {
    return {
        v1: new Vector3(),
        v2: new Vector3(),
        v4: new Vector3(),
        v5: new Vector3(),
        v6: new Vector3(),
        v7: new Vector3(),
        v8: new Vector3(),
        v9: new Vector3(),
        q1: new Quaternion(),
        q2: new Quaternion(),
        q3: new Quaternion(),
        normalMatrix: new Matrix3(),
        trajectoryStart: new Vector3(),
        demandEnter: 0,
        demandExit: 0,
        candidates: Array.from({ length: 1 }, () => ({
            target: new Vector3(),
            point: new Vector3(),
            normal: new Vector3(),
            object: null,
            score: 0,
            debugIndex: -1,
        })),
        centerSupport: {
            target: new Vector3(),
            point: new Vector3(),
            normal: new Vector3(),
            object: null,
            score: 0,
            debugIndex: 0,
        },
        plannedPoints: Array.from({ length: 13 }, () => new Vector3()),
        currentLocalPosition: new Vector3(),
        currentLocalRotation: new Quaternion(),
        animationBias: new Vector3(),
        landingCorrection: new Vector3(),
        continuityOffset: new Vector3(),
        modelWorldRotation: new Quaternion(),
        landingRotation: new Quaternion(),
        worldScale: new Vector3(),
        localPosition: new Vector3(),
        localRotation: new Quaternion(),
        pathPosition: new Vector3(),
        pathRotation: new Quaternion(),
        solePoint: new Vector3(),
        soleOffset: new Vector3(),
        supportHits: Array.from({ length: 4 }, () => ({
            point: new Vector3(),
            normal: new Vector3(0, 1, 0),
        })),
        supportHitList: [],
        clearanceSamples: Array.from({ length: 12 }, () => ({
            progress: 0,
            requiredLift: 0,
        })),
        clearanceSampleCount: 0,
    };
}

/** 创建单只脚的预测落脚运行时状态。 */
export function createPredictiveFootState(): PredictiveFootState {
    return {
        mode: "none",
        landingTarget: new Vector3(),
        landingNormal: new Vector3(0, 1, 0),
        supportPoint: new Vector3(),
        animatedLanding: new Vector3(),
        animatedLandingRotation: new Quaternion(),
        trajectoryStartOffset: new Vector3(),
        trajectoryCurrentTarget: new Vector3(),
        trajectoryStartProgress: 0,
        trajectoryProgress: 0,
        trajectoryClearance: 0,
        predictionWeight: 0,
        usesOffsetLanding: false,
        releaseOffset: new Vector3(),
        releaseStartProgress: 0,
        releaseActive: false,
        supportObject: null,
        supportLocalTarget: new Vector3(),
        supportLocalPoint: new Vector3(),
        supportLocalNormal: new Vector3(0, 1, 0),
        probeElapsed: Infinity,
        score: Infinity,
        debugPlaneLift: 0,
        debugSwingLift: 0,
        debugTrajectory: Array.from({ length: 13 }, () => new Vector3()),
        debugTrajectoryVisible: false,
        debugSupportVisible: false,
        debugSupportCorners: Array.from({ length: 4 }, () => new Vector3()),
        debugCandidates: Array.from({ length: 1 }, () => ({
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
    state.debugPlaneLift = 0;
    state.debugSwingLift = 0;
    state.trajectoryStartOffset.set(0, 0, 0);
    state.trajectoryCurrentTarget.set(0, 0, 0);
    state.trajectoryStartProgress = 0;
    state.trajectoryProgress = 0;
    state.trajectoryClearance = 0;
    state.predictionWeight = 0;
    state.usesOffsetLanding = false;
    state.releaseOffset.set(0, 0, 0);
    state.releaseStartProgress = 0;
    state.releaseActive = false;
    state.debugTrajectoryVisible = false;
    state.debugSupportVisible = false;
    for (const candidate of state.debugCandidates) {
        candidate.evaluated = false;
        candidate.valid = false;
        candidate.selected = false;
    }
}

/** 计算预测 IK 进入和退出的地形需求阈值。 */
export function getPredictiveDemandThresholds(
    appliedScale: number,
    snapEpsilon: number,
    scratch: PredictiveScratch,
): { enter: number; exit: number } {
    // 退出阈值不高于进入阈值，避免需求在边界附近反复开关预测。
    scratch.demandEnter = Math.max(
        snapEpsilon,
        PREDICTION_DEMAND_ENTER * appliedScale,
    );
    scratch.demandExit = Math.min(
        scratch.demandEnter,
        Math.max(snapEpsilon, PREDICTION_DEMAND_EXIT * appliedScale),
    );
    return { enter: scratch.demandEnter, exit: scratch.demandExit };
}

/** 按终点权重把调试轨迹从起点平移到新的落点。 */
export function shiftPredictiveDebugTrajectory(
    points: Vector3[],
    delta: Vector3,
): void {
    if (delta.lengthSq() <= 1e-12 || points.length < 2) return;
    for (let i = 0; i < points.length; i++) {
        points[i].addScaledVector(delta, i / (points.length - 1));
    }
}

// 把通过完整线路验证的候选同步为最终调试选中项。
export function selectPredictiveDebugCandidate(
    state: PredictiveFootState,
    selectedIndex: number,
): void {
    for (let i = 0; i < state.debugCandidates.length; i++) {
        state.debugCandidates[i].selected = i === selectedIndex;
    }
}

/** 点高出支撑平面的距离；落在平面上或下方时为 0。 */
export function getPointPlaneLift(
    support: { point: Vector3; normal: Vector3 } | null,
    point: Vector3,
    fallbackY: number,
    scratch: Vector3,
): number {
    if (!support) return Math.max(0, point.y - fallbackY);
    return Math.max(0, support.normal.dot(scratch.copy(point).sub(support.point)));
}

/** 落点高出当前支撑平面的距离；落在平面上或下方时为 0。 */
export function getPredictivePlaneDistance(
    ctx: PredictivePlacementContext,
    candidate: PredictiveFootCandidate,
): number {
    return getPointPlaneLift(
        ctx.castCapsuleGround(),
        candidate.point,
        candidate.point.y,
        ctx.scratch.v5,
    );
}

/** 预测需求取落点上台高度和摆腿途中高出支撑面的凸起。 */
export function getPredictiveTerrainDemand(
    planeLift: number,
    swingLift: number,
): number {
    return Math.max(planeLift, Math.max(0, swingLift));
}

/** 保存首次有效预测候选，并把目标转换为命中平台的局部锚点。 */
export function acceptPredictiveFootCandidate(
    state: PredictiveFootState,
    candidate: PredictiveFootCandidate,
    scratch: PredictiveScratch,
): void {
    state.landingTarget.copy(candidate.target);
    state.supportPoint.copy(candidate.point);
    state.landingNormal.copy(candidate.normal);
    state.score = candidate.score;
    // 中心落点 debugIndex 为 0，落地后交还反应式 IK；偏移落点才进入 planted。
    state.usesOffsetLanding = candidate.debugIndex !== 0;
    state.supportObject = candidate.object;

    if (state.supportObject) {
        state.supportObject.updateMatrixWorld(true);
        state.supportLocalTarget.copy(state.landingTarget);
        state.supportObject.worldToLocal(state.supportLocalTarget);
        state.supportLocalPoint.copy(state.supportPoint);
        state.supportObject.worldToLocal(state.supportLocalPoint);
        scratch.normalMatrix.getNormalMatrix(state.supportObject.matrixWorld).invert();
        state.supportLocalNormal
            .copy(state.landingNormal)
            .applyMatrix3(scratch.normalMatrix)
            .normalize();
    }
}

/** 根据已保存的平台局部锚点刷新预测目标、支撑点和世界法线。 */
export function refreshPredictiveSupportAnchor(
    leg: ReadyFootIKLeg,
    scratch: PredictiveScratch,
    debug = false,
): void {
    const state = leg.predictive;
    // 中心落点每帧跟随动画预计落点，不能用平台锚点覆盖水平位置。
    if (
        !state.supportObject
        || (state.mode === "active" && !state.usesOffsetLanding)
    ) {
        return;
    }

    const previousTarget = debug ? scratch.v1.copy(state.landingTarget) : null;
    state.supportObject.updateMatrixWorld(true);
    state.landingTarget.copy(state.supportLocalTarget);
    state.supportObject.localToWorld(state.landingTarget);
    state.supportPoint.copy(state.supportLocalPoint);
    state.supportObject.localToWorld(state.supportPoint);
    scratch.normalMatrix.getNormalMatrix(state.supportObject.matrixWorld);
    state.landingNormal
        .copy(state.supportLocalNormal)
        .applyMatrix3(scratch.normalMatrix)
        .normalize();

    if (previousTarget) {
        shiftPredictiveDebugTrajectory(
            state.debugTrajectory,
            scratch.v2.subVectors(state.landingTarget, previousTarget),
        );
    }
}

/** 把候选的落点和支撑面复制到另一份临时对象。 */
function copyPredictiveFootCandidate(
    source: PredictiveFootCandidate,
    target: PredictiveFootCandidate,
): void {
    target.target.copy(source.target);
    target.point.copy(source.point);
    target.normal.copy(source.normal);
    target.object = source.object;
    target.score = source.score;
    target.debugIndex = source.debugIndex;
}

/** 评估动画中心落点是否可站立，以及能否作为预测目标。 */
export function findPredictiveFootCandidates(
    ctx: PredictivePlacementContext,
    leg: ReadyFootIKLeg,
    phase: FootPhaseRuntimeState,
    expected: Vector3,
    expectedRotation: Quaternion,
): {
    candidate: PredictiveFootCandidate | null;
    centerSupport: PredictiveFootCandidate | null;
} {
    const scratch = ctx.scratch;
    // 用落地时刻的预计位移把髋部提前送到未来位置，再检查腿是否够得到落点。
    const futureRootDelta = scratch.v8
        .copy(ctx.predictionVelocity)
        .multiplyScalar(Math.min(phase.timeToLand, ctx.predictionHorizon));

    const debugCandidate = leg.predictive.debugCandidates[0];
    debugCandidate.evaluated = true;
    debugCandidate.valid = false;
    debugCandidate.selected = false;
    debugCandidate.point.copy(expected);
    const state = leg.predictive;
    state.debugSupportVisible = false;
    const probed = probePredictiveFootSupport(
        ctx,
        leg,
        expected.x,
        expected.z,
        expected,
        expectedRotation,
    );
    if (!probed) {
        return { candidate: null, centerSupport: null };
    }

    if (ctx.debug) {
        fillDebugSupportCorners(
            ctx,
            leg,
            expected.x,
            expected.z,
            expectedRotation,
            probed.candidate,
        );
        state.debugSupportVisible = true;
    }
    debugCandidate.point.copy(probed.candidate.point);
    // 鞋底探到了地面但法线过陡或没有共面支撑时，不能当作预测目标。
    if (!probed.accepted) {
        return { candidate: null, centerSupport: null };
    }

    copyPredictiveFootCandidate(probed.candidate, scratch.centerSupport);
    const candidate = finalizePredictiveFootCandidate(
        ctx,
        leg,
        probed.candidate,
        probed.supportCount,
        expected.x,
        expected.z,
        expected,
        expectedRotation,
        futureRootDelta,
    );
    // 可站但超出抬降或腿长时仍返回支撑面，供调试四边形和需求显示使用。
    if (!candidate) {
        return { candidate: null, centerSupport: scratch.centerSupport };
    }

    debugCandidate.valid = true;
    debugCandidate.selected = true;
    debugCandidate.point.copy(candidate.target);
    return { candidate, centerSupport: scratch.centerSupport };
}

/** 把鞋底四点投影到合并后的落点支撑面上，供调试绘制。 */
function fillDebugSupportCorners(
    ctx: PredictivePlacementContext,
    leg: ReadyFootIKLeg,
    centerX: number,
    centerZ: number,
    expectedRotation: Quaternion,
    support: PredictiveFootCandidate,
): void {
    const scratch = ctx.scratch;
    const worldScale = leg.foot.getWorldScale(scratch.v9);
    const corners = leg.predictive.debugSupportCorners;
    // 略微沿法线抬起，避免四边形 z-fight 陷入地面。
    const lift = Math.max(ctx.snapEpsilon, ctx.appliedScale * 0.4);
    for (let i = 0; i < corners.length; i++) {
        const sample = leg.soleSamples[i];
        if (!sample) {
            corners[i].copy(support.point).addScaledVector(support.normal, lift);
            continue;
        }
        scratch.v4
            .copy(sample.local)
            .multiply(worldScale)
            .applyQuaternion(expectedRotation);
        const corner = corners[i];
        corner.set(
            centerX + scratch.v4.x,
            support.point.y,
            centerZ + scratch.v4.z,
        );
        corner.addScaledVector(
            support.normal,
            lift - support.normal.dot(scratch.v1.subVectors(corner, support.point)),
        );
    }
}

/** 只检查鞋底能否在该落点站稳，不考虑腿长和抬降限制。 */
function probePredictiveFootSupport(
    ctx: PredictivePlacementContext,
    leg: ReadyFootIKLeg,
    centerX: number,
    centerZ: number,
    expected: Vector3,
    expectedRotation: Quaternion,
): { candidate: PredictiveFootCandidate; supportCount: number; accepted: boolean } | null {
    const scratch = ctx.scratch;
    const footWorldQ = expectedRotation;
    const worldScale = leg.foot.getWorldScale(scratch.v9);
    const hits = scratch.supportHitList;
    hits.length = 0;
    let highestHit: FootIKGroundHit | null = null;

    // 只在动画中心 XZ 打鞋底四角；有一个共面命中即可作为支撑面。
    for (const sample of leg.soleSamples as FootIKSoleSample[]) {
        const relative = scratch.v4
            .copy(sample.local)
            .multiply(worldScale)
            .applyQuaternion(footWorldQ);
        const hit = ctx.castGroundFrom(
            centerX + relative.x,
            expected.y + ctx.sampleRayOriginY,
            centerZ + relative.z,
        );
        if (!hit) continue;
        const stored = scratch.supportHits[hits.length];
        stored.point.copy(hit.point);
        stored.normal.copy(hit.normal);
        stored.object = hit.object;
        hits.push(stored);
        if (!highestHit || stored.point.y > highestHit.point.y) highestHit = stored;
    }
    if (!highestHit) return null;

    const pooled = scratch.candidates[0];
    const supportCount = ctx.mergeCoplanarHits(
        hits,
        highestHit,
        pooled.point,
        pooled.normal,
    );
    pooled.target.set(centerX, pooled.point.y, centerZ);
    pooled.object = highestHit.object ?? null;
    pooled.score = 0;
    pooled.debugIndex = 0;
    const accepted = supportCount >= 1
        && pooled.normal.y >= ctx.predictionMinNormalY;
    return { candidate: pooled, supportCount, accepted };
}

/** 在可站立支撑之上再施加修正距离、抬降和腿长约束。 */
function finalizePredictiveFootCandidate(
    ctx: PredictivePlacementContext,
    leg: ReadyFootIKLeg,
    pooled: PredictiveFootCandidate,
    supportCount: number,
    centerX: number,
    centerZ: number,
    expected: Vector3,
    expectedRotation: Quaternion,
    futureRootDelta: Vector3,
): PredictiveFootCandidate | null {
    const scratch = ctx.scratch;
    const correctionSq = (centerX - expected.x) ** 2 + (centerZ - expected.z) ** 2;
    const maxCorrectionSq = ctx.maxPredictionCorrection * ctx.maxPredictionCorrection;
    if (correctionSq > maxCorrectionSq) return null;

    const worldScale = leg.foot.getWorldScale(scratch.v9);
    const alignQ = ctx.getConstrainedFootAlign(
        pooled.normal,
        ctx.footAlignWeight,
        scratch.q2,
    );
    const targetWorldQ = scratch.q3.copy(alignQ).multiply(expectedRotation);

    // 按贴地后的脚掌旋转，把脚骨放到鞋底刚好坐在支撑平面上的高度。
    let targetY = -Infinity;
    for (const sample of leg.soleSamples) {
        const relative = scratch.v4
            .copy(sample.local)
            .multiply(worldScale)
            .applyQuaternion(targetWorldQ);
        const sampleX = centerX + relative.x;
        const sampleZ = centerZ + relative.z;
        const planeY = pooled.point.y - (
            pooled.normal.x * (sampleX - pooled.point.x)
            + pooled.normal.z * (sampleZ - pooled.point.z)
        ) / pooled.normal.y;
        targetY = Math.max(targetY, planeY - relative.y);
    }
    if (!Number.isFinite(targetY)) return null;

    pooled.target.set(centerX, targetY, centerZ);
    const heightDelta = targetY - expected.y;
    if (heightDelta > ctx.maxFootRaise || heightDelta < -ctx.maxFootDrop) return null;

    const hip = leg.upper.getWorldPosition(scratch.v5);
    const knee = leg.lower.getWorldPosition(scratch.v6);
    const foot = leg.foot.getWorldPosition(scratch.v7);
    const upperLen = hip.distanceTo(knee);
    const lowerLen = knee.distanceTo(foot);
    const maxReach = ctx.getSafeLegReach(upperLen, lowerLen, ctx.pelvisKneeBend);
    // 落地时髋会随角色根节点前移，用未来髋位判断当前落点是否仍在腿长内。
    hip.add(futureRootDelta);
    const reachRatio = maxReach > 1e-6 ? hip.distanceTo(pooled.target) / maxReach : Infinity;
    if (reachRatio > 1) return null;

    const correctionRatio = ctx.maxPredictionCorrection > 1e-6
        ? Math.sqrt(correctionSq) / ctx.maxPredictionCorrection
        : 0;
    const heightRange = Math.max(ctx.maxFootRaise, ctx.maxFootDrop, 1e-6);
    // 分数仅用于调试显示；中心落点没有第二候选比较。
    pooled.score = correctionRatio
        + (1 - pooled.normal.y) * 0.7
        + Math.abs(heightDelta) / heightRange * 0.4
        + (4 - supportCount) * 2
        + Math.max(0, reachRatio - 0.85) / 0.2 * 3;
    return pooled;
}
