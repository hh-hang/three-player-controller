import {
    Matrix3,
    MathUtils,
    Quaternion,
    Raycaster,
    Vector3,
    type Bone,
    type Intersection,
    type Mesh,
    type Object3D,
} from "three";
import { createTwoBoneIKScratch, solveTwoBoneIK } from "./internal/twoBoneIK";
import {
    buildFootPhaseDatabase,
    createFootPhaseOptions,
    createFootPhaseRuntimeState,
    sampleFootPhaseRuntime,
} from "./internal/footPhase";
import {
    collectBones,
    createLeg,
    findHips,
    isReadyLeg,
    resolveConfiguredBone,
} from "./internal/skeleton";
import {
    createDebugObjects,
    getFootPhaseDebugText,
    setDebugVisible,
    updateFootDebug,
    disposeDebugObjects,
} from "./internal/debug";
import {
    createPredictiveScratch,
    findPredictiveFootCandidates,
    getPredictiveDemandThresholds,
    getPredictivePlaneDistance,
    getPredictiveTerrainDemand,
    acceptPredictiveFootCandidate,
    refreshPredictiveSupportAnchor,
    resetPredictiveFootState,
    selectPredictiveDebugCandidate,
    shiftPredictiveDebugTrajectory,
    type PredictiveScratch,
} from "./internal/predictivePlacement";
import {
    getPredictiveClearanceShape,
    getPredictiveLocalProgress,
    planPredictiveFootTrajectory,
    PREDICTION_ROTATION_WARP_START,
    type PredictiveTrajectoryContext,
    type PredictiveTrajectoryPlan,
} from "./internal/predictiveTrajectory";
import type {
    FootIKBonePose,
    FootIKGroundHit,
    FootIKLeg,
    FootIKLegs,
    FootIKOptions,
    FootIKPlayer,
    FootIKSide,
    FootIKSkeletonConfig,
    FootPhaseControllerState,
    FootPhaseDatabase,
    FootPhaseOptions,
    FootPhaseRuntimeState,
    PredictiveFootState,
    ReadyFootIKLeg,
} from "./types";
import type { TwoBoneIKScratch } from "./internal/twoBoneIK";

/** Foot IK 不参与地面检测的动态刚体形状。 */
const FOOT_IK_IGNORED_DYNAMIC_KINDS = ["sphere"] as const;
/** 摆腿进入末段后锁定地形结果，避免落地前继续切换支撑面。 */
const PREDICTION_LOCK_PROGRESS = 0.88;
/** 预测线路启用后达到该局部进度时完成位置 IK 渐入。 */
const PREDICTION_IK_BLEND_END = 0.35;
/** 支撑落点残差在新摆腿前段完成释放的相位比例。 */
const PREDICTION_RELEASE_PROGRESS = 0.25;
/** 反应式 IK 追目标和渐出的阻尼系数。 */
const REACTIVE_IK_DAMP = 40;

function createGroundHit(): FootIKGroundHit {
    return {
        point: new Vector3(),
        normal: new Vector3(0, 1, 0),
    };
}

function copyGroundHit(source: FootIKGroundHit, target: FootIKGroundHit): FootIKGroundHit {
    target.point.copy(source.point);
    target.normal.copy(source.normal);
    target.object = source.object;
    return target;
}

/** 根据角色动画和地面高度修正脚部姿态的控制器插件。 */
export class FootIK {
    /** 插件名称。 */
    readonly name = "foot-ik";

    // 当前挂载的玩家控制器。
    private player: FootIKPlayer | null = null;

    // 生命周期与调试开关。
    private enabled: boolean;
    private disposed = false;
    private debug: boolean;

    // IK 距离、角度和脚掌贴合配置。
    private maxPelvisDrop = 50;
    private maxPelvisRaise = 50;
    private maxFootRaise = 50;
    private maxFootDrop = 50;
    private soleHalfWidth = 7;
    private soleToeExtend = 7;
    private soleHeelExtend = 3;
    private soleSkinThickness = 3;
    private moveLiftThreshold = 0.1;
    private footPhaseGroundThreshold = 5;
    private fakeToeExtend = 24;
    private sampleRayOriginY = 90;
    private raycastFar = 440;
    private snapEpsilon = 0.02;
    private pelvisRaiseCoplanarThreshold = 8;
    private pelvisRaiseEpsilon = 4;
    private pelvisRaiseMinNormalY = 0.98;
    private pelvisRaiseWeightThreshold = 0.8;
    // 预测落脚开关与搜索、线路和摆动修正配置。
    private predictivePlacement: boolean;
    private predictionHorizon: number;
    private predictionProbeInterval: number;
    private predictionSearchRadius = 20;
    private maxPredictionCorrection = 45;
    private predictionMinNormalY: number;
    private swingClearance = 8;
    private maxPredictionClearance = 50;
    // 当前距离字段已烘焙进去的 scale；改 scale 时按 ratio 连乘。
    private appliedScale = 1;

    private footAlignWeight: number;
    private maxFootTilt: number;
    private minKneeBend: number;
    private maxKneeBend: number;
    private pelvisKneeBend: number;

    // 骨盆垂直补偿。
    private pelvisOffset = 0;

    // 地面检测与每帧复用的临时对象。
    private colliderMeshes: Mesh[] = [];
    private readonly groundHit = createGroundHit();
    private readonly capsuleHit = createGroundHit();
    private readonly bestGroundHit = createGroundHit();
    private readonly sampleGroundHits = [
        createGroundHit(),
        createGroundHit(),
        createGroundHit(),
        createGroundHit(),
    ];
    private readonly sampleGroundHitSlots: Array<FootIKGroundHit | null> = [
        null,
        null,
        null,
        null,
    ];
    private readonly raycaster: Raycaster;
    private readonly up = new Vector3(0, 1, 0);
    private readonly tmpV1 = new Vector3();
    private readonly tmpV2 = new Vector3();
    private readonly tmpV3 = new Vector3();
    private readonly tmpV4 = new Vector3();
    private readonly tmpV5 = new Vector3();
    private readonly tmpV6 = new Vector3();
    private readonly tmpV7 = new Vector3();
    private readonly tmpV8 = new Vector3();
    private readonly tmpV9 = new Vector3();
    private readonly tmpV10 = new Vector3();
    private readonly tmpQ1 = new Quaternion();
    private readonly tmpQ2 = new Quaternion();
    private readonly tmpQ3 = new Quaternion();
    private readonly tmpQ4 = new Quaternion();
    // IK 前的动画脚旋转，用于抵消腿链求解对子骨骼产生的被动旋转。
    private readonly savedFootWorldQ = new Quaternion();
    // 脚掌贴坡后的旋转，用于二次接触校正时保持已完成的倾斜结果。
    private readonly savedAlignedFootWorldQ = new Quaternion();
    // 四元数球面插值使用的单位旋转终点。
    private readonly identityQ = new Quaternion();
    // 把碰撞面局部法线转换到世界空间。
    private readonly normalMatrix = new Matrix3();
    // 双骨骼 IK 解算器跨帧复用的临时对象。
    private readonly twoBoneIKScratch: TwoBoneIKScratch;
    // 预测落脚搜索和轨迹规划使用的专用临时对象。
    private readonly predictiveScratch: PredictiveScratch;

    // 胶囊实际位移速度比输入速度更能反映碰撞后的真实运动，用于预测未来根节点位置。
    private readonly previousCapsulePosition = new Vector3();
    private readonly predictionVelocity = new Vector3();
    private hasPreviousCapsulePosition = false;

    // 下一帧动画更新前需要恢复的骨骼及其动画原始姿态。
    private readonly adjusted = new Set<Object3D>();
    private readonly poseCache = new Map<Object3D, FootIKBonePose>();

    // 骨骼绑定和脚步相位配置。
    private readonly skeletonConfig: FootIKSkeletonConfig | null;
    private footPhaseOptions: FootPhaseOptions;

    // 当前模型生成的脚步相位数据库和运行时状态。
    private footPhaseClips: FootPhaseDatabase = new Map();
    private footPhaseState: FootPhaseControllerState;

    // 当前模型解析出的骨盆与左右腿链。
    private hips: Bone | null = null;
    private legs: FootIKLegs;

    /** 创建 FootIK 插件。 */
    constructor(options: FootIKOptions = {}) {
        this.enabled = options.enabled ?? true;
        this.debug = options.debug ?? false;

        // 距离类参数先写入 scale=1 基准值，挂载后按 playerModelConfig.scale 连乘。
        this.maxPelvisDrop = Math.max(0, options.maxPelvisDrop ?? this.maxPelvisDrop);
        this.maxPelvisRaise = Math.max(0, options.maxPelvisRaise ?? this.maxPelvisRaise);
        this.maxFootRaise = Math.max(0, options.maxFootRaise ?? this.maxFootRaise);
        this.maxFootDrop = Math.max(0, options.maxFootDrop ?? this.maxFootDrop);
        this.soleHalfWidth = Math.max(0, options.soleHalfWidth ?? this.soleHalfWidth);
        this.soleToeExtend = Math.max(0, options.soleToeExtend ?? this.soleToeExtend);
        this.soleHeelExtend = Math.max(0, options.soleHeelExtend ?? this.soleHeelExtend);
        this.soleSkinThickness = Math.max(0, options.soleSkinThickness ?? this.soleSkinThickness);
        this.moveLiftThreshold = Math.max(0, options.moveLiftThreshold ?? this.moveLiftThreshold);
        this.footPhaseGroundThreshold = Math.max(0, options.footPhaseGroundThreshold ?? this.footPhaseGroundThreshold);
        this.predictionSearchRadius = Math.max(0, options.predictionSearchRadius ?? this.predictionSearchRadius);
        this.maxPredictionCorrection = Math.max(0, options.maxPredictionCorrection ?? this.maxPredictionCorrection);
        this.swingClearance = Math.max(0, options.swingClearance ?? this.swingClearance);
        this.maxPredictionClearance = Math.max(
            0,
            options.maxPredictionClearance ?? this.maxFootRaise,
        );

        // 预测落脚默认关闭，确保未显式开启时不改变既有 Foot IK 行为。
        this.predictivePlacement = options.predictivePlacement ?? false;
        this.predictionHorizon = Math.max(0, options.predictionHorizon ?? 0.45);
        this.predictionProbeInterval = Math.max(0, options.predictionProbeInterval ?? 0.05);
        this.predictionMinNormalY = MathUtils.clamp(options.predictionMinNormalY ?? 0.55, 0, 1);
        this.footAlignWeight = MathUtils.clamp(options.footAlignWeight ?? 1, 0, 1); // 脚掌贴合地面法线的强度
        this.maxFootTilt = MathUtils.clamp(options.maxFootTilt ?? Math.PI / 2, 0, Math.PI); // 脚掌贴坡最大旋转角
        const configuredMinBend = MathUtils.clamp(options.minKneeBend ?? MathUtils.degToRad(2), 0, Math.PI);
        const configuredMaxBend = MathUtils.clamp(options.maxKneeBend ?? MathUtils.degToRad(145), 0, Math.PI);
        this.minKneeBend = Math.min(configuredMinBend, configuredMaxBend);
        this.maxKneeBend = Math.max(configuredMinBend, configuredMaxBend);
        this.pelvisKneeBend = MathUtils.clamp(
            options.pelvisKneeBend ?? MathUtils.degToRad(15),
            this.minKneeBend,
            this.maxKneeBend,
        );

        // 脚底检测射线；far 会在 rescaleDistances 中随 scale 更新。
        this.raycaster = new Raycaster(new Vector3(), new Vector3(0, -1, 0), 0, this.raycastFar);
        (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;

        // 从动画中自动采样脚步相位，用于判断移动动画中的支撑脚。
        this.footPhaseOptions = createFootPhaseOptions({
            ...options,
            footPhaseGroundThreshold: this.footPhaseGroundThreshold,
        });
        this.footPhaseState = {
            clipName: "",
            normalizedTime: 0,
            left: createFootPhaseRuntimeState(),
            right: createFootPhaseRuntimeState(),
        };

        this.twoBoneIKScratch = createTwoBoneIKScratch();
        this.predictiveScratch = createPredictiveScratch();

        // 未传配置时才回退到启发式匹配。
        this.skeletonConfig = options.skeleton ?? null; // 骨骼绑定配置，支持骨骼名或 Bone 对象
        this.legs = this.createEmptyLegs();
    }

    /** 挂载到玩家控制器并绑定当前模型骨骼。 */
    onAttach(player: FootIKPlayer): void {
        if (this.disposed) {
            throw new Error("[FootIK] 已销毁的插件不能再次挂载。");
        }
        if (this.player && this.player !== player) this.detachPlayer();
        this.attachPlayer(player);
    }

    /** 从玩家控制器卸载并恢复插件修改。 */
    onDetach(): void {
        this.detachPlayer();
    }

    /** 在动画更新前恢复上一帧被 IK 修改的骨骼姿态。 */
    onBeforeAnimationUpdate(_delta: number): void {
        if (!this.enabled || this.disposed) return;
        this.restore();
    }

    /** 在动画更新后应用当前帧 Foot IK。 */
    onAfterAnimationUpdate(delta: number): void {
        if (!this.enabled || this.disposed) return;
        this.syncDistanceScale();
        this.update(delta);
    }

    /** 玩家模型切换后重新绑定骨骼和脚步相位数据。 */
    onPlayerModelChange(): void {
        if (this.disposed) return;
        this.rebind();
    }

    /** 终止使用插件并释放调试资源。 */
    dispose(): void {
        if (this.disposed) return;
        this.detachPlayer();
        this.disposed = true;
        this.footPhaseClips.clear();
        this.adjusted.clear();
        this.poseCache.clear();
    }

    // 模型切换后释放旧调试对象，并基于新模型重新绑定全部运行时数据。
    private rebind(): void {
        if (!this.player?.playerModel) return;
        this.restore();
        disposeDebugObjects(this.legs);
        this.syncDistanceScale();
        this.bindSkeleton();
    }

    /** 读取当前角色 scale，未挂载时按 1 处理。 */
    private getPlayerScale(): number {
        const scale = this.player?.playerModelConfig?.scale;
        return typeof scale === "number" && scale > 0 ? scale : 1;
    }

    /** 把 scale=1 基准距离写成当前世界值。 */
    private scaleDistance(value: number): number {
        return Math.max(0, value) * this.getPlayerScale();
    }

    /** 把已缩放的世界距离还原为 scale=1 基准值（供 getOptions 使用）。 */
    private toBaseDistance(world: number): number {
        return this.appliedScale > 0 ? world / this.appliedScale : world;
    }

    /** 若角色 scale 变化，对距离字段做 ratio 连乘。 */
    private syncDistanceScale(): void {
        const scale = this.getPlayerScale();
        if (scale === this.appliedScale) return;
        this.rescaleDistances(scale);
    }

    /** 将距离字段从 appliedScale 换算到 newScale。 */
    private rescaleDistances(newScale: number): void {
        const next = newScale > 0 ? newScale : 1;
        const ratio = next / this.appliedScale;
        if (ratio === 1) {
            this.appliedScale = next;
            return;
        }

        this.maxPelvisDrop *= ratio;
        this.maxPelvisRaise *= ratio;
        this.maxFootRaise *= ratio;
        this.maxFootDrop *= ratio;
        this.soleHalfWidth *= ratio;
        this.soleToeExtend *= ratio;
        this.soleHeelExtend *= ratio;
        this.soleSkinThickness *= ratio;
        this.moveLiftThreshold *= ratio;
        this.footPhaseGroundThreshold *= ratio;
        this.fakeToeExtend *= ratio;
        this.sampleRayOriginY *= ratio;
        this.raycastFar *= ratio;
        this.snapEpsilon *= ratio;
        this.pelvisRaiseCoplanarThreshold *= ratio;
        this.pelvisRaiseEpsilon *= ratio;
        this.predictionSearchRadius *= ratio;
        this.maxPredictionCorrection *= ratio;
        this.swingClearance *= ratio;
        this.maxPredictionClearance *= ratio;
        this.pelvisOffset *= ratio;
        this.raycaster.far = this.raycastFar;
        this.footPhaseOptions.groundThreshold = this.footPhaseGroundThreshold;
        this.appliedScale = next;
    }

    /** 启用或停用 Foot IK；停用时立即恢复插件修改。 */
    setEnabled(enabled: boolean): void {
        if (this.disposed) return;
        this.enabled = enabled;
        if (!enabled) {
            this.restore();
            this.pelvisOffset = 0;
            this.resetPredictionRuntime();
            this.setDebugVisible(false);
        } else if (this.debug) {
            this.setDebugEnabled(true);
        }
    }

    // 保存玩家控制器引用并初始化模型相关状态。
    private attachPlayer(player: FootIKPlayer): void {
        if (this.player === player && this.legs.left.ready) return;
        this.player = player;
        this.syncDistanceScale();
        this.pelvisOffset = 0;
        this.resetPredictionRuntime();
        this.bindSkeleton();
    }

    // 恢复骨骼，释放调试资源并清空所有控制器相关引用。
    private detachPlayer(): void {
        this.restore();
        disposeDebugObjects(this.legs);
        this.footPhaseClips.clear();
        this.adjusted.clear();
        this.poseCache.clear();
        this.hips = null;
        this.legs = this.createEmptyLegs();
        // 还原到 scale=1 基准值，便于卸载后再挂载或单独 configure。
        this.rescaleDistances(1);
        this.player = null;
        this.pelvisOffset = 0;
        this.resetPredictionRuntime();
    }

    // 创建尚未绑定骨骼的左右腿占位状态。
    private createEmptyLegs(): FootIKLegs {
        return {
            left: createLeg("left", []),
            right: createLeg("right", []),
        };
    }

    // 解析骨骼后初始化脚底采样、脚步相位数据库和调试对象。
    private bindSkeleton(): void {
        const bones = collectBones(this.player?.playerModel);
        this.hips = resolveConfiguredBone(this.skeletonConfig?.hips, bones, "hips")
            ?? findHips(bones);
        this.legs = {
            left: createLeg("left", bones, this.skeletonConfig),
            right: createLeg("right", bones, this.skeletonConfig),
        };

        if (!this.hips || !isReadyLeg(this.legs.left) || !isReadyLeg(this.legs.right)) {
            console.warn("[FootIK] 骨骼识别不完整，当前模型骨骼名：", bones.map(b => b.name));
        }
        this.player?.playerModel?.updateMatrixWorld(true);
        this.initSoleLocalSamples(this.legs.left);
        this.initSoleLocalSamples(this.legs.right);
        this.buildFootPhaseDatabase();
        this.createDebugObjects();
        this.resetPredictionRuntime();
    }

    /** 清空胶囊速度历史和双脚预测目标，避免挂载、切模或开关切换后沿用旧落点。 */
    private resetPredictionRuntime(): void {
        this.predictionVelocity.set(0, 0, 0);
        this.hasPreviousCapsulePosition = false;
        if (this.player?.playerCapsule) {
            this.previousCapsulePosition.copy(this.player.playerCapsule.position);
            this.hasPreviousCapsulePosition = true;
        }
        resetPredictiveFootState(this.legs.left.predictive);
        resetPredictiveFootState(this.legs.right.predictive);
    }

    // 恢复上一帧 IK 修改前的骨骼姿态
    private restore(): void {
        // 先恢复上一帧的动画原始姿态，再让 mixer 推进当前帧
        // 调用顺序：footIK.restore() -> player.update() -> footIK.update()
        for (const bone of this.adjusted) {
            const pose = this.poseCache.get(bone);
            if (!pose) continue;
            bone.position.copy(pose.position);
            bone.quaternion.copy(pose.quaternion);
        }
        this.adjusted.clear();
    }

    // 在动画更新后执行每帧腿部 IK 修正。
    private update(delta = 1 / 60): void {
        if (!this.enabled || this.disposed) return;
        this.updateFootPhaseRuntime();
        if (this.predictivePlacement) this.updatePredictionVelocity(delta);
        this.refreshColliderMeshes();

        const player = this.player;
        // 不在地面、飞行或载具模式时不做腿部贴地
        if (
            !player
            || (!this.colliderMeshes.length && !player.getDynamicBodies?.().length)
            || !player.playerCapsule
            || !player.playerIsOnGround
            || player.isFlying
            || player.getControllerMode?.() === 1
        ) {
            if (this.predictivePlacement) {
                resetPredictiveFootState(this.legs.left.predictive);
                resetPredictiveFootState(this.legs.right.predictive);
            }
            this.setDebugVisible(false);
            return;
        }

        const model = player.playerModel;
        model?.updateMatrixWorld(true);

        // moving 决定移动与静止 IK 策略：移动使用脚步相位和稳定直弯 pole，静止保留动画 pole。
        const moving = this.isLocomotion();
        if (this.predictivePlacement && !moving) {
            // 离开移动状态后交还给静止 Foot IK，避免 idle 继续沿用旧摆动线路。
            resetPredictiveFootState(this.legs.left.predictive);
            resetPredictiveFootState(this.legs.right.predictive);
        }

        // 先算左右脚目标，再根据两只脚目标调整骨盆，最后解腿部 IK。
        this.updateFoot("left", delta, moving);
        this.updateFoot("right", delta, moving);
        this.applyPelvis(delta);
        this.applyLeg("left", moving);
        this.applyLeg("right", moving);
    }

    /** 根据胶囊碰撞修正后的实际位移更新水平预测速度。 */
    private updatePredictionVelocity(delta: number): void {
        const capsule = this.player?.playerCapsule;
        if (!capsule) return;

        if (!this.hasPreviousCapsulePosition || delta <= 0) {
            this.previousCapsulePosition.copy(capsule.position);
            this.hasPreviousCapsulePosition = true;
            return;
        }

        // 实际位移包含墙体阻挡和台阶推出，比单独读取输入目标速度更适合作为落脚预测依据。
        const measured = this.tmpV6
            .subVectors(capsule.position, this.previousCapsulePosition)
            .multiplyScalar(1 / delta)
            .setY(0);
        const controllerVelocity = this.player?.getVelocity?.();
        if (controllerVelocity) {
            // 少量混入控制器速度，改善刚起步时实际位移样本过小造成的预测滞后。
            measured.lerp(this.tmpV7.copy(controllerVelocity).setY(0), 0.15);
        }

        const alpha = 1 - Math.exp(-12 * delta);
        this.predictionVelocity.lerp(measured, alpha);
        this.previousCapsulePosition.copy(capsule.position);
    }

    // 构建脚步相位库。具体采样和过滤逻辑在 footPhase.ts 中。
    private buildFootPhaseDatabase(): void {
        const model = this.player?.playerModel;
        const clips = this.player?.animation?.clips ?? [];
        this.footPhaseClips = buildFootPhaseDatabase(
            model,
            clips,
            this.legs,
            this.footPhaseOptions,
            name => this.isLocomotionClipName(name),
        );

        if (this.debug && this.footPhaseClips.size === 0) {
            console.warn("[FootIK] 没有生成脚步相位数据，请确认移动动画和脚骨骼配置。");
        }
    }

    // 根据当前动画播放时间更新左右脚相位。这里只同步状态，不直接驱动 IK。
    private updateFootPhaseRuntime(): void {
        const action = this.player?.animation?.state;
        if (!action) {
            this.footPhaseState.clipName = "";
            return;
        }
        const clip = action.getClip();
        if (clip.duration <= 0) return;

        const data = this.footPhaseClips.get(clip.name);
        this.footPhaseState.clipName = clip.name;
        this.footPhaseState.normalizedTime = ((action.time / clip.duration) % 1 + 1) % 1;

        if (!data) {
            this.footPhaseState.left = createFootPhaseRuntimeState();
            this.footPhaseState.right = createFootPhaseRuntimeState();
            return;
        }

        const runtime = sampleFootPhaseRuntime(data, this.footPhaseState.normalizedTime, clip.duration);
        this.footPhaseState.left = runtime.left;
        this.footPhaseState.right = runtime.right;
    }

    // 计算单脚 IK 目标、权重和骨盆偏移。
    private updateFoot(side: FootIKSide, delta: number, moving: boolean): void {
        const leg = this.legs[side];
        if (!isReadyLeg(leg)) return;

        const footWorld = leg.foot.getWorldPosition(this.tmpV10);
        leg.hasPelvisTarget = false;
        const phase = this.footPhaseState?.[side];
        const phasePlanted = moving && !!phase?.planted;
        const nextPlanted = !moving || phasePlanted;
        const wasPlanted = leg.planted;
        const startedSwing = wasPlanted && !nextPlanted;
        const previousWeight = leg.weight;
        const wasMovePenetrating = leg.movePenetrating;
        leg.planted = nextPlanted;

        if (this.predictivePlacement) {
            this.updatePredictiveFoot(
                leg,
                phase,
                footWorld,
                startedSwing,
                delta,
            );
        } else if (leg.predictive.mode !== "none") {
            resetPredictiveFootState(leg.predictive);
        }

        // 改变水平落点的预测结果在支撑阶段继续使用原落点，避免切回动画时跳变。
        if (leg.planted && this.resolvePredictivePlantedFoot(leg, footWorld, delta)) return;

        // 统一融合后的预测摆动脚不再进入原有防穿透分支。
        if (!leg.planted && this.resolvePredictiveSwingFoot(leg, footWorld, phase)) return;
        // 偏移落点留下的支撑残差在新摆腿前段连续归还给动画。
        if (!leg.planted && this.resolvePredictiveReleaseFoot(leg, footWorld)) return;

        const hit = this.castBestFootGround(leg);

        // 脚底没有命中地面时，把已有反应式修正按时间渐出。
        if (!hit) {
            this.fadeReactiveFoot(leg, footWorld, delta);
            this.updateFootDebug(leg, footWorld);
            return;
        }

        leg.hitNormal.copy(hit.normal);
        leg.hitPoint.copy(hit.point);

        const groundOffset = this.getFootGroundOffset(leg);
        const liftAmount = Math.max(0, groundOffset);
        const pelvisTargetOffset = this.getAlignedFootTargetOffset(leg, footWorld);
        // 支撑脚下探超过最大范围时，把已有反应式修正按时间渐出。
        if (leg.planted && pelvisTargetOffset < -this.maxFootDrop) {
            this.fadeReactiveFoot(leg, footWorld, delta);
            this.updateFootDebug(leg, hit.point);
            return;
        }
        const targetOffset = leg.planted
            ? pelvisTargetOffset
            : Math.max(0, pelvisTargetOffset);
        // 命中面超过脚部最大上抬范围时，把已有反应式修正按时间渐出。
        if (targetOffset > this.maxFootRaise) {
            this.fadeReactiveFoot(leg, footWorld, delta);
            this.updateFootDebug(leg, hit.point);
            return;
        }
        if (
            pelvisTargetOffset <= this.maxFootRaise
            && pelvisTargetOffset >= -this.maxFootDrop
        ) {
            leg.hasPelvisTarget = true;
            leg.pelvisTarget
                .copy(footWorld)
                .addScaledVector(this.up, pelvisTargetOffset);
        }

        // 支撑脚双向贴地；摆动脚只在穿透时上抬。权重和高度都按时间阻尼，不瞬切。
        leg.movePenetrating = liftAmount > this.moveLiftThreshold;

        const wantedPlantedWeight = leg.planted ? 1 : 0;
        if (startedSwing || (wasMovePenetrating && !leg.movePenetrating)) {
            // 离地或结束防穿透的首帧继承上一帧实际输出，避免暴露较低的内部相位权重。
            leg.plantedWeight = previousWeight;
        } else {
            leg.plantedWeight = MathUtils.damp(
                leg.plantedWeight ?? 0,
                wantedPlantedWeight,
                REACTIVE_IK_DAMP,
                delta,
            );
        }
        if (leg.plantedWeight < 0.001) leg.plantedWeight = 0;

        const wantedWeight = (leg.planted || leg.movePenetrating) ? 1 : 0;
        const wantedAppliedOffset = (leg.planted || leg.movePenetrating)
            ? targetOffset
            : 0;
        this.dampReactiveOffset(
            leg,
            footWorld,
            wantedAppliedOffset,
            wantedWeight,
            delta,
        );

        this.updateFootDebug(leg, hit.point);
    }

    /** 反应式 IK 按时间追世界高度和权重；不应用时目标回到当前动画脚。 */
    private dampReactiveOffset(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        wantedOffset: number,
        wantedWeight: number,
        delta: number,
    ): void {
        const footAlongUp = footWorld.dot(this.up);
        const wantedAlongUp = footAlongUp + wantedOffset;
        // 已有输出时沿用上一帧世界高度；尚未应用时从当前动画脚开始。
        const hasPrevious = leg.weight > 0.001
            || Math.abs(leg.offsetY) > this.snapEpsilon;
        const previousAlongUp = hasPrevious
            ? leg.smoothedTarget.dot(this.up)
            : footAlongUp;
        let dampedAlongUp = MathUtils.damp(
            previousAlongUp,
            wantedAlongUp,
            REACTIVE_IK_DAMP,
            delta,
        );
        if (Math.abs(dampedAlongUp - wantedAlongUp) < this.snapEpsilon) {
            dampedAlongUp = wantedAlongUp;
        }
        leg.offsetY = dampedAlongUp - footAlongUp;

        leg.weight = MathUtils.damp(
            leg.weight,
            wantedWeight,
            REACTIVE_IK_DAMP,
            delta,
        );
        if (leg.weight < 0.001) leg.weight = 0;

        // XZ 跟当前动画脚，高度走上面阻尼后的世界值。
        leg.smoothedTarget.copy(footWorld).addScaledVector(this.up, leg.offsetY);
    }

    /** 反应式 IK 不再应用时，把权重和高度修正按时间还给动画。 */
    private fadeReactiveFoot(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        delta: number,
    ): void {
        leg.movePenetrating = false;
        leg.hasPelvisTarget = false;
        leg.plantedWeight = MathUtils.damp(
            leg.plantedWeight,
            0,
            REACTIVE_IK_DAMP,
            delta,
        );
        if (leg.plantedWeight < 0.001) leg.plantedWeight = 0;
        this.dampReactiveOffset(leg, footWorld, 0, 0, delta);
    }

    /** 摆动期间持续更新预测线路，并在末段锁定最终落脚结果。 */
    private updatePredictiveFoot(
        leg: ReadyFootIKLeg,
        phase: FootPhaseRuntimeState | undefined,
        footWorld: Vector3,
        startedSwing: boolean,
        delta: number,
    ): void {
        const state = leg.predictive;

        // 偏移落点进入支撑后转为 planted 锚点；中心落点则交还给普通贴地 IK。
        if (leg.planted) {
            if (state.mode === "active" && state.usesOffsetLanding) {
                state.mode = "planted";
                state.predictionWeight = 1;
                state.debugTrajectoryVisible = false;
            } else if (state.mode !== "planted" && state.mode !== "none") {
                resetPredictiveFootState(state);
            }
            return;
        }

        if (startedSwing) {
            // 上一支撑若改过水平落点，把残差带到新摆腿前段再还给动画。
            const preserveRelease = state.mode === "planted"
                && state.usesOffsetLanding;
            if (preserveRelease) {
                this.tmpV1.subVectors(
                    state.trajectoryCurrentTarget,
                    footWorld,
                );
            }
            resetPredictiveFootState(state);
            state.mode = "tracking";
            if (
                preserveRelease
                && this.tmpV1.lengthSq() > this.snapEpsilon * this.snapEpsilon
            ) {
                state.releaseOffset.copy(this.tmpV1);
                state.releaseStartProgress = phase?.progress ?? 0;
                state.releaseActive = true;
            }
        }

        if (!phase?.nextLanding || !Number.isFinite(phase.timeToLand)) {
            resetPredictiveFootState(state);
            return;
        }

        if (state.mode === "none") {
            // 运行中开启预测开关时也允许从当前摆动相位接管，不必等待下一个完整步态周期。
            state.mode = "tracking";
        }

        state.trajectoryProgress = Math.max(
            state.trajectoryProgress,
            phase.progress,
        );

        const model = this.player?.playerModel;
        if (!model) return;
        // 用剩余落地时间和当前胶囊速度，把动画落点推到预计踩实时的世界位置。
        const predictionTime = Math.min(phase.timeToLand, this.predictionHorizon);
        state.animatedLanding
            .copy(phase.nextLanding.localPosition)
            .applyMatrix4(model.matrixWorld)
            .addScaledVector(this.predictionVelocity, predictionTime);
        state.animatedLandingRotation
            .copy(model.getWorldQuaternion(this.tmpQ4))
            .multiply(phase.nextLanding.localRotation);

        // 动画中心落点始终跟随当前预测结果，落地时水平修正自然收敛为零。
        if (state.mode === "active" && !state.usesOffsetLanding) {
            this.followAnimatedLandingTarget(leg);
        }

        // 摆腿末段锁定支撑面，避免落地前一帧换到另一级台阶。
        if (state.trajectoryProgress >= PREDICTION_LOCK_PROGRESS) {
            return;
        }

        state.probeElapsed += delta;
        // 射线按探测间隔更新，间隔内继续用上一份落点和当前动画脚解目标。
        if (state.probeElapsed >= this.predictionProbeInterval) {
            state.probeElapsed = 0;
            const ctx = this.getPredictiveContext(model);
            const { candidate, centerSupport } = findPredictiveFootCandidates(
                ctx,
                leg,
                phase,
                state.animatedLanding,
                state.animatedLandingRotation,
            );
            if (!centerSupport) {
                this.suppressFlatPredictiveFoot(leg);
                return;
            }

            const trajectoryStart = state.mode === "active"
                ? state.trajectoryCurrentTarget
                : state.releaseActive
                    ? this.predictiveScratch.trajectoryStart
                        .copy(footWorld)
                        .addScaledVector(
                            state.releaseOffset,
                            this.getPredictiveReleaseWeight(state),
                        )
                    : footWorld;
            const trajectoryStartProgress = state.mode === "active"
                ? state.trajectoryStartProgress
                : state.trajectoryProgress;

            const { enter: demandEnter, exit: demandExit } =
                getPredictiveDemandThresholds(
                    this.appliedScale,
                    this.snapEpsilon,
                    this.predictiveScratch,
                );
            // 已激活时用更低的退出阈值，减少台阶边缘反复进出预测。
            const demandThreshold = state.mode === "active"
                ? demandExit
                : demandEnter;

            if (candidate) {
                const plan = planPredictiveFootTrajectory(
                    ctx,
                    leg,
                    phase,
                    footWorld,
                    trajectoryStart,
                    trajectoryStartProgress,
                    candidate,
                );
                const planeLift = getPredictivePlaneDistance(ctx, candidate);
                const swingLift = plan?.terrainDemand ?? 0;
                state.debugPlaneLift = planeLift;
                state.debugSwingLift = swingLift;
                const terrainDemand = getPredictiveTerrainDemand(
                    planeLift,
                    swingLift,
                );

                // 落点上台和摆腿途中凸起都不够高时，保持动画和反应式 IK。
                if (terrainDemand < demandThreshold) {
                    this.suppressFlatPredictiveFoot(leg);
                    return;
                }

                if (!plan) {
                    state.debugCandidates[0].valid = false;
                    this.suppressFlatPredictiveFoot(leg);
                    return;
                }

                acceptPredictiveFootCandidate(
                    state,
                    candidate,
                    this.predictiveScratch,
                );
                selectPredictiveDebugCandidate(state, 0);
                plan.terrainDemand = terrainDemand;
                this.updatePredictiveFootTrajectory(
                    leg,
                    footWorld,
                    trajectoryStart,
                    state.trajectoryProgress,
                    plan,
                    demandExit,
                    demandEnter,
                );
                return;
            }

            // 鞋底可站但脚骨目标未通过抬降/腿长约束时，不启用预测线路。
            const planeLift = getPredictivePlaneDistance(ctx, centerSupport);
            state.debugPlaneLift = planeLift;
            state.debugSwingLift = 0;
            this.suppressFlatPredictiveFoot(leg);
        }
    }

    /** 组装预测候选搜索和轨迹规划共用的配置与回调。 */
    private getPredictiveContext(model: Object3D): PredictiveTrajectoryContext {
        return {
            up: this.up,
            appliedScale: this.appliedScale,
            snapEpsilon: this.snapEpsilon,
            sampleRayOriginY: this.sampleRayOriginY,
            maxPredictionCorrection: this.maxPredictionCorrection,
            predictionMinNormalY: this.predictionMinNormalY,
            maxFootRaise: this.maxFootRaise,
            maxFootDrop: this.maxFootDrop,
            pelvisKneeBend: this.pelvisKneeBend,
            footAlignWeight: this.footAlignWeight,
            predictionHorizon: this.predictionHorizon,
            predictionVelocity: this.predictionVelocity,
            scratch: this.predictiveScratch,
            debug: this.debug,
            castGroundFrom: (x, y, z) => this.castGroundFrom(x, y, z),
            castCapsuleGround: () => this.castCapsuleGround(),
            getConstrainedFootAlign: (normal, alignWeight, target) =>
                this.getConstrainedFootAlign(normal, alignWeight, target),
            mergeCoplanarHits: (hits, highest, supportPoint, supportNormal) =>
                this.mergeCoplanarGroundHits(hits, highest, supportPoint, supportNormal),
            getSafeLegReach: (upperLen, lowerLen, kneeBend) =>
                this.getSafeLegReach(upperLen, lowerLen, kneeBend),
            model,
            footPhaseClips: this.footPhaseClips,
            clipName: this.footPhaseState.clipName,
            normalizedTime: this.footPhaseState.normalizedTime,
            swingClearance: this.swingClearance,
            maxPredictionClearance: this.maxPredictionClearance,
        };
    }

    // 地形需求退出阈值后立即交还动画和普通 Foot IK。
    private suppressFlatPredictiveFoot(leg: ReadyFootIKLeg): void {
        const state = leg.predictive;
        state.mode = "tracking";
        state.score = Infinity;
        state.supportObject = null;
        state.trajectoryStartOffset.set(0, 0, 0);
        state.trajectoryCurrentTarget.set(0, 0, 0);
        state.trajectoryStartProgress = state.trajectoryProgress;
        state.trajectoryClearance = 0;
        state.predictionWeight = 0;
        state.usesOffsetLanding = false;
        state.debugTrajectoryVisible = false;
    }

    /** 更新预测线路，并保持重规划首帧的世界空间目标连续。 */
    private updatePredictiveFootTrajectory(
        leg: ReadyFootIKLeg,
        animationFoot: Vector3,
        trajectoryStart: Vector3,
        progress: number,
        plan: PredictiveTrajectoryPlan,
        demandExit: number,
        demandEnter: number,
    ): void {
        const state = leg.predictive;
        const wasActive = state.mode === "active";

        if (!wasActive) {
            state.mode = "active";
            // 记下启用瞬间脚相对动画的偏移，后续按剩余摆腿把这份残差渐隐掉。
            state.trajectoryStartOffset.subVectors(
                trajectoryStart,
                animationFoot,
            );
            state.trajectoryCurrentTarget.copy(trajectoryStart);
            state.trajectoryStartProgress = MathUtils.clamp(progress, 0, 1);
        } else {
            const localProgress = getPredictiveLocalProgress(
                progress,
                state.trajectoryStartProgress,
            );
            const warpAlpha = MathUtils.smoothstep(localProgress, 0, 1);
            const remainingStartWeight = 1 - warpAlpha;
            if (remainingStartWeight > 1e-4) {
                const landingCorrection = this.tmpV1.subVectors(
                    state.landingTarget,
                    state.animatedLanding,
                );
                // 用当前输出反推起点残差，使重规划后这一帧的世界目标不变。
                const resolvedWithoutStart = this.tmpV2
                    .copy(animationFoot)
                    .addScaledVector(landingCorrection, warpAlpha)
                    .addScaledVector(
                        this.up,
                        plan.clearance
                            * getPredictiveClearanceShape(localProgress),
                    );
                state.trajectoryStartOffset
                    .subVectors(
                        state.trajectoryCurrentTarget,
                        resolvedWithoutStart,
                    )
                    .multiplyScalar(1 / remainingStartWeight);
            } else {
                state.trajectoryStartOffset.set(0, 0, 0);
            }
        }

        state.trajectoryClearance = plan.clearance;
        // 需求刚过退出阈值时权重接近 0，接近进入阈值时才满权。
        state.predictionWeight = MathUtils.smoothstep(
            plan.terrainDemand,
            demandExit,
            demandEnter,
        );
        if (this.debug) {
            for (let i = 0; i < state.debugTrajectory.length; i++) {
                state.debugTrajectory[i].copy(plan.points[i]);
            }
        }
        this.rebuildPredictiveDebugTrajectory(leg);
    }

    /** 根据当前融合状态刷新预测摆动轨迹的调试可见性。 */
    private rebuildPredictiveDebugTrajectory(leg: ReadyFootIKLeg): void {
        const state = leg.predictive;
        state.debugTrajectoryVisible = this.debug
            && Number.isFinite(state.score)
            && state.mode === "active"
            && state.predictionWeight > 0.001;
    }

    /** 让动画中心落点持续跟随实际落地帧，并保持当前支撑平面的高度关系。 */
    private followAnimatedLandingTarget(leg: ReadyFootIKLeg): void {
        const state = leg.predictive;
        const previousTarget = this.debug
            ? this.tmpV1.copy(state.landingTarget)
            : null;
        const deltaX = state.animatedLanding.x - state.landingTarget.x;
        const deltaZ = state.animatedLanding.z - state.landingTarget.z;
        state.landingTarget.x = state.animatedLanding.x;
        state.landingTarget.z = state.animatedLanding.z;
        // 水平跟着动画走时，沿支撑平面改 Y，避免脚骨离开已探测的地面。
        if (state.landingNormal.y > 0.18) {
            state.landingTarget.y -= (
                state.landingNormal.x * deltaX
                + state.landingNormal.z * deltaZ
            ) / state.landingNormal.y;
        }

        if (previousTarget) {
            shiftPredictiveDebugTrajectory(
                state.debugTrajectory,
                this.tmpV2.subVectors(state.landingTarget, previousTarget),
            );
        }
    }

    /** 支撑阶段沿用发生水平修正的预测落点，直到下一次摆腿开始。 */
    private resolvePredictivePlantedFoot(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        delta: number,
    ): boolean {
        const state = leg.predictive;
        if (state.mode !== "planted" || !state.usesOffsetLanding) return false;

        refreshPredictiveSupportAnchor(leg, this.predictiveScratch, this.debug);
        leg.smoothedTarget.copy(state.landingTarget);
        // 骨盆使用未裁剪落点，与普通 Foot IK 一样先按可达性下拉/上抬，再限制脚目标。
        leg.hasPelvisTarget = true;
        leg.pelvisTarget.copy(leg.smoothedTarget);
        this.clampPredictiveTargetToReach(leg, leg.smoothedTarget);
        state.trajectoryCurrentTarget.copy(leg.smoothedTarget);
        leg.hitPoint.copy(state.supportPoint);
        leg.hitNormal.copy(state.landingNormal);
        leg.supportPoint.copy(state.supportPoint);
        leg.supportNormal.copy(state.landingNormal);
        leg.movePenetrating = false;
        leg.plantedWeight = MathUtils.damp(
            Math.max(leg.plantedWeight, leg.weight),
            1,
            10,
            delta,
        );
        leg.weight = leg.plantedWeight;
        leg.offsetY = leg.smoothedTarget.y - footWorld.y;
        this.updateFootDebug(leg, state.supportPoint);
        return true;
    }

    // 返回支撑残差在当前摆腿相位中尚未释放的权重。
    private getPredictiveReleaseWeight(state: PredictiveFootState): number {
        if (!state.releaseActive) return 0;
        const localProgress = getPredictiveLocalProgress(
            state.trajectoryProgress,
            state.releaseStartProgress,
        );
        return 1 - MathUtils.smoothstep(
            localProgress,
            0,
            PREDICTION_RELEASE_PROGRESS,
        );
    }

    /** 在新摆腿前段逐渐释放上一支撑落点相对动画脚的残差。 */
    private resolvePredictiveReleaseFoot(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
    ): boolean {
        const state = leg.predictive;
        const releaseWeight = this.getPredictiveReleaseWeight(state);
        if (releaseWeight <= 0.001) {
            state.releaseOffset.set(0, 0, 0);
            state.releaseActive = false;
            return false;
        }

        leg.smoothedTarget
            .copy(footWorld)
            .addScaledVector(state.releaseOffset, releaseWeight);
        leg.hasPelvisTarget = true;
        leg.pelvisTarget.copy(leg.smoothedTarget);
        this.clampPredictiveTargetToReach(leg, leg.smoothedTarget);
        state.trajectoryCurrentTarget.copy(leg.smoothedTarget);
        leg.movePenetrating = false;
        leg.plantedWeight = 0;
        leg.weight = 1;
        leg.offsetY = leg.smoothedTarget.y - footWorld.y;
        this.updateFootDebug(leg, leg.smoothedTarget);
        return true;
    }

    /** 根据地形需求权重统一融合动画轨迹、预测落点和摆动净空。 */
    private resolvePredictiveSwingFoot(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        phase: FootPhaseRuntimeState | undefined,
    ): boolean {
        if (
            !this.predictivePlacement
            || !phase
            || leg.planted
        ) {
            return false;
        }

        const state = leg.predictive;

        if (
            state.mode !== "active"
            || !Number.isFinite(state.score)
            || state.predictionWeight <= 0.001
        ) {
            return false;
        }

        // 移动平台每帧刷新当前预测线路的世界空间落点。
        refreshPredictiveSupportAnchor(leg, this.predictiveScratch, this.debug);

        // 当前预测落点相对动画预计落点的世界空间修正。
        const landingCorrection = this.tmpV1.subVectors(
            state.landingTarget,
            state.animatedLanding,
        );

        // 把启用后的剩余摆腿阶段重新映射到 0 到 1。
        const localProgress = getPredictiveLocalProgress(
            state.trajectoryProgress,
            state.trajectoryStartProgress,
        );

        // 平滑渐隐重规划起点偏移，并渐入落点修正。
        const warpAlpha = MathUtils.smoothstep(localProgress, 0, 1);

        // 保留动画摆腿轨迹，只叠加连续起点、预测落点和地形净空修正。
        leg.smoothedTarget
            .copy(footWorld)
            .addScaledVector(
                state.trajectoryStartOffset,
                1 - warpAlpha,
            )
            .addScaledVector(
                landingCorrection,
                warpAlpha,
            )
            .addScaledVector(
                this.up,
                state.trajectoryClearance
                    * getPredictiveClearanceShape(localProgress),
            );

        // 骨盆使用当前帧轨迹目标，不能传尚未到达的最终落点。
        leg.pelvisTarget.copy(leg.smoothedTarget);

        // 最终仍然尊重腿长和膝盖安全范围。
        this.clampPredictiveTargetToReach(
            leg,
            leg.smoothedTarget,
        );

        state.trajectoryCurrentTarget.copy(
            leg.smoothedTarget,
        );

        // 启用后平滑增加位置 IK 权重，避免接管首帧改变腿部姿态。
        const predictionBlend = MathUtils.smoothstep(
            localProgress,
            0,
            PREDICTION_IK_BLEND_END,
        );
        const predictionIKWeight = state.releaseActive
            ? MathUtils.lerp(1, state.predictionWeight, predictionBlend)
            : state.predictionWeight * predictionBlend;
        if (state.releaseActive && predictionBlend >= 1) {
            state.releaseOffset.set(0, 0, 0);
            state.releaseActive = false;
        }
        if (predictionIKWeight <= 0.001) {
            state.debugTrajectoryVisible = false;
            return false;
        }
        leg.hasPelvisTarget = true;
        leg.movePenetrating = false;
        leg.plantedWeight = 0;
        leg.weight = predictionIKWeight;

        leg.offsetY =
            leg.smoothedTarget.y
            - footWorld.y;

        leg.hitPoint.copy(
            state.supportPoint,
        );

        leg.hitNormal.copy(
            state.landingNormal,
        );

        leg.supportPoint.copy(
            state.supportPoint,
        );

        leg.supportNormal.copy(
            state.landingNormal,
        );

        // 调试继续使用当前预测落点和轨迹。
        this.rebuildPredictiveDebugTrajectory(leg);
        this.updateFootDebug(
            leg,
            state.supportPoint,
        );

        return true;
    }

    /** 把脚的 up 部分旋到地面法线，并施加最大倾角和对齐权重。 */
    private getConstrainedFootAlign(
        normal: Vector3,
        alignWeight: number,
        target: Quaternion,
    ): Quaternion {
        target.setFromUnitVectors(this.up, normal);
        const realAngle = 2 * Math.acos(MathUtils.clamp(target.w, -1, 1));
        if (realAngle > this.maxFootTilt && realAngle > 1e-6) {
            target.slerp(this.identityQ, 1 - this.maxFootTilt / realAngle);
        }
        target.slerp(this.identityQ, 1 - alignWeight);
        return target;
    }

    /** 只合并最高命中所在的近似共面点，避免跨台阶平均出不存在的斜面。 */
    private mergeCoplanarGroundHits(
        hits: Array<FootIKGroundHit | null>,
        highest: FootIKGroundHit,
        supportPoint: Vector3,
        supportNormal: Vector3,
    ): number {
        const planeEpsilon = Math.max(1e-6, 2 * this.appliedScale);
        supportPoint.set(0, 0, 0);
        supportNormal.set(0, 0, 0);
        let supportCount = 0;
        for (const hit of hits) {
            if (!hit) continue;
            const planeDistance = Math.abs(
                highest.normal.dot(this.tmpV5.copy(hit.point).sub(highest.point)),
            );
            if (planeDistance > planeEpsilon || hit.normal.dot(highest.normal) < 0.95) continue;
            supportPoint.add(hit.point);
            supportNormal.add(hit.normal);
            supportCount++;
        }
        if (supportCount > 0) {
            supportPoint.multiplyScalar(1 / supportCount);
            supportNormal.normalize();
        }
        return supportCount;
    }

    /** 按指定膝盖弯曲角反算双骨链的安全伸展距离。 */
    private getSafeLegReach(upperLen: number, lowerLen: number, kneeBend: number): number {
        return Math.sqrt(
            upperLen * upperLen
            + lowerLen * lowerLen
            + 2 * upperLen * lowerLen * Math.cos(kneeBend),
        );
    }

    /** 将预测目标限制在当前髋部的安全可达区间，避免跑步大步幅把膝盖拉到极限。 */
    private clampPredictiveTargetToReach(leg: ReadyFootIKLeg, target: Vector3): void {
        const hip = leg.upper.getWorldPosition(this.tmpV1);
        const knee = leg.lower.getWorldPosition(this.tmpV2);
        const foot = leg.foot.getWorldPosition(this.tmpV3);
        const upperLen = Math.max(0.0001, hip.distanceTo(knee));
        const lowerLen = Math.max(0.0001, knee.distanceTo(foot));
        const safeMaxReach = this.getSafeLegReach(upperLen, lowerLen, this.pelvisKneeBend);
        const safeMinReach = this.getSafeLegReach(upperLen, lowerLen, this.maxKneeBend);
        const hipToTarget = this.tmpV4.subVectors(target, hip);
        const targetDistance = hipToTarget.length();
        if (targetDistance < 1e-6) return;

        const safeDistance = MathUtils.clamp(targetDistance, safeMinReach, safeMaxReach);
        if (Math.abs(safeDistance - targetDistance) <= 1e-6) return;
        target.copy(hip).addScaledVector(hipToTarget, safeDistance / targetDistance);
    }

    // 对一只脚的四个虚拟脚底点分别向下射线，选择命中高度最高的点作为本帧调试/法线参考。
    // 平地浮点抖动时用滞回。
    private castBestFootGround(leg: ReadyFootIKLeg): FootIKGroundHit | null {
        this.updateSoleSamples(leg);

        const samples = leg.soleSamples;
        // 设计尺度约 1 个单位。
        const stickEpsilon = Math.max(1e-6, this.appliedScale);
        const hits = this.sampleGroundHitSlots;

        let maxY = -Infinity;
        let maxIndex = -1;
        let maxHit: FootIKGroundHit | null = null;

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            sample.hasHit = false;
            hits[i] = null;
            const hit = this.castGroundAtSample(sample.point);
            if (!hit) continue;
            sample.hasHit = true;
            sample.hitPoint.copy(hit.point);
            const stored = copyGroundHit(hit, this.sampleGroundHits[i]);
            hits[i] = stored;
            if (stored.point.y > maxY) {
                maxY = stored.point.y;
                maxIndex = i;
                maxHit = stored;
            }
        }

        if (maxIndex < 0 || !maxHit) {
            leg.bestGroundSampleIndex = -1;
            return null;
        }

        let bestIndex = maxIndex;
        let bestHit = maxHit;
        const prev = leg.bestGroundSampleIndex;
        if (prev >= 0 && prev < samples.length) {
            const prevHit = hits[prev];
            if (prevHit && prevHit.point.y >= maxY - stickEpsilon) {
                bestIndex = prev;
                bestHit = prevHit;
            }
        }

        // 只合并最高命中所在的近似共面点，避免跨台阶时生成不存在的中间斜面。
        const supportCount = this.mergeCoplanarGroundHits(
            hits,
            bestHit,
            leg.supportPoint,
            leg.supportNormal,
        );
        if (supportCount <= 0) {
            leg.supportPoint.copy(bestHit.point);
            leg.supportNormal.copy(bestHit.normal);
        }

        leg.bestGroundSampleIndex = bestIndex;
        leg.footSamplePoint.copy(samples[bestIndex].point);
        this.bestGroundHit.point.copy(bestHit.point);
        this.bestGroundHit.normal.copy(leg.supportNormal);
        this.bestGroundHit.object = bestHit.object;
        return this.bestGroundHit;
    }

    // 基于初始化姿态，把脚底四个采样点固定到 foot 骨骼本地空间。
    private initSoleLocalSamples(leg: FootIKLeg): void {
        if (!isReadyLeg(leg)) return;

        const footWorld = leg.foot.getWorldPosition(this.tmpV1);
        const toeWorld = leg.toe
            ? leg.toe.getWorldPosition(this.tmpV2)
            : this.tmpV2.copy(footWorld).add(this.tmpV3.set(0, 0, 1).applyQuaternion(leg.foot.getWorldQuaternion(this.tmpQ1)).setY(0).normalize().multiplyScalar(this.fakeToeExtend));

        const forward = this.tmpV3.copy(toeWorld).sub(footWorld).setY(0);
        const minFwdSq = Math.max(1e-8, 1e-4 * this.appliedScale * this.appliedScale);
        if (forward.lengthSq() < minFwdSq) {
            forward.set(0, 0, 1).applyQuaternion(leg.foot.getWorldQuaternion(this.tmpQ1)).setY(0);
        }
        forward.normalize();

        const side = this.tmpV4.crossVectors(forward, this.up).normalize();
        const heelCenter = this.tmpV5.copy(footWorld).addScaledVector(forward, -this.soleHeelExtend);
        const toeCenter = this.tmpV2.copy(toeWorld).addScaledVector(forward, this.soleToeExtend);

        heelCenter.y = toeCenter.y;

        leg.foot.updateMatrixWorld(true);
        const samples = leg.soleSamples;
        samples[0].point.copy(heelCenter).addScaledVector(side, this.soleHalfWidth);
        samples[1].point.copy(heelCenter).addScaledVector(side, -this.soleHalfWidth);
        samples[2].point.copy(toeCenter).addScaledVector(side, this.soleHalfWidth);
        samples[3].point.copy(toeCenter).addScaledVector(side, -this.soleHalfWidth);

        // 把脚骨→鞋底厚度打进 foot-local，之后随骨骼世界缩放。
        for (const sample of samples) {
            sample.point.y -= this.soleSkinThickness;
            sample.local.copy(sample.point);
            leg.foot.worldToLocal(sample.local);
        }
        leg.footSamplePoint.copy(heelCenter);
    }

    // 把 foot-local 脚底四点转换到世界空间，供射线、穿透检测和调试使用。
    private updateSoleSamples(leg: FootIKLeg): void {
        if (!isReadyLeg(leg)) return;

        leg.foot.updateMatrixWorld(true);
        const samples = leg.soleSamples;
        for (const sample of samples) {
            sample.point.copy(sample.local).applyMatrix4(leg.foot.matrixWorld);
        }

        if (samples.length >= 2) {
            leg.footSamplePoint.copy(samples[0].point).add(samples[1].point).multiplyScalar(0.5);
        }
    }

    // 四个脚底采样点中取最高地面相对脚底的垂直偏移。
    private getFootGroundOffset(leg: ReadyFootIKLeg): number {
        let offset = -Infinity;
        for (const sample of leg.soleSamples) {
            if (!sample.hasHit) continue;
            offset = Math.max(offset, sample.hitPoint.y - sample.point.y);
        }

        return Number.isFinite(offset) ? offset : 0;
    }

    // 先把脚掌旋到支撑面方向，再计算四个脚底点同时不穿透时所需的踝骨垂直偏移。
    private getAlignedFootTargetOffset(leg: ReadyFootIKLeg, footWorld: Vector3): number {
        const supportNormal = leg.supportNormal;
        if (supportNormal.y <= 0.18) return this.getFootGroundOffset(leg);

        const footWorldQ = leg.foot.getWorldQuaternion(this.tmpQ1);
        const alignQ = this.getConstrainedFootAlign(
            supportNormal,
            this.footAlignWeight,
            this.tmpQ2,
        );
        const targetWorldQ = alignQ.multiply(footWorldQ);
        const worldScale = leg.foot.getWorldScale(this.tmpV4);

        let targetOffset = -Infinity;
        for (const sample of leg.soleSamples) {
            const alignedPoint = this.tmpV5
                .copy(sample.local)
                .multiply(worldScale)
                .applyQuaternion(targetWorldQ)
                .add(footWorld);
            const planeOffset = supportNormal.dot(
                this.tmpV3.copy(leg.supportPoint).sub(alignedPoint),
            ) / supportNormal.y;
            targetOffset = Math.max(targetOffset, planeOffset);
        }

        return Number.isFinite(targetOffset) ? targetOffset : this.getFootGroundOffset(leg);
    }

    // 判断当前动画是否属于移动类动画。
    private isLocomotion(): boolean {
        const name = this.player?.animation.state?.getClip().name ?? "";
        return this.isLocomotionClipName(name);
    }

    // 统一判断脚步相位采样和运行时移动状态：直接使用 playerModelConfig 中的移动动画名。
    private isLocomotionClipName(name: string): boolean {
        if (!name) return false;
        const config = this.player?.playerModelConfig;
        if (!config) return false;
        return [
            config.walkAnim,
            config.runAnim,
            config.leftWalkAnim,
            config.rightWalkAnim,
            config.backwardAnim,
        ].filter((value): value is string => !!value).includes(name);
    }

    // 从骨骼采样点上方发射射线。
    private castGroundAtSample(sampleWorld: Vector3): FootIKGroundHit | null {
        return this.castGroundFrom(sampleWorld.x, sampleWorld.y + this.sampleRayOriginY, sampleWorld.z);
    }

    // 读取本帧碰撞网格，供后续脚底射线共用。
    private refreshColliderMeshes(): void {
        this.colliderMeshes = this.player?.getColliderMeshes() ?? this.colliderMeshes;
    }

    // 优先读取移动系统最终采用的支撑。
    private castCapsuleGround(): FootIKGroundHit | null {
        const capsule = this.player?.playerCapsule;
        if (!capsule) return null;

        const activeBody = this.player?.getActiveDynamicBody?.();
        const ignoreSupport = activeBody?.kind === "sphere";

        const getGroundSupport = this.player?.getGroundSupport;
        if (getGroundSupport && !ignoreSupport) {
            const support = getGroundSupport.call(this.player);
            if (!support) return null;
            this.capsuleHit.point.copy(support.point);
            this.capsuleHit.normal.copy(support.normal);
            this.capsuleHit.object = undefined;
            return this.capsuleHit;
        }

        const hit = this.castGroundFrom(
            capsule.position.x,
            capsule.position.y,
            capsule.position.z,
        );
        return hit ? copyGroundHit(hit, this.capsuleHit) : null;
    }

    // 从指定世界坐标向下检测可踩踏地面，结果写入复用命中对象。
    private castGroundFrom(x: number, y: number, z: number): FootIKGroundHit | null {
        this.raycaster.ray.origin.set(x, y, z);
        const hits = this.raycaster.intersectObjects(this.colliderMeshes, false);
        let foundMesh = false;
        for (let i = 0; i < hits.length; i++) {
            const meshHit = hits[i];
            if (this.getMeshWorldHitNormal(meshHit, this.groundHit.normal).y <= 0.18) continue;
            this.groundHit.point.copy(meshHit.point);
            this.groundHit.object = meshHit.object;
            foundMesh = true;
            break;
        }

        const dynamicHit = this.player?.raycastDynamicGround?.(
            this.raycaster.ray.origin,
            0.18,
            FOOT_IK_IGNORED_DYNAMIC_KINDS,
        );
        if (!dynamicHit) return foundMesh ? this.groundHit : null;
        const distance = y - dynamicHit.point.y;
        if (distance < this.raycaster.near || distance > this.raycaster.far) {
            return foundMesh ? this.groundHit : null;
        }
        if (foundMesh && this.groundHit.point.y >= dynamicHit.point.y) return this.groundHit;
        this.groundHit.point.copy(dynamicHit.point);
        this.groundHit.normal.copy(dynamicHit.normal);
        this.groundHit.object = dynamicHit.body?.mesh;
        return this.groundHit;
    }

    // 将 mesh 射线命中的局部法线转换为世界空间法线。
    private getMeshWorldHitNormal(hit: Intersection<Object3D>, target: Vector3): Vector3 {
        target.copy(hit.face?.normal ?? this.up);
        this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        target.applyMatrix3(this.normalMatrix).normalize();
        return target;
    }

    // 根据双脚高台面和脚目标可达性对骨盆做平滑补偿。
    private applyPelvis(delta: number): void {
        if (!this.hips) return;

        // 双脚同处高台面时优先上抬；其余情况只补偿超出腿长的下沉距离。
        const raiseOffset = this.getRequiredPelvisRaise();
        const leftDrop = isReadyLeg(this.legs.left)
            ? this.getRequiredPelvisDrop(this.legs.left)
            : 0;
        const rightDrop = isReadyLeg(this.legs.right)
            ? this.getRequiredPelvisDrop(this.legs.right)
            : 0;
        const reachOffset = MathUtils.clamp(
            Math.min(leftDrop, rightDrop, 0),
            -this.maxPelvisDrop,
            0,
        );
        const wantedWorldOffset = raiseOffset > 0
            ? raiseOffset
            : Math.max(reachOffset, this.getSupportLimitedPelvisDrop());

        this.pelvisOffset = MathUtils.damp(this.pelvisOffset, wantedWorldOffset, 12, delta);
        if (Math.abs(this.pelvisOffset) < this.snapEpsilon) return;

        const parent = this.hips.parent;
        if (!parent) return;

        this.capture(this.hips);
        // 骨盆父级可能带有轴向旋转，先在世界 Y 轴生成目标，再转换回父级局部坐标。
        const targetWorld = this.hips
            .getWorldPosition(this.tmpV1)
            .addScaledVector(this.up, this.pelvisOffset);
        parent.worldToLocal(targetWorld);
        this.hips.position.copy(targetWorld);
        this.hips.updateMatrixWorld(true);
    }

    // 双脚都稳定应用 IK 且落在同一近水平高台面时，按胶囊支撑高度差上抬骨盆。
    private getRequiredPelvisRaise(): number {
        const left = this.legs.left;
        const right = this.legs.right;
        if (!isReadyLeg(left) || !isReadyLeg(right)) return 0;
        if (!left.hasPelvisTarget || !right.hasPelvisTarget) return 0;
        if (
            left.weight < this.pelvisRaiseWeightThreshold
            || right.weight < this.pelvisRaiseWeightThreshold
        ) return 0;
        if (
            left.supportNormal.y < this.pelvisRaiseMinNormalY
            || right.supportNormal.y < this.pelvisRaiseMinNormalY
        ) return 0;

        const leftSupportY = this.getLegSupportY(left);
        const rightSupportY = this.getLegSupportY(right);
        if (!Number.isFinite(leftSupportY) || !Number.isFinite(rightSupportY)) return 0;
        if (Math.abs(leftSupportY - rightSupportY) > this.pelvisRaiseCoplanarThreshold) return 0;

        const capsuleHit = this.castCapsuleGround();
        if (!capsuleHit) return 0;
        const heightDelta = Math.min(leftSupportY, rightSupportY) - capsuleHit.point.y;
        if (heightDelta <= this.pelvisRaiseEpsilon) return 0;
        return MathUtils.clamp(heightDelta, 0, this.maxPelvisRaise);
    }

    // 计算脚骨骼水平位置在当前支撑平面上对应的高度。
    private getLegSupportY(leg: ReadyFootIKLeg): number {
        if (leg.supportNormal.y <= 0.18) return NaN;
        const footWorld = leg.foot.getWorldPosition(this.tmpV1);
        return leg.supportPoint.y - (
            leg.supportNormal.x * (footWorld.x - leg.supportPoint.x)
            + leg.supportNormal.z * (footWorld.z - leg.supportPoint.z)
        ) / leg.supportNormal.y;
    }

    // 脚下支撑面只限制骨盆最多下沉到哪里，不直接推动骨盆，避免中心射线命中错误表面时抬动模型。
    private getSupportLimitedPelvisDrop(): number {
        const capsuleHit = this.castCapsuleGround();
        if (!capsuleHit) return -this.maxPelvisDrop;

        let lowestSupportDelta = 0;
        let hasSupport = false;
        for (const leg of Object.values(this.legs)) {
            if (!isReadyLeg(leg) || !leg.hasPelvisTarget) continue;
            const supportY = this.getLegSupportY(leg);
            if (!Number.isFinite(supportY)) continue;
            lowestSupportDelta = Math.min(
                lowestSupportDelta,
                supportY - capsuleHit.point.y,
            );
            hasSupport = true;
        }

        return hasSupport
            ? MathUtils.clamp(lowestSupportDelta, -this.maxPelvisDrop, 0)
            : -this.maxPelvisDrop;
    }

    // 按双骨骼 IK 的最大伸展距离，反算脚目标进入可达范围所需的最小骨盆下沉量。
    private getRequiredPelvisDrop(leg: ReadyFootIKLeg): number {
        if (!leg.hasPelvisTarget) return 0;

        const hip = leg.upper.getWorldPosition(this.tmpV1);
        const knee = leg.lower.getWorldPosition(this.tmpV2);
        const foot = leg.foot.getWorldPosition(this.tmpV3);
        const upperLen = Math.max(0.0001, hip.distanceTo(knee));
        const lowerLen = Math.max(0.0001, knee.distanceTo(foot));
        const maxReach = this.getSafeLegReach(upperLen, lowerLen, this.pelvisKneeBend);

        const deltaX = leg.pelvisTarget.x - hip.x;
        const deltaY = leg.pelvisTarget.y - hip.y;
        const deltaZ = leg.pelvisTarget.z - hip.z;
        const horizontalSq = deltaX * deltaX + deltaZ * deltaZ;
        const maxReachSq = maxReach * maxReach;
        if (horizontalSq + deltaY * deltaY <= maxReachSq || deltaY >= 0) return 0;

        // 水平距离已经超出腿长时，垂直下沉无法完全满足目标；仍下沉到与目标同高的位置以取得最短距离。
        if (horizontalSq >= maxReachSq) return deltaY;

        const verticalReach = Math.sqrt(maxReachSq - horizontalSq);
        return Math.min(0, deltaY + verticalReach);
    }

    /** 在预测摆腿末段逐渐把脚掌旋转到落点支撑面。 */
    private preAlignPredictiveLandingRotation(
        leg: ReadyFootIKLeg,
        phase: FootPhaseRuntimeState | undefined,
    ): void {
        if (!phase) return;

        const state = leg.predictive;

        if (
            state.mode !== "active"
            || leg.planted
            || state.landingNormal.y <= 0.18
        ) {
            return;
        }

        const localProgress = getPredictiveLocalProgress(
            state.trajectoryProgress,
            state.trajectoryStartProgress,
        );

        // 启用后先保留动画旋转，进入末段后再逐渐贴合坡面。
        const rotationWeight = MathUtils.smoothstep(
            localProgress,
            PREDICTION_ROTATION_WARP_START,
            1,
        ) * state.predictionWeight;

        if (rotationWeight <= 0.001) return;

        this.getConstrainedFootAlign(
            state.landingNormal,
            this.footAlignWeight,
            this.tmpQ2,
        );
        const targetWorldQ = this.tmpQ3
            .copy(this.tmpQ2)
            .multiply(state.animatedLandingRotation);

        // 从当前动画旋转平滑过渡到预测落脚旋转。
        const currentWorldQ =
            leg.foot.getWorldQuaternion(
                this.tmpQ1,
            );

        currentWorldQ.slerp(
            targetWorldQ,
            rotationWeight,
        );

        const parent = leg.foot.parent;
        if (!parent) return;

        const parentWorldQ =
            parent.getWorldQuaternion(
                this.tmpQ4,
            );

        this.capture(leg.foot);

        leg.foot.quaternion.copy(
            parentWorldQ
                .invert()
                .multiply(currentWorldQ),
        );

        leg.foot.updateMatrixWorld(true);
    }

    // 对指定腿执行 IK 求解并贴合脚掌。
    private applyLeg(side: FootIKSide, useStraightPole: boolean): void {
        const leg = this.legs[side];
        if (!isReadyLeg(leg) || leg.weight <= 0.001) return;

        // 保存动画给出的 foot 世界旋转，普通 IK 解腿后按权重恢复该旋转。
        this.savedFootWorldQ.copy(leg.foot.getWorldQuaternion(this.tmpQ1));

        const predictiveSwing = this.predictivePlacement
            && !leg.planted
            && leg.predictive.mode === "active";
        if (predictiveSwing) {
            // 骨盆修正后再检查一次可达范围，并沿用动画膝盖 pole 处理跑步和转向姿态。
            this.clampPredictiveTargetToReach(leg, leg.smoothedTarget);
            leg.predictive.trajectoryCurrentTarget.copy(leg.smoothedTarget);
        }

        // 腿部位置修正完成后恢复动画脚掌旋转，避免位置 IK 改变脚尖朝向。
        this.solveLeg(
            leg,
            leg.smoothedTarget,
            leg.weight,
            useStraightPole && !predictiveSwing,
        );
        this.preserveFootWorldRotation(leg, this.savedFootWorldQ, leg.weight);
        // 预测摆动脚在接近落地时才逐渐旋到支撑面。
        if (predictiveSwing) {
            this.preAlignPredictiveLandingRotation(
                leg,
                this.footPhaseState?.[side],
            );
        }
        // 支撑脚离地后按剩余相位权重逐渐释放坡面旋转。
        // 普通摆动脚只在防穿透时贴合坡面，预测线路不额外接管脚掌旋转。
        if (
            leg.planted
            || leg.movePenetrating
            || leg.plantedWeight > 0.001
        ) {
            this.alignFootToGround(leg);
        }
        if (leg.planted) {
            this.correctPostAlignSoleContact(leg, useStraightPole);
        }
    }

    // 抵消腿部 IK 对 foot 子骨骼造成的被动旋转，保留动画本来的脚掌朝向。
    private preserveFootWorldRotation(
        leg: ReadyFootIKLeg,
        animatedWorldQ: Quaternion,
        weight: number,
    ): void {
        this.capture(leg.foot);

        const currentWorldQ = leg.foot.getWorldQuaternion(this.tmpQ1);
        currentWorldQ.slerp(animatedWorldQ, MathUtils.clamp(weight, 0, 1));

        const parentWorldQ = leg.foot.parent?.getWorldQuaternion(this.tmpQ2);
        if (!parentWorldQ) return;
        leg.foot.quaternion.copy(parentWorldQ.invert().multiply(currentWorldQ));
        leg.foot.updateMatrixWorld(true);
    }

    // 使用受约束的双骨骼 IK，让脚靠近目标点。
    private solveLeg(
        leg: ReadyFootIKLeg,
        target: Vector3,
        weight: number,
        useStraightPole = false,
    ): void {
        let kneePlaneNormal: Vector3 | undefined;
        if (useStraightPole) {
            // 移动时用胶囊局部 +X 作为角色前后平面的法线。
            // 静止时不传此约束，让 IK 保留 idle 动画本身的膝盖 pole。
            const capsule = this.player?.playerCapsule;
            if (!capsule) return;
            kneePlaneNormal = this.tmpV4
                .set(1, 0, 0)
                .applyQuaternion(capsule.getWorldQuaternion(this.tmpQ3))
                .normalize();
        }

        solveTwoBoneIK(leg, target, weight, {
            capture: bone => this.capture(bone),
            minKneeBend: this.minKneeBend,
            maxKneeBend: this.maxKneeBend,
            kneePlaneNormal,
            scratch: this.twoBoneIKScratch,
        });
    }

    // 脚掌贴坡会绕 foot 骨骼旋转，旋转后重新校正脚底接触。
    private correctPostAlignSoleContact(
        leg: ReadyFootIKLeg,
        useStraightPole: boolean,
    ): void {
        if (leg.weight <= 0.001) return;

        const footWorld = leg.foot.getWorldPosition(this.tmpV1);
        this.updateSoleSamples(leg);

        let contactOffset = -Infinity;
        let anyContactHit = false;
        for (const sample of leg.soleSamples) {
            sample.hasHit = false;
            const hit = this.castGroundAtSample(sample.point);
            if (!hit) continue;

            sample.hasHit = true;
            sample.hitPoint.copy(hit.point);
            const sampleOffset = hit.point.y - sample.point.y;
            // 摆动脚只做防穿透上抬，不向下吸附。
            if (!leg.planted && sampleOffset < 0) continue;
            // 超出脚部 IK 范围的点不参与二次接触校正。
            if (leg.planted && sampleOffset < -this.maxFootDrop) continue;
            if (sampleOffset > this.maxFootRaise) continue;

            anyContactHit = true;
            contactOffset = Math.max(contactOffset, sampleOffset);
        }

        if (!anyContactHit) return;
        if (leg.planted && contactOffset < -this.maxFootDrop) return;
        if (contactOffset > this.maxFootRaise) return;
        contactOffset = leg.planted
            ? contactOffset
            : MathUtils.clamp(contactOffset, 0, this.maxFootRaise);
        if (Math.abs(contactOffset) <= this.snapEpsilon) return;
        // 站住时较大的剩余高度交给下一帧的时间阻尼。
        if (
            leg.planted
            && Math.abs(contactOffset) > Math.max(this.snapEpsilon, 4 * this.appliedScale)
        ) {
            return;
        }

        this.savedAlignedFootWorldQ.copy(leg.foot.getWorldQuaternion(this.tmpQ1));
        const correctedTarget = this.tmpV2.copy(footWorld).addScaledVector(this.up, contactOffset);

        this.solveLeg(leg, correctedTarget, leg.weight, useStraightPole);
        this.preserveFootWorldRotation(leg, this.savedAlignedFootWorldQ, 1);
    }

    // 根据地面法线轻微调整脚掌朝向。
    private alignFootToGround(leg: ReadyFootIKLeg): void {
        // 脚掌贴坡：把脚的 up 方向部分旋到地面法线。
        // 用最大角度限制避免台阶边缘的法线让脚踝扭得过夸张。
        if (leg.hitNormal.y < 0.35 || leg.weight <= 0.001) return;
        this.capture(leg.foot);

        const footWorldQ = leg.foot.getWorldQuaternion(this.tmpQ1);
        const alignQ = this.getConstrainedFootAlign(
            leg.hitNormal,
            leg.weight * this.footAlignWeight,
            this.tmpQ2,
        );

        const targetWorldQ = alignQ.multiply(footWorldQ);
        const parentWorldQ = leg.foot.parent?.getWorldQuaternion(this.tmpQ3);
        if (!parentWorldQ) return;
        leg.foot.quaternion.copy(parentWorldQ.invert().multiply(targetWorldQ));
        leg.foot.updateMatrixWorld(true);
    }

    // 保存骨骼原始姿态，便于下一帧恢复。
    private capture(bone: Object3D): void {
        // 第一次修改骨骼前保存原姿态，下一帧 restore 会用它恢复。
        if (this.adjusted.has(bone)) return;
        let pose = this.poseCache.get(bone);
        if (!pose) {
            pose = {
                position: new Vector3(),
                quaternion: new Quaternion(),
            };
            this.poseCache.set(bone, pose);
        }
        pose.position.copy(bone.position);
        pose.quaternion.copy(bone.quaternion);
        this.adjusted.add(bone);
    }

    // 创建统一调试对象：IK 目标、最高命中、脚底四点。
    private createDebugObjects(): void {
        createDebugObjects(this.player?.scene ?? null, this.legs, this.debug);
    }

    // 更新单脚调试标记（含脚底四点和最大上抬范围）；超出范围的线框命中球标红。
    private updateFootDebug(leg: FootIKLeg, hitPoint: Vector3): void {
        updateFootDebug(
            this.debug,
            leg,
            hitPoint,
            this.appliedScale,
            this.maxFootRaise,
        );
    }

    // 统一切换全部 Foot IK 调试对象的显示状态。
    private setDebugVisible(visible: boolean): void {
        setDebugVisible(this.legs, visible);
    }

    /** 控制 Foot IK 调试对象显隐（IK 目标、最高命中、脚底四点）。 */
    setDebugEnabled(enabled: boolean): void {
        if (this.disposed) return;
        this.debug = enabled;
        if (enabled) {
            this.createDebugObjects();
        }
        this.setDebugVisible(enabled);
    }

    /** 读取当前可调配置（不含 skeleton）。距离类参数返回 scale=1 基准值。 */
    getOptions(): Required<Omit<FootIKOptions, "skeleton">> {
        return {
            enabled: this.enabled,
            debug: this.debug,
            maxPelvisDrop: this.toBaseDistance(this.maxPelvisDrop),
            maxPelvisRaise: this.toBaseDistance(this.maxPelvisRaise),
            maxFootRaise: this.toBaseDistance(this.maxFootRaise),
            maxFootDrop: this.toBaseDistance(this.maxFootDrop),
            soleHalfWidth: this.toBaseDistance(this.soleHalfWidth),
            soleToeExtend: this.toBaseDistance(this.soleToeExtend),
            soleHeelExtend: this.toBaseDistance(this.soleHeelExtend),
            soleSkinThickness: this.toBaseDistance(this.soleSkinThickness),
            footAlignWeight: this.footAlignWeight,
            maxFootTilt: this.maxFootTilt,
            minKneeBend: this.minKneeBend,
            maxKneeBend: this.maxKneeBend,
            pelvisKneeBend: this.pelvisKneeBend,
            moveLiftThreshold: this.toBaseDistance(this.moveLiftThreshold),
            footPhaseSampleCount: this.footPhaseOptions.sampleCount,
            footPhaseGroundThreshold: this.toBaseDistance(this.footPhaseGroundThreshold),
            footPhaseMinContactRatio: this.footPhaseOptions.minContactRatio,
            footPhaseSpeedSlack: this.footPhaseOptions.speedSlack,
            predictivePlacement: this.predictivePlacement,
            predictionHorizon: this.predictionHorizon,
            predictionProbeInterval: this.predictionProbeInterval,
            predictionSearchRadius: this.toBaseDistance(this.predictionSearchRadius),
            maxPredictionCorrection: this.toBaseDistance(this.maxPredictionCorrection),
            predictionMinNormalY: this.predictionMinNormalY,
            swingClearance: this.toBaseDistance(this.swingClearance),
            maxPredictionClearance: this.toBaseDistance(this.maxPredictionClearance),
        };
    }

    /**
     * 运行时更新部分配置。
     * 距离类参数传入 scale=1 基准值，内部会乘以当前 playerModelConfig.scale。
     * sole 尺寸变化会重建本地采样点，脚步相位相关参数变化会重建相位库。
     */
    configure(options: Partial<FootIKOptions>): void {
        if (this.disposed) return;

        if (options.enabled !== undefined) this.setEnabled(options.enabled);
        if (options.debug !== undefined) this.setDebugEnabled(options.debug);
        if (
            options.predictivePlacement !== undefined
            && options.predictivePlacement !== this.predictivePlacement
        ) {
            this.predictivePlacement = options.predictivePlacement;
            this.resetPredictionRuntime();
        }

        let soleDirty = false;
        let phaseDirty = false;

        if (options.maxPelvisDrop !== undefined) {
            this.maxPelvisDrop = this.scaleDistance(options.maxPelvisDrop);
        }
        if (options.maxPelvisRaise !== undefined) {
            this.maxPelvisRaise = this.scaleDistance(options.maxPelvisRaise);
        }
        if (options.maxFootRaise !== undefined) {
            this.maxFootRaise = this.scaleDistance(options.maxFootRaise);
        }
        if (options.maxFootDrop !== undefined) {
            this.maxFootDrop = this.scaleDistance(options.maxFootDrop);
        }
        if (options.soleHalfWidth !== undefined) {
            this.soleHalfWidth = this.scaleDistance(options.soleHalfWidth);
            soleDirty = true;
        }
        if (options.soleToeExtend !== undefined) {
            this.soleToeExtend = this.scaleDistance(options.soleToeExtend);
            soleDirty = true;
        }
        if (options.soleHeelExtend !== undefined) {
            this.soleHeelExtend = this.scaleDistance(options.soleHeelExtend);
            soleDirty = true;
        }
        if (options.soleSkinThickness !== undefined) {
            this.soleSkinThickness = this.scaleDistance(options.soleSkinThickness);
            soleDirty = true;
        }
        if (options.footAlignWeight !== undefined) {
            this.footAlignWeight = MathUtils.clamp(options.footAlignWeight, 0, 1);
        }
        if (options.maxFootTilt !== undefined) {
            this.maxFootTilt = MathUtils.clamp(options.maxFootTilt, 0, Math.PI);
        }
        if (options.minKneeBend !== undefined || options.maxKneeBend !== undefined) {
            const minBend = MathUtils.clamp(options.minKneeBend ?? this.minKneeBend, 0, Math.PI);
            const maxBend = MathUtils.clamp(options.maxKneeBend ?? this.maxKneeBend, 0, Math.PI);
            this.minKneeBend = Math.min(minBend, maxBend);
            this.maxKneeBend = Math.max(minBend, maxBend);
            this.pelvisKneeBend = MathUtils.clamp(
                this.pelvisKneeBend,
                this.minKneeBend,
                this.maxKneeBend,
            );
        }
        if (options.pelvisKneeBend !== undefined) {
            this.pelvisKneeBend = MathUtils.clamp(
                options.pelvisKneeBend,
                this.minKneeBend,
                this.maxKneeBend,
            );
        }
        if (options.moveLiftThreshold !== undefined) {
            this.moveLiftThreshold = this.scaleDistance(options.moveLiftThreshold);
        }
        if (options.predictionHorizon !== undefined) {
            this.predictionHorizon = Math.max(0, options.predictionHorizon);
        }
        if (options.predictionProbeInterval !== undefined) {
            this.predictionProbeInterval = Math.max(0, options.predictionProbeInterval);
        }
        if (options.predictionSearchRadius !== undefined) {
            this.predictionSearchRadius = this.scaleDistance(options.predictionSearchRadius);
        }
        if (options.maxPredictionCorrection !== undefined) {
            this.maxPredictionCorrection = this.scaleDistance(options.maxPredictionCorrection);
        }
        if (options.predictionMinNormalY !== undefined) {
            this.predictionMinNormalY = MathUtils.clamp(options.predictionMinNormalY, 0, 1);
        }
        if (options.swingClearance !== undefined) {
            this.swingClearance = this.scaleDistance(options.swingClearance);
        }
        if (options.maxPredictionClearance !== undefined) {
            this.maxPredictionClearance = this.scaleDistance(options.maxPredictionClearance);
        }
        if (options.footPhaseGroundThreshold !== undefined) {
            this.footPhaseGroundThreshold = this.scaleDistance(options.footPhaseGroundThreshold);
            this.footPhaseOptions.groundThreshold = this.footPhaseGroundThreshold;
            phaseDirty = true;
        }

        if (
            options.footPhaseSampleCount !== undefined
            || options.footPhaseMinContactRatio !== undefined
            || options.footPhaseSpeedSlack !== undefined
        ) {
            this.footPhaseOptions = createFootPhaseOptions({
                footPhaseSampleCount: options.footPhaseSampleCount ?? this.footPhaseOptions.sampleCount,
                footPhaseGroundThreshold: this.footPhaseGroundThreshold,
                footPhaseMinContactRatio: options.footPhaseMinContactRatio ?? this.footPhaseOptions.minContactRatio,
                footPhaseSpeedSlack: options.footPhaseSpeedSlack ?? this.footPhaseOptions.speedSlack,
            });
            phaseDirty = true;
        }

        if (soleDirty) {
            this.initSoleLocalSamples(this.legs.left);
            this.initSoleLocalSamples(this.legs.right);
        }
        if (phaseDirty) {
            this.buildFootPhaseDatabase();
        }
    }

    /** 返回指定脚当前动画相位的调试文本。 */
    getFootPhaseDebugText(side: FootIKSide): string {
        return getFootPhaseDebugText(this.footPhaseState, this.footPhaseClips, side);
    }

    /** 返回指定脚当前的最终 IK 权重。 */
    getFootIKWeight(side: FootIKSide): number {
        return this.legs[side].weight;
    }

    /** 返回指定脚距离下一次落地的时间（秒）；无相位数据时为 Infinity。 */
    getFootTimeToLand(side: FootIKSide): number {
        return this.footPhaseState[side].timeToLand;
    }

    /** 返回指定脚的预测落脚调试状态；预测关闭时返回 disabled。 */
    getPredictiveFootDebugText(side: FootIKSide): string {
        if (!this.predictivePlacement) return "disabled";
        const state = this.legs[side].predictive;
        // d 为落点相对胶囊支撑面的上台高度，swing 为摆腿路径上的最大凸起。
        const demand = `d=${state.debugPlaneLift.toFixed(3)} swing=${state.debugSwingLift.toFixed(3)}`;
        if (!Number.isFinite(state.score)) return `${state.mode} ${demand}`;
        return `${state.mode} ${demand} score=${state.score.toFixed(2)}`;
    }

}
