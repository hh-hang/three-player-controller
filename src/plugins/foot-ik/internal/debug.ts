import {
    BufferGeometry,
    Line,
    LineBasicMaterial,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    SphereGeometry,
    Vector3,
    type Material,
    type Scene,
} from "three";
import type {
    FootIKLeg,
    FootIKLegs,
    FootIKSide,
    FootPhaseControllerState,
    FootPhaseDatabase,
} from "../types";

const FOOT_IK_SIDES: readonly FootIKSide[] = ["left", "right"];

/** 设计尺度下的 IK 目标球半径；与脚底四点同级，世界半径 = 该值 × appliedScale。 */
const IK_MARKER_RADIUS = 3;
/** 设计尺度下的最高地面命中球半径。 */
const HIT_MARKER_RADIUS = 2.5;
/** 设计尺度下的脚底采样原点球半径。 */
const SAMPLE_ORIGIN_RADIUS = 3;
/** 设计尺度下的脚底采样命中球半径。 */
const SAMPLE_HIT_RADIUS = 2.5;
/** 支撑脚 IK 的目标球颜色。 */
const DEBUG_IK_PLANTED_COLOR = 0x22c55e;
/** 摆动脚防穿透 IK 的目标球颜色。 */
const DEBUG_IK_PENETRATION_COLOR = 0x3b82f6;
/** 未应用 IK 时的目标球颜色。 */
const DEBUG_IK_NOT_APPLIED_COLOR = 0xef4444;
/** 脚底采样球 / 连线（左右腿共用）。 */
const DEBUG_SOLID_COLOR = 0x2dd4bf;
/** 线框命中球（左右腿共用）。 */
const DEBUG_HIT_COLOR = 0xffff66;
/** 命中超出脚部 IK 最大上抬范围时的线框球颜色。 */
const DEBUG_HIT_OVER_RAISE_LIMIT_COLOR = 0xff3333;
/** 脚部 IK 最大上抬范围线框颜色。 */
const DEBUG_RAISE_LIMIT_COLOR = 0x60a5fa;
/** 命中超出最大上抬范围时的线框颜色。 */
const DEBUG_RAISE_LIMIT_EXCEEDED_COLOR = 0xff3333;
/** 预测目标仍在持续跟踪时的颜色。 */
const DEBUG_PREDICTIVE_TRACKING_COLOR = 0x38bdf8;
/** 预测目标已提交、不再切换候选时的颜色。 */
const DEBUG_PREDICTIVE_COMMITTED_COLOR = 0xf59e0b;
/** 可用但未被选中的预测候选颜色。 */
const DEBUG_PREDICTIVE_VALID_COLOR = 0xfde047;
/** 无法提供完整鞋底支撑的预测候选颜色。 */
const DEBUG_PREDICTIVE_INVALID_COLOR = 0xef4444;
/** 设计尺度下的预测候选球半径。 */
const PREDICTIVE_CANDIDATE_RADIUS = 2;
/** 每条腿的上抬范围由四条竖线和顶部四边组成。 */
const RAISE_LIMIT_POINTS = Array.from({ length: 16 }, () => new Vector3());
const SOLE_PERIMETER = [0, 1, 3, 2] as const;

/** 返回当前预测落脚状态对应的调试颜色。 */
function getPredictiveModeColor(leg: FootIKLeg): number {
    if (leg.predictive.mode === "committed") return DEBUG_PREDICTIVE_COMMITTED_COLOR;
    return DEBUG_PREDICTIVE_TRACKING_COLOR;
}

function setHitMarkerColor(mesh: Mesh, overRaiseLimit: boolean): void {
    const material = mesh.material;
    if (Array.isArray(material)) return;
    (material as MeshBasicMaterial).color.setHex(
        overRaiseLimit ? DEBUG_HIT_OVER_RAISE_LIMIT_COLOR : DEBUG_HIT_COLOR,
    );
}

function setIKMarkerColor(mesh: Mesh, leg: FootIKLeg, applied: boolean): void {
    const material = mesh.material;
    if (Array.isArray(material)) return;

    let color = DEBUG_IK_NOT_APPLIED_COLOR;
    if (leg.predictive.mode !== "none" && Number.isFinite(leg.predictive.score)) {
        color = getPredictiveModeColor(leg);
    } else if (applied) {
        if (leg.planted) color = DEBUG_IK_PLANTED_COLOR;
        else if (leg.movePenetrating) color = DEBUG_IK_PENETRATION_COLOR;
        else color = DEBUG_IK_PLANTED_COLOR;
    }
    (material as MeshBasicMaterial).color.setHex(color);
}

// 创建统一 Foot IK 调试对象：IK 目标、最高命中、脚底四点（原点 + 命中 + 射线）。
export function createDebugObjects(
    scene: Scene | null,
    legs: FootIKLegs,
    enabled: boolean,
): void {
    if (!enabled || !scene) return;

    let ikGeometry: SphereGeometry | null = null;
    let hitGeometry: SphereGeometry | null = null;
    let sampleOriginGeometry: SphereGeometry | null = null;
    let sampleHitGeometry: SphereGeometry | null = null;
    let predictiveCandidateGeometry: SphereGeometry | null = null;

    for (const side of FOOT_IK_SIDES) {
        const leg = legs[side];

        if (!leg.marker) {
            ikGeometry ??= new SphereGeometry(IK_MARKER_RADIUS, 10, 8);
            leg.marker = new Mesh(
                ikGeometry,
                new MeshBasicMaterial({
                    color: DEBUG_IK_NOT_APPLIED_COLOR,
                    depthTest: false,
                    transparent: true,
                    opacity: 0.95,
                }),
            );
            leg.marker.renderOrder = 30;
            leg.marker.frustumCulled = false;
            scene.add(leg.marker);
        }

        if (!leg.hitMarker) {
            hitGeometry ??= new SphereGeometry(HIT_MARKER_RADIUS, 10, 8);
            leg.hitMarker = new Mesh(
                hitGeometry,
                new MeshBasicMaterial({
                    color: DEBUG_HIT_COLOR,
                    wireframe: true,
                    depthTest: false,
                    transparent: true,
                    opacity: 0.9,
                }),
            );
            leg.hitMarker.renderOrder = 29;
            leg.hitMarker.frustumCulled = false;
            scene.add(leg.hitMarker);
        }

        if (!leg.rayLine) {
            leg.rayLine = new Line(
                new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
                new LineBasicMaterial({
                    color: DEBUG_SOLID_COLOR,
                    depthTest: false,
                    transparent: true,
                    opacity: 0.85,
                }),
            );
            leg.rayLine.renderOrder = 28;
            leg.rayLine.frustumCulled = false;
            scene.add(leg.rayLine);
        }

        if (!leg.raiseLimitLine) {
            leg.raiseLimitLine = new LineSegments(
                new BufferGeometry(),
                new LineBasicMaterial({
                    color: DEBUG_RAISE_LIMIT_COLOR,
                    depthTest: false,
                    transparent: true,
                    opacity: 0.75,
                }),
            );
            leg.raiseLimitLine.renderOrder = 24;
            leg.raiseLimitLine.frustumCulled = false;
            scene.add(leg.raiseLimitLine);
        }

        if (!leg.predictiveLine) {
            leg.predictiveLine = new Line(
                new BufferGeometry().setFromPoints(leg.predictive.debugTrajectory),
                new LineBasicMaterial({
                    color: DEBUG_PREDICTIVE_TRACKING_COLOR,
                    depthTest: false,
                    transparent: true,
                    opacity: 0.95,
                }),
            );
            leg.predictiveLine.visible = false;
            leg.predictiveLine.renderOrder = 32;
            leg.predictiveLine.frustumCulled = false;
            scene.add(leg.predictiveLine);
        }

        if (leg.predictiveCandidateMarkers.length === 0) {
            predictiveCandidateGeometry ??= new SphereGeometry(PREDICTIVE_CANDIDATE_RADIUS, 10, 8);
            for (const _candidate of leg.predictive.debugCandidates) {
                const marker = new Mesh(
                    predictiveCandidateGeometry,
                    new MeshBasicMaterial({
                        color: DEBUG_PREDICTIVE_INVALID_COLOR,
                        wireframe: true,
                        depthTest: false,
                        transparent: true,
                        opacity: 0.9,
                    }),
                );
                marker.visible = false;
                marker.renderOrder = 31;
                marker.frustumCulled = false;
                leg.predictiveCandidateMarkers.push(marker);
                scene.add(marker);
            }
        }

        for (const sample of leg.soleSamples) {
            // footMarker：脚底采样原点（跟骨骼）
            if (!sample.footMarker) {
                sampleOriginGeometry ??= new SphereGeometry(SAMPLE_ORIGIN_RADIUS, 10, 8);
                sample.footMarker = new Mesh(
                    sampleOriginGeometry,
                    new MeshBasicMaterial({
                        color: DEBUG_SOLID_COLOR,
                        depthTest: false,
                        transparent: true,
                        opacity: 0.85,
                    }),
                );
                sample.footMarker.renderOrder = 27;
                sample.footMarker.frustumCulled = false;
                scene.add(sample.footMarker);
            }
            // marker：该采样点的地面命中
            if (!sample.marker) {
                sampleHitGeometry ??= new SphereGeometry(SAMPLE_HIT_RADIUS, 10, 8);
                sample.marker = new Mesh(
                    sampleHitGeometry,
                    new MeshBasicMaterial({
                        color: DEBUG_HIT_COLOR,
                        wireframe: true,
                        depthTest: false,
                        transparent: true,
                        opacity: 0.8,
                    }),
                );
                sample.marker.renderOrder = 26;
                sample.marker.frustumCulled = false;
                scene.add(sample.marker);
            }
            if (!sample.rayLine) {
                sample.rayLine = new Line(
                    new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
                    new LineBasicMaterial({
                        color: DEBUG_SOLID_COLOR,
                        transparent: true,
                        opacity: 0.45,
                        depthTest: false,
                    }),
                );
                sample.rayLine.renderOrder = 25;
                sample.rayLine.frustumCulled = false;
                scene.add(sample.rayLine);
            }
        }
    }
}

// 更新统一调试显示。
export function updateFootDebug(
    enabled: boolean,
    leg: FootIKLeg,
    hitPoint: Vector3,
    scale = 1,
    maxFootRaise = 0,
): void {
    if (!enabled || !leg.marker || !leg.rayLine) return;

    const s = Math.max(1e-4, scale);
    const bestSample = leg.soleSamples[leg.bestGroundSampleIndex];
    const bestHitOverRaiseLimit = !!bestSample?.hasHit
        && hitPoint.y - bestSample.point.y > maxFootRaise;
    const ikApplied = leg.weight > 0.001;

    // 腿级：IK 目标 + 最高命中 + 命中→目标
    leg.marker.visible = true;
    leg.marker.position.copy(leg.smoothedTarget);
    leg.marker.scale.setScalar(s);
    setIKMarkerColor(leg.marker, leg, ikApplied);

    if (leg.hitMarker) {
        leg.hitMarker.visible = true;
        leg.hitMarker.position.copy(hitPoint);
        leg.hitMarker.scale.setScalar(s);
        setHitMarkerColor(leg.hitMarker, bestHitOverRaiseLimit);
    }

    // 只有实际应用 IK 时才显示“最高地面命中 → IK 目标”连线。
    leg.rayLine.visible = ikApplied;
    if (ikApplied) {
        leg.rayLine.geometry.setFromPoints([hitPoint, leg.smoothedTarget]);
    }

    updateRaiseLimitLine(leg, maxFootRaise);
    updatePredictiveDebug(leg, s);

    // 脚底四点：原点 + 命中 + 射线
    for (const sample of leg.soleSamples) {
        if (sample.footMarker) {
            sample.footMarker.visible = true;
            sample.footMarker.position.copy(sample.point);
            sample.footMarker.scale.setScalar(s);
        }
        if (sample.marker) {
            sample.marker.visible = sample.hasHit;
            if (sample.hasHit) {
                sample.marker.position.copy(sample.hitPoint);
                sample.marker.scale.setScalar(s);
                setHitMarkerColor(
                    sample.marker,
                    sample.hitPoint.y - sample.point.y > maxFootRaise,
                );
            }
        }
        if (sample.rayLine) {
            sample.rayLine.visible = sample.hasHit;
            if (sample.hasHit) {
                sample.rayLine.geometry.setFromPoints([sample.point, sample.hitPoint]);
            }
        }
    }
}

/** 更新预测摆动轨迹、五个候选点及其状态配色。 */
function updatePredictiveDebug(leg: FootIKLeg, scale: number): void {
    const state = leg.predictive;
    const showTrajectory = state.mode === "committed";
    const showCandidates = state.mode === "tracking";

    if (leg.predictiveLine) {
        leg.predictiveLine.visible = showTrajectory && state.debugTrajectoryVisible;
        if (leg.predictiveLine.visible) {
            leg.predictiveLine.geometry.setFromPoints(state.debugTrajectory);
            const material = leg.predictiveLine.material;
            if (!Array.isArray(material)) {
                (material as LineBasicMaterial).color.setHex(getPredictiveModeColor(leg));
            }
        }
    }

    for (let i = 0; i < leg.predictiveCandidateMarkers.length; i++) {
        const marker = leg.predictiveCandidateMarkers[i];
        const candidate = state.debugCandidates[i];
        marker.visible = showCandidates && !!candidate?.evaluated;
        if (!marker.visible || !candidate) continue;

        marker.position.copy(candidate.point);
        marker.scale.setScalar(scale * (candidate.selected ? 1.25 : 0.8));
        const material = marker.material;
        if (Array.isArray(material)) continue;
        const debugMaterial = material as MeshBasicMaterial;
        debugMaterial.wireframe = !candidate.selected;
        debugMaterial.color.setHex(
            candidate.selected
                ? getPredictiveModeColor(leg)
                : candidate.valid
                    ? DEBUG_PREDICTIVE_VALID_COLOR
                    : DEBUG_PREDICTIVE_INVALID_COLOR,
        );
    }
}

// 统一切换所有 Foot IK 调试对象的显隐。
export function setDebugVisible(legs: FootIKLegs, visible: boolean): void {
    for (const side of FOOT_IK_SIDES) {
        const leg = legs[side];
        if (leg.marker) leg.marker.visible = visible;
        if (leg.hitMarker) leg.hitMarker.visible = visible;
        if (leg.rayLine) leg.rayLine.visible = visible && leg.weight > 0.001;
        if (leg.raiseLimitLine) leg.raiseLimitLine.visible = visible;
        if (leg.predictiveLine) {
            leg.predictiveLine.visible = visible
                && leg.predictive.debugTrajectoryVisible
                && leg.predictive.mode === "committed";
        }
        for (let i = 0; i < leg.predictiveCandidateMarkers.length; i++) {
            const candidate = leg.predictive.debugCandidates[i];
            leg.predictiveCandidateMarkers[i].visible = visible
                && !!candidate?.evaluated
                && leg.predictive.mode === "tracking";
        }
        for (const sample of leg.soleSamples) {
            if (sample.footMarker) sample.footMarker.visible = visible;
            if (sample.marker) sample.marker.visible = visible && sample.hasHit;
            if (sample.rayLine) sample.rayLine.visible = visible && sample.hasHit;
        }
    }
}

// 返回当前动画脚步相位的简短调试文本。
export function getFootPhaseDebugText(
    state: FootPhaseControllerState,
    clips: FootPhaseDatabase,
    side: FootIKSide,
): string {
    const sideState = state[side];
    const clipName = state.clipName || "none";
    const dataReady = clips.has(clipName);
    if (!dataReady) return `${clipName}: no phase`;

    const phase = sideState.planted ? "plant" : "swing";
    const progress = Number.isFinite(sideState.progress)
        ? `${Math.round(sideState.progress * 100)}%`
        : "--";
    return `${clipName}: ${phase} ${progress}`;
}

// 移除调试对象并释放对应的 GPU 资源。
export function disposeDebugObjects(legs: FootIKLegs): void {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();

    for (const side of FOOT_IK_SIDES) {
        const leg = legs[side];
        collectDebugObject(leg.marker, geometries, materials);
        collectDebugObject(leg.hitMarker, geometries, materials);
        collectDebugObject(leg.rayLine, geometries, materials);
        collectDebugObject(leg.raiseLimitLine, geometries, materials);
        collectDebugObject(leg.predictiveLine, geometries, materials);
        for (const marker of leg.predictiveCandidateMarkers) {
            collectDebugObject(marker, geometries, materials);
        }
        leg.marker = null;
        leg.hitMarker = null;
        leg.rayLine = null;
        leg.raiseLimitLine = null;
        leg.predictiveLine = null;
        leg.predictiveCandidateMarkers.length = 0;

        for (const sample of leg.soleSamples) {
            collectDebugObject(sample.marker, geometries, materials);
            collectDebugObject(sample.rayLine, geometries, materials);
            collectDebugObject(sample.footMarker, geometries, materials);
            sample.marker = null;
            sample.rayLine = null;
            sample.footMarker = null;
        }
    }

    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
}

// 以当前动画脚底四点为起点，画出每个采样点可上抬到的最高边界。
function updateRaiseLimitLine(leg: FootIKLeg, maxFootRaise: number): void {
    if (!leg.raiseLimitLine || leg.soleSamples.length < 4) return;

    let cursor = 0;
    let exceeded = false;
    for (const sample of leg.soleSamples) {
        RAISE_LIMIT_POINTS[cursor++].copy(sample.point);
        RAISE_LIMIT_POINTS[cursor++].copy(sample.point).y += maxFootRaise;
        exceeded ||= sample.hasHit && sample.hitPoint.y - sample.point.y > maxFootRaise;
    }

    for (let i = 0; i < SOLE_PERIMETER.length; i++) {
        const from = leg.soleSamples[SOLE_PERIMETER[i]].point;
        const to = leg.soleSamples[SOLE_PERIMETER[(i + 1) % SOLE_PERIMETER.length]].point;
        RAISE_LIMIT_POINTS[cursor++].copy(from).setY(from.y + maxFootRaise);
        RAISE_LIMIT_POINTS[cursor++].copy(to).setY(to.y + maxFootRaise);
    }

    leg.raiseLimitLine.visible = true;
    leg.raiseLimitLine.geometry.setFromPoints(RAISE_LIMIT_POINTS);
    const material = leg.raiseLimitLine.material;
    if (!Array.isArray(material)) {
        (material as LineBasicMaterial).color.setHex(
            exceeded ? DEBUG_RAISE_LIMIT_EXCEEDED_COLOR : DEBUG_RAISE_LIMIT_COLOR,
        );
    }
}

function collectDebugObject(
    object: Mesh | Line | null,
    geometries: Set<BufferGeometry>,
    materials: Set<Material>,
): void {
    if (!object) return;
    object.parent?.remove(object);
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
    for (const material of objectMaterials) materials.add(material);
}
