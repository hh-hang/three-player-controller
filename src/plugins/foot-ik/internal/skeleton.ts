import { Vector3, type Bone, type Object3D } from "three";
import type {
    BoneRef,
    FootIKLeg,
    FootIKSide,
    FootIKSkeletonConfig,
    ReadyFootIKLeg,
} from "../types";
import { createPredictiveFootState } from "./predictivePlacement";

// 收集模型层级下的全部骨骼。
export function collectBones(root: Object3D | null | undefined): Bone[] {
    const bones: Bone[] = [];
    root?.traverse(obj => {
        if ((obj as Bone).isBone) bones.push(obj as Bone);
    });
    return bones;
}

// 查找常见命名里的骨盆/髋部骨骼。
export function findHips(bones: readonly Bone[]): Bone | null {
    return bones.find(bone => /hips|pelvis/i.test(bone.name)) ?? null;
}

// 创建单条腿的骨骼引用和 IK 运行时状态。
export function createLeg(
    side: FootIKSide,
    bones: readonly Bone[],
    skeletonConfig: FootIKSkeletonConfig | null = null,
): FootIKLeg {
    const legConfig = skeletonConfig?.legs?.[side] ?? null;
    const upper = resolveConfiguredBone(legConfig?.upper, bones, `${side}.upper`)
        ?? findBone(bones, side, "upper");
    const lower = resolveConfiguredBone(legConfig?.lower, bones, `${side}.lower`)
        ?? findBone(bones, side, "lower");
    const foot = resolveConfiguredBone(legConfig?.foot, bones, `${side}.foot`)
        ?? findBone(bones, side, "foot");
    const toe = resolveConfiguredBone(legConfig?.toe, bones, `${side}.toe`)
        ?? findBone(bones, side, "toe");

    return {
        side,
        upper,
        lower,
        foot,
        toe,
        ready: !!(upper && lower && foot),

        // IK 运行时目标和地面命中信息。
        smoothedTarget: new Vector3(),
        pelvisTarget: new Vector3(),
        hasPelvisTarget: false,
        hitPoint: new Vector3(),
        hitNormal: new Vector3(0, 1, 0),
        supportPoint: new Vector3(),
        supportNormal: new Vector3(0, 1, 0),
        footSamplePoint: new Vector3(),
        soleSamples: ["heelL", "heelR", "toeL", "toeR"].map(name => ({
            name,
            local: new Vector3(),
            point: new Vector3(),
            hitPoint: new Vector3(),
            hasHit: false,
            marker: null,
            rayLine: null,
            footMarker: null,
        })),
        bestGroundSampleIndex: -1,

        // 本帧脚部目标对动画脚位的修正量。
        offsetY: 0,
        movePenetrating: false,

        // weight 为最终 IK 权重，plantedWeight 只负责支撑脚渐入/渐出。
        weight: 0,
        plantedWeight: 0,
        planted: false,
        predictive: createPredictiveFootState(),

        // 上一帧 pole 只在弯曲平面退化时使用。
        lastPole: new Vector3(),
        hasLastPole: false,

        marker: null,
        hitMarker: null,
        rayLine: null,
        raiseLimitLine: null,
        predictiveLine: null,
        predictiveCandidateMarkers: [],
    };
}

// 判断腿链是否包含求解需要的三段骨骼。
export function isReadyLeg(leg: FootIKLeg): leg is ReadyFootIKLeg {
    return !!(leg.ready && leg.upper && leg.lower && leg.foot);
}

// 优先使用外部配置的骨骼引用，并在缺失时给出提示。
export function resolveConfiguredBone(
    ref: BoneRef | undefined,
    bones: readonly Bone[],
    label: string,
    warnMissing = true,
): Bone | null {
    if (!ref) return null;
    if (typeof ref !== "string" && ref.isBone) return ref;
    if (typeof ref === "string") {
        const bone = bones.find(item => item.name === ref) ?? null;
        if (!bone && warnMissing) {
            console.warn(`[FootIK] 配置骨骼未找到：${label} -> "${ref}"`);
        }
        return bone;
    }
    console.warn(`[FootIK] 无效骨骼配置：${label}`, ref);
    return null;
}

// 根据左右侧和骨骼类型，从模型骨骼名中启发式匹配目标骨骼。
export function findBone(
    bones: readonly Bone[],
    side: FootIKSide,
    type: "upper" | "lower" | "foot" | "toe",
): Bone | null {
    const candidates = bones.filter(bone => matchesSide(bone.name, side));
    const score = (bone: Bone): number => {
        const name = compactName(bone.name);
        if (type === "upper") return Number(name.includes("upleg") || name.includes("thigh"));
        if (type === "lower") return Number((name.includes("leg") || name.includes("calf") || name.includes("shin")) && !name.includes("upleg") && !name.includes("foot"));
        if (type === "foot") return Number((name.includes("foot") || name.includes("ankle")) && !name.includes("toe") && !name.includes("ball"));
        return Number(name.includes("toe") || (name.includes("ball") && !name.includes("leaf")));
    };
    return candidates
        .map(bone => ({ bone, score: score(bone) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.bone ?? null;
}

// 判断骨骼名是否属于指定左右侧。
export function matchesSide(name: string, side: FootIKSide): boolean {
    const lower = name.toLowerCase();
    const compact = compactName(name);
    if (side === "left") return compact.includes("left") || lower.includes("_l") || lower.includes(".l") || lower.includes(" l");
    return compact.includes("right") || lower.includes("_r") || lower.includes(".r") || lower.includes(" r");
}

// 把骨骼名压缩成便于规则匹配的形式。
export function compactName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
