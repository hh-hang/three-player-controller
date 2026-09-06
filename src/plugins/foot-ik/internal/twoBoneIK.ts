import { MathUtils, Quaternion, Vector3, type Bone, type Object3D } from "three";

export type TwoBoneIKScratch = {
    v1: Vector3;
    v2: Vector3;
    v3: Vector3;
    v4: Vector3;
    v5: Vector3;
    v6: Vector3;
    v7: Vector3;
    v8: Vector3;
    v9: Vector3;
    v10: Vector3;
    v11: Vector3;
    v12: Vector3;
    v13: Vector3;
    q1: Quaternion;
    q2: Quaternion;
    q3: Quaternion;
    identityQ: Quaternion;
};

/** 双骨骼 IK 解算所需的最小腿链。 */
export type TwoBoneIKLeg = {
    upper: Bone;
    lower: Bone;
    foot: Bone;
    /** 上一帧的世界空间 pole，只在弯曲平面退化时用于保持连续。 */
    lastPole?: Vector3;
    hasLastPole?: boolean;
};

export type SolveTwoBoneIKOptions = {
    scratch?: TwoBoneIKScratch;
    /** 修改骨骼前通知外部保存动画原姿态，下一帧 restore 会用到。 */
    capture?: (bone: Object3D) => void;
    /** 最小膝盖弯曲角，避免腿完全锁死伸直。 */
    minKneeBend?: number;
    /** 最大膝盖弯曲角，避免过度折叠。 */
    maxKneeBend?: number;
    /**
     * 膝盖弯曲平面的世界空间法线。
     * 角色的右方向作为法线时，膝盖只能在角色的前后平面内弯曲。
     */
    kneePlaneNormal?: Vector3;
    /** kneePlaneNormal 对原动画 pole 的覆盖权重，范围 0 到 1，默认 1。 */
    kneePlaneWeight?: number;
};

// 创建双骨骼 IK 解算复用对象，避免每帧重复分配临时变量。
export function createTwoBoneIKScratch(): TwoBoneIKScratch {
    return {
        v1: new Vector3(),
        v2: new Vector3(),
        v3: new Vector3(),
        v4: new Vector3(),
        v5: new Vector3(),
        v6: new Vector3(),
        v7: new Vector3(),
        v8: new Vector3(),
        v9: new Vector3(),
        v10: new Vector3(),
        v11: new Vector3(),
        v12: new Vector3(),
        v13: new Vector3(),
        q1: new Quaternion(),
        q2: new Quaternion(),
        q3: new Quaternion(),
        identityQ: new Quaternion(),
    };
}

// 受膝盖角度约束的双骨骼 IK。
// leg.upper / leg.lower / leg.foot 分别对应大腿、小腿、脚；target 是 foot 希望靠近的世界坐标。
export function solveTwoBoneIK(
    leg: TwoBoneIKLeg | null | undefined,
    target: Vector3,
    weight: number,
    options: SolveTwoBoneIKOptions = {},
): void {
    if (!leg?.upper || !leg?.lower || !leg?.foot || weight <= 0.001) return;

    const scratch = options.scratch ?? createTwoBoneIKScratch();
    const capture = options.capture ?? (() => { });
    const minBend = options.minKneeBend ?? MathUtils.degToRad(2);
    const maxBend = options.maxKneeBend ?? MathUtils.degToRad(145);
    const solveWeight = MathUtils.clamp(weight, 0, 1);

    // 静止时动画 pole 是主要弯曲方向；移动时只在稳定弯曲平面退化后作为兜底。
    // 移动状态由角色前后平面决定膝盖朝向。
    const restPole = getRestPole(leg, scratch);

    const hip = leg.upper.getWorldPosition(scratch.v1);
    const knee = leg.lower.getWorldPosition(scratch.v2);
    const foot = leg.foot.getWorldPosition(scratch.v3);
    const upperLen = Math.max(0.0001, hip.distanceTo(knee));
    const lowerLen = Math.max(0.0001, knee.distanceTo(foot));

    const hipToTarget = scratch.v4.copy(target).sub(hip);
    const targetDistance = hipToTarget.length();
    if (targetDistance < 0.0001) return;

    // 用膝盖最小/最大弯曲角反推 foot 能到达的距离范围。
    // target 太远会被夹到最大伸展距离，太近会被夹到最大弯曲距离。
    const maxReach = reachFromBend(upperLen, lowerLen, minBend);
    const minReach = reachFromBend(upperLen, lowerLen, maxBend);
    const clampedDistance = MathUtils.clamp(targetDistance, minReach, maxReach);
    const clampedTarget = scratch.v5.copy(hip).addScaledVector(hipToTarget, clampedDistance / targetDistance);

    // 在 hip -> target 的链方向上，用两段骨骼长度求出 knee 所在圆的中心和半径。
    // pole 决定 knee 落在圆的哪一侧，也就是膝盖朝向。
    // chainDir × 角色右轴得到的方向始终位于角色前后平面内，因此是“笔直弯”。
    const chainDir = scratch.v6.copy(clampedTarget).sub(hip).normalize();
    const pole = getStablePole(
        leg,
        restPole,
        options.kneePlaneNormal,
        MathUtils.clamp(options.kneePlaneWeight ?? 1, 0, 1),
        chainDir,
        scratch.v7,
        scratch.v4,
        scratch.q1,
        scratch.identityQ,
    );
    const along = (upperLen * upperLen - lowerLen * lowerLen + clampedDistance * clampedDistance) / (2 * clampedDistance);
    const height = Math.sqrt(Math.max(0, upperLen * upperLen - along * along));
    const desiredKnee = scratch.v8.copy(hip).addScaledVector(chainDir, along).addScaledVector(pole, height);

    // 第一步旋转大腿，让当前 knee 靠近解析出的 desiredKnee。
    rotateBoneToward(leg.upper, leg.lower.getWorldPosition(scratch.v9), desiredKnee, solveWeight, capture, scratch);
    leg.upper.updateMatrixWorld(true);
    leg.lower.updateMatrixWorld(true);

    // 第二步旋转小腿，让 foot 靠近被夹距后的目标点。
    rotateBoneToward(leg.lower, leg.foot.getWorldPosition(scratch.v9), clampedTarget, solveWeight, capture, scratch);
    leg.lower.updateMatrixWorld(true);
}

// 两段骨骼夹角为 bend 时，hip 到 foot 的理论距离。
function reachFromBend(upperLen: number, lowerLen: number, bend: number): number {
    return Math.sqrt(upperLen * upperLen + lowerLen * lowerLen + 2 * upperLen * lowerLen * Math.cos(bend));
}

// 从当前动画姿态提取膝盖弯曲方向。
// 把 hip->knee 投影到 hip->foot 的垂直平面上，得到“膝盖偏离腿链”的方向。
function getRestPole(leg: TwoBoneIKLeg, scratch: TwoBoneIKScratch): Vector3 {
    const hip = leg.upper.getWorldPosition(scratch.v9);
    const knee = leg.lower.getWorldPosition(scratch.v10);
    const foot = leg.foot.getWorldPosition(scratch.v11);
    const restChain = scratch.v12.copy(foot).sub(hip).normalize();
    const restPole = scratch.v13.copy(knee).sub(hip).addScaledVector(restChain, -scratch.v10.copy(knee).sub(hip).dot(restChain));
    if (restPole.lengthSq() < 0.000001) restPole.set(0, 0, 1);
    return scratch.v13.normalize();
}

// 优先由角色弯曲平面直接求 pole。这样动画里的横向膝摆不会参与选边。
function getStablePole(
    leg: TwoBoneIKLeg,
    restPole: Vector3,
    kneePlaneNormal: Vector3 | undefined,
    kneePlaneWeight: number,
    chainDir: Vector3,
    target: Vector3,
    straightPole: Vector3,
    poleRotation: Quaternion,
    identityRotation: Quaternion,
): Vector3 {
    const hasRestPole = projectPoleToChainPlane(restPole, chainDir, target);

    if (kneePlaneNormal && kneePlaneWeight > 0) {
        straightPole.crossVectors(chainDir, kneePlaneNormal);
        if (normalizePole(straightPole)) {
            if (hasRestPole && kneePlaneWeight < 1) {
                poleRotation
                    .setFromUnitVectors(target, straightPole)
                    .slerp(identityRotation, 1 - kneePlaneWeight);
                target.applyQuaternion(poleRotation).normalize();
            } else {
                target.copy(straightPole);
            }
            rememberPole(leg, target);
            return target;
        }

        // 移动时腿若几乎沿角色左右方向水平伸出，前后平面内没有唯一解。
        // 只在这个奇点沿用上一帧有效 pole，避免跨帧翻面。
        if (leg.hasLastPole && leg.lastPole
            && projectPoleToChainPlane(leg.lastPole, chainDir, target)) {
            rememberPole(leg, target);
            return target;
        }
    }

    // 静止模式直接走这里，完整保留 idle 动画 pole，不读取上一帧的历史结果。
    if (hasRestPole) {
        projectPoleToChainPlane(restPole, chainDir, target);
        rememberPole(leg, target);
        return target;
    }

    // 极端共线姿态的最终兜底。
    target.set(0, chainDir.z, -chainDir.y);
    if (!normalizePole(target)) {
        target.set(-chainDir.y, chainDir.x, 0);
        normalizePole(target);
    }
    rememberPole(leg, target);
    return target;
}

// 把方向投影到腿链垂直平面上，得到可用的膝盖 pole；投影退化时返回 false。
function projectPoleToChainPlane(direction: Vector3, chainDir: Vector3, target: Vector3): boolean {
    target.copy(direction).addScaledVector(chainDir, -direction.dot(chainDir));
    return normalizePole(target);
}

// 归一化 pole；长度过小时视为无效方向。
function normalizePole(pole: Vector3): boolean {
    const lengthSq = pole.lengthSq();
    if (lengthSq < 0.000001) return false;
    pole.multiplyScalar(1 / Math.sqrt(lengthSq));
    return true;
}

// 缓存本帧有效 pole，供下一帧奇点兜底。
function rememberPole(leg: TwoBoneIKLeg, pole: Vector3): void {
    if (!leg.lastPole) return;
    leg.lastPole.copy(pole);
    leg.hasLastPole = true;
}

// 把 bone 旋转到当前 effector 方向对齐目标方向。
// deltaWorldQ 在世界空间计算，最后转换回 bone 的本地 quaternion 写入骨骼。
function rotateBoneToward(
    bone: Bone,
    effectorWorld: Vector3,
    targetWorld: Vector3,
    weight: number,
    capture: (bone: Object3D) => void,
    scratch: TwoBoneIKScratch,
): void {
    capture(bone);

    const jointWorld = bone.getWorldPosition(scratch.v10);
    const from = scratch.v11.copy(effectorWorld).sub(jointWorld).normalize();
    const to = scratch.v12.copy(targetWorld).sub(jointWorld).normalize();
    if (from.lengthSq() < 0.0001 || to.lengthSq() < 0.0001) return;

    const deltaWorldQ = scratch.q1.setFromUnitVectors(from, to);
    // weight < 1 时只应用部分旋转，保留一部分原动画姿态。
    deltaWorldQ.slerp(scratch.identityQ, 1 - weight);

    const jointWorldQ = bone.getWorldQuaternion(scratch.q2);
    const targetWorldQ = deltaWorldQ.multiply(jointWorldQ);
    const parent = bone.parent;
    if (!parent) return;
    const parentWorldQ = parent.getWorldQuaternion(scratch.q3);
    bone.quaternion.copy(parentWorldQ.invert().multiply(targetWorldQ));
    bone.updateMatrixWorld(true);
}
