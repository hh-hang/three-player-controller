import {
    Matrix3,
    MathUtils,
    Quaternion,
    Raycaster,
    Vector3,
    type Bone,
    type Intersection,
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
    resetPredictiveFootState,
    samplePredictiveTrajectory,
} from "./internal/predictivePlacement";
import type {
    FootIKBonePose,
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
    ReadyFootIKLeg,
} from "./types";
import type { TwoBoneIKScratch } from "./internal/twoBoneIK";

// 脚底查询统一使用世界空间命中点和法线。
type FootIKGroundHit = {
    point: Vector3;
    normal: Vector3;
    object?: Object3D;
};

// 预测候选保留脚骨目标、实际支撑面和评分，用于生成本次摆动线路。
type PredictiveFootCandidate = {
    target: Vector3;
    point: Vector3;
    normal: Vector3;
    object: Object3D | null;
    score: number;
    debugIndex: number;
};

/** Foot IK 不参与地面检测的动态刚体形状。 */
const FOOT_IK_IGNORED_DYNAMIC_KINDS = ["sphere"] as const;
/** 水平步幅转换为额外摆动净空的比例。 */
const PREDICTION_STRIDE_CLEARANCE_SCALE = 0.15;
/** 已提交线路允许角色继续转向的最大角度，超过后从当前目标连续重规划。 */
const PREDICTION_TURN_REPLAN_COS = Math.cos(MathUtils.degToRad(25));

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
    // 预测落脚开关与搜索、提交和摆动修正配置。
    private predictivePlacement: boolean;
    private predictionHorizon: number;
    private predictionProbeInterval: number;
    private predictionSearchRadius = 20;
    private maxPredictionCorrection = 45;
    private predictionMinNormalY: number;
    private predictionMinSupportSamples: number;
    private swingClearance = 8;
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

        // 预测落脚默认关闭，确保未显式开启时不改变既有 Foot IK 行为。
        this.predictivePlacement = options.predictivePlacement ?? false;
        this.predictionHorizon = Math.max(0, options.predictionHorizon ?? 0.45);
        this.predictionProbeInterval = Math.max(0, options.predictionProbeInterval ?? 0.05);
        this.predictionMinNormalY = MathUtils.clamp(options.predictionMinNormalY ?? 0.55, 0, 1);
        this.predictionMinSupportSamples = MathUtils.clamp(
            Math.round(options.predictionMinSupportSamples ?? 3),
            1,
            4,
        );
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

        // 不在地面、飞行或载具模式时不做腿部贴地
        if (
            (!this.player?.getColliderMeshes().length && !this.player?.getDynamicBodies?.().length)
            || !this.player.playerCapsule
            || !this.player.playerIsOnGround
            || this.player.isFlying
            || this.player.getControllerMode?.() === 1
        ) {
            if (this.predictivePlacement) {
                resetPredictiveFootState(this.legs.left.predictive);
                resetPredictiveFootState(this.legs.right.predictive);
            }
            this.setDebugVisible(false);
            return;
        }

        const model = this.player.playerModel;
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

        // 已生成线路的摆动脚直接逐帧执行预测目标，不再进入原有防穿透分支。
        if (!leg.planted && this.applyPredictiveSwingFoot(leg, footWorld, phase)) return;

        const hit = this.castBestFootGround(leg);

        // 脚底没有命中地面时，本帧完全交还给原动画。
        if (!hit) {
            if (!leg.planted) {
                this.releaseSwingFoot(
                    leg,
                    footWorld,
                    startedSwing || wasMovePenetrating,
                    previousWeight,
                    delta,
                );
                this.updateFootDebug(leg, footWorld);
                return;
            }
            leg.plantedWeight = 0;
            leg.movePenetrating = false;
            leg.weight = 0;
            leg.offsetY = 0;
            this.updateFootDebug(leg, footWorld);
            return;
        }

        leg.hitNormal.copy(hit.normal);
        leg.hitPoint.copy(hit.point);

        const groundOffset = this.getFootGroundOffset(leg);
        const liftAmount = Math.max(0, groundOffset);
        const pelvisTargetOffset = this.getAlignedFootTargetOffset(leg, footWorld);
        // 支撑脚下探超过最大范围时，本帧交还给原动画。
        if (leg.planted && pelvisTargetOffset < -this.maxFootDrop) {
            leg.weight = 0;
            leg.plantedWeight = 0;
            leg.offsetY = 0;
            leg.movePenetrating = false;
            leg.smoothedTarget.copy(footWorld);
            this.updateFootDebug(leg, hit.point);
            return;
        }
        const targetOffset = leg.planted
            ? pelvisTargetOffset
            : Math.max(0, pelvisTargetOffset);
        // 命中面超过脚部最大上抬范围时，本帧交还给原动画。
        if (targetOffset > this.maxFootRaise) {
            if (!leg.planted) {
                this.releaseSwingFoot(
                    leg,
                    footWorld,
                    startedSwing || wasMovePenetrating,
                    previousWeight,
                    delta,
                );
                this.updateFootDebug(leg, hit.point);
                return;
            }
            leg.weight = 0;
            leg.plantedWeight = 0;
            leg.offsetY = 0;
            leg.movePenetrating = false;
            leg.smoothedTarget.copy(footWorld);
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

        // 支撑脚允许在限制范围内双向贴地；摆动脚只在穿透时上抬。
        // 支撑状态和防穿透独立触发：任意相位陷入地面都会立即抬起。
        // 防穿透只负责上抬，不参与脚步锁定状态。
        leg.movePenetrating = liftAmount > this.moveLiftThreshold;

        const wantedPlantedWeight = leg.planted ? 1 : 0;
        if (startedSwing || (wasMovePenetrating && !leg.movePenetrating)) {
            // 离地或结束防穿透的首帧继承上一帧实际输出，避免暴露较低的内部相位权重。
            leg.plantedWeight = previousWeight;
        } else {
            leg.plantedWeight = MathUtils.damp(
                leg.plantedWeight ?? 0,
                wantedPlantedWeight,
                10,
                delta,
            );
        }

        // 支撑状态短时间渐入/渐出；穿透修正仍然立即介入，避免脚陷入地面。
        if (leg.movePenetrating) {
            leg.weight = 1;
        } else if (leg.plantedWeight > 0.001) {
            leg.weight = leg.plantedWeight;
        } else {
            // 移动 swing 脚听原动画，IK 不生效。
            leg.weight = 0;
        }

        // 支撑脚直接使用当前目标；摆动脚保留上一帧修正并渐出，防穿透仍立即覆盖上抬量。
        if (leg.planted) {
            leg.offsetY = targetOffset;
        } else if (leg.movePenetrating) {
            leg.offsetY = targetOffset;
        } else if (!startedSwing) {
            leg.offsetY = MathUtils.damp(leg.offsetY, 0, 10, delta);
            if (Math.abs(leg.offsetY) < this.snapEpsilon) leg.offsetY = 0;
        }
        leg.smoothedTarget.copy(footWorld).addScaledVector(this.up, leg.offsetY);

        this.updateFootDebug(leg, hit.point);
    }

    // 摆动阶段命中失效时继续释放已有支撑修正，避免无命中分支把权重和目标直接清零。
    private releaseSwingFoot(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        inheritOutputWeight: boolean,
        previousWeight: number,
        delta: number,
    ): void {
        leg.movePenetrating = false;
        leg.plantedWeight = inheritOutputWeight
            ? previousWeight
            : MathUtils.damp(leg.plantedWeight, 0, 10, delta);
        if (leg.plantedWeight < 0.001) leg.plantedWeight = 0;
        leg.weight = leg.plantedWeight;

        if (!inheritOutputWeight) {
            leg.offsetY = MathUtils.damp(leg.offsetY, 0, 10, delta);
            if (Math.abs(leg.offsetY) < this.snapEpsilon) leg.offsetY = 0;
        }
        leg.smoothedTarget.copy(footWorld).addScaledVector(this.up, leg.offsetY);
    }

    /** 在摆动开始时生成一次预测线路，并在落地后恢复原有支撑脚逻辑。 */
    private updatePredictiveFoot(
        leg: ReadyFootIKLeg,
        phase: FootPhaseRuntimeState | undefined,
        footWorld: Vector3,
        startedSwing: boolean,
        delta: number,
    ): void {
        const state = leg.predictive;

        // 支撑阶段不保留预测状态，继续使用原有 Foot IK 的贴地和权重逻辑。
        if (leg.planted) {
            if (state.mode !== "none") resetPredictiveFootState(state);
            return;
        }

        if (startedSwing) {
            resetPredictiveFootState(state);
            state.mode = "tracking";
        }

        if (!phase?.nextLanding || !Number.isFinite(phase.timeToLand)) {
            resetPredictiveFootState(state);
            return;
        }

        if (state.mode === "none") {
            // 运行中开启预测开关时也允许从当前摆动相位接管，不必等待下一个完整步态周期。
            state.mode = "tracking";
        }

        const model = this.player?.playerModel;
        if (!model) return;
        const predictionTime = Math.min(phase.timeToLand, this.predictionHorizon);
        state.animatedLanding
            .copy(phase.nextLanding.localPosition)
            .applyMatrix4(model.matrixWorld)
            .addScaledVector(this.predictionVelocity, predictionTime);
        state.animatedLandingRotation
            .copy(model.getWorldQuaternion(this.tmpQ4))
            .multiply(phase.nextLanding.localRotation);

        const replanningTurn = state.mode === "committed"
            && this.shouldReplanPredictiveTurn(leg);
        if (state.mode === "committed" && !replanningTurn) return;

        state.probeElapsed += delta;
        if (state.probeElapsed >= this.predictionProbeInterval) {
            state.probeElapsed = 0;
            const candidate = this.findPredictiveFootCandidate(
                leg,
                phase,
                state.animatedLanding,
                state.animatedLandingRotation,
            );
            if (candidate) {
                // 首次搜索从动画脚起步；转向重规划从上一帧预测目标起步，避免线路接管跳变。
                this.acceptPredictiveFootCandidate(leg, candidate);
                this.commitPredictiveFootTrajectory(
                    leg,
                    replanningTurn ? state.trajectoryCurrentTarget : footWorld,
                    phase.progress,
                );
            }
        }
    }

    /** 判断角色朝向是否已经明显偏离当前预测线路提交时的方向。 */
    private shouldReplanPredictiveTurn(leg: ReadyFootIKLeg): boolean {
        const capsule = this.player?.playerCapsule;
        if (!capsule || leg.predictive.trajectoryRootForward.lengthSq() < 1e-8) return false;

        const currentForward = this.tmpV1
            .set(0, 0, 1)
            .applyQuaternion(capsule.getWorldQuaternion(this.tmpQ4))
            .setY(0)
            .normalize();
        return currentForward.dot(leg.predictive.trajectoryRootForward)
            < PREDICTION_TURN_REPLAN_COS;
    }

    /** 在预测动画落点周围搜索中心、前后和左右五个候选落脚点。 */
    private findPredictiveFootCandidate(
        leg: ReadyFootIKLeg,
        phase: FootPhaseRuntimeState,
        expected: Vector3,
        expectedRotation: Quaternion,
    ): PredictiveFootCandidate | null {
        const capsule = this.player?.playerCapsule;
        if (!capsule) return null;

        const forward = this.tmpV1.copy(this.predictionVelocity).setY(0);
        if (forward.lengthSq() < 1e-8) {
            forward
                .set(0, 0, 1)
                .applyQuaternion(capsule.getWorldQuaternion(this.tmpQ4))
                .setY(0);
        }
        forward.normalize();
        const side = this.tmpV2.crossVectors(forward, this.up).normalize();
        const futureRootDelta = this.tmpV8
            .copy(this.predictionVelocity)
            .multiplyScalar(Math.min(phase.timeToLand, this.predictionHorizon));

        let best: PredictiveFootCandidate | null = null;
        let debugIndex = 0;
        for (const candidate of leg.predictive.debugCandidates) {
            candidate.evaluated = false;
            candidate.valid = false;
            candidate.selected = false;
        }
        // 单个入口按顺序评估五个位置，避免为候选中心额外分配数组。
        const evaluate = (offsetX: number, offsetZ: number): void => {
            const currentDebugIndex = debugIndex++;
            const debugCandidate = leg.predictive.debugCandidates[currentDebugIndex];
            debugCandidate.evaluated = true;
            debugCandidate.point.set(
                expected.x + offsetX,
                expected.y,
                expected.z + offsetZ,
            );
            const candidate = this.evaluatePredictiveFootCandidate(
                leg,
                expected.x + offsetX,
                expected.z + offsetZ,
                expected,
                expectedRotation,
                futureRootDelta,
            );
            if (candidate) {
                candidate.debugIndex = currentDebugIndex;
                debugCandidate.valid = true;
                debugCandidate.point.copy(candidate.target);
            }
            if (candidate && (!best || candidate.score < best.score)) best = candidate;
        };

        evaluate(0, 0);
        evaluate(forward.x * this.predictionSearchRadius, forward.z * this.predictionSearchRadius);
        evaluate(-forward.x * this.predictionSearchRadius, -forward.z * this.predictionSearchRadius);
        evaluate(side.x * this.predictionSearchRadius, side.z * this.predictionSearchRadius);
        evaluate(-side.x * this.predictionSearchRadius, -side.z * this.predictionSearchRadius);
        const selected = best as PredictiveFootCandidate | null;
        if (selected) leg.predictive.debugCandidates[selected.debugIndex].selected = true;
        return selected;
    }

    /** 使用脚底四点支撑、坡度、修正距离和腿长约束评估单个预测候选。 */
    private evaluatePredictiveFootCandidate(
        leg: ReadyFootIKLeg,
        centerX: number,
        centerZ: number,
        expected: Vector3,
        expectedRotation: Quaternion,
        futureRootDelta: Vector3,
    ): PredictiveFootCandidate | null {
        // 终点鞋底必须使用动画落地帧旋转，不能沿用当前摆动帧的脚尖下压姿态。
        const footWorldQ = expectedRotation;
        // worldScale 必须避开 castGroundFrom 使用的法线临时向量，保证四次探测期间保持不变。
        const worldScale = leg.foot.getWorldScale(this.tmpV9);
        const hits: FootIKGroundHit[] = [];
        let highestHit: FootIKGroundHit | null = null;

        // 先按动画脚旋转展开四个鞋底点，再从预测高度上方向下查询候选支撑面。
        for (const sample of leg.soleSamples) {
            const relative = this.tmpV4
                .copy(sample.local)
                .multiply(worldScale)
                .applyQuaternion(footWorldQ);
            const hit = this.castGroundFrom(
                centerX + relative.x,
                expected.y + this.sampleRayOriginY,
                centerZ + relative.z,
            );
            if (!hit) continue;
            hits.push(hit);
            if (!highestHit || hit.point.y > highestHit.point.y) highestHit = hit;
        }
        if (!highestHit) return null;

        // 只合并最高命中所在的近似共面点，避免跨台阶平均出不存在的斜面。
        const planeEpsilon = Math.max(1e-6, 2 * this.appliedScale);
        const supportPoint = new Vector3();
        const supportNormal = new Vector3();
        let supportCount = 0;
        for (const hit of hits) {
            const planeDistance = Math.abs(
                highestHit.normal.dot(this.tmpV5.copy(hit.point).sub(highestHit.point)),
            );
            if (planeDistance > planeEpsilon || hit.normal.dot(highestHit.normal) < 0.95) continue;
            supportPoint.add(hit.point);
            supportNormal.add(hit.normal);
            supportCount++;
        }
        if (supportCount < this.predictionMinSupportSamples) return null;
        supportPoint.multiplyScalar(1 / supportCount);
        supportNormal.normalize();
        if (supportNormal.y < this.predictionMinNormalY) return null;

        const correctionSq = (centerX - expected.x) ** 2 + (centerZ - expected.z) ** 2;
        const maxCorrectionSq = this.maxPredictionCorrection * this.maxPredictionCorrection;
        if (correctionSq > maxCorrectionSq) return null;

        // 按最终坡面旋转虚拟鞋底，反算四个角都不穿透时所需的脚骨世界高度。
        const alignQ = this.tmpQ2.setFromUnitVectors(this.up, supportNormal);
        const realAngle = 2 * Math.acos(MathUtils.clamp(alignQ.w, -1, 1));
        if (realAngle > this.maxFootTilt) {
            alignQ.slerp(this.identityQ, 1 - this.maxFootTilt / realAngle);
        }
        alignQ.slerp(this.identityQ, 1 - this.footAlignWeight);
        const targetWorldQ = alignQ.multiply(footWorldQ);

        let targetY = -Infinity;
        for (const sample of leg.soleSamples) {
            const relative = this.tmpV4
                .copy(sample.local)
                .multiply(worldScale)
                .applyQuaternion(targetWorldQ);
            const sampleX = centerX + relative.x;
            const sampleZ = centerZ + relative.z;
            const planeY = supportPoint.y - (
                supportNormal.x * (sampleX - supportPoint.x)
                + supportNormal.z * (sampleZ - supportPoint.z)
            ) / supportNormal.y;
            targetY = Math.max(targetY, planeY - relative.y);
        }
        if (!Number.isFinite(targetY)) return null;

        const target = new Vector3(centerX, targetY, centerZ);
        const heightDelta = targetY - expected.y;
        if (heightDelta > this.maxFootRaise || heightDelta < -this.maxFootDrop) return null;

        const hip = leg.upper.getWorldPosition(this.tmpV5);
        const knee = leg.lower.getWorldPosition(this.tmpV6);
        const foot = leg.foot.getWorldPosition(this.tmpV7);
        const upperLen = hip.distanceTo(knee);
        const lowerLen = knee.distanceTo(foot);
        // 候选落点按保留 pelvisKneeBend 的安全腿长过滤，避免只满足完全伸直时的理论距离。
        const maxReach = Math.sqrt(
            upperLen * upperLen
            + lowerLen * lowerLen
            + 2 * upperLen * lowerLen * Math.cos(this.pelvisKneeBend),
        );
        hip.add(futureRootDelta);
        const reachRatio = maxReach > 1e-6 ? hip.distanceTo(target) / maxReach : Infinity;
        if (reachRatio > 1) return null;

        const correctionRatio = this.maxPredictionCorrection > 1e-6
            ? Math.sqrt(correctionSq) / this.maxPredictionCorrection
            : 0;
        const heightRange = Math.max(this.maxFootRaise, this.maxFootDrop, 1e-6);
        const score = correctionRatio
            + (1 - supportNormal.y) * 0.7
            + Math.abs(heightDelta) / heightRange * 0.4
            + (4 - supportCount) * 2
            + Math.max(0, reachRatio - 0.85) / 0.2 * 3;

        return {
            target,
            point: supportPoint,
            normal: supportNormal,
            object: highestHit.object ?? null,
            score,
            debugIndex: -1,
        };
    }

    /** 冻结本次摆动的起点和落点，使后续位置 IK 与调试线共用同一条轨迹。 */
    private commitPredictiveFootTrajectory(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        progress: number,
    ): void {
        const state = leg.predictive;
        state.mode = "committed";
        state.trajectoryStart.copy(footWorld);
        state.trajectoryCurrentTarget.copy(footWorld);
        state.trajectoryStartProgress = MathUtils.clamp(progress, 0, 1);

        // 平地保留基础净空，并按水平步幅和上台阶高度增加弧高。
        const stepUp = Math.max(0, state.landingTarget.y - footWorld.y);
        const horizontalStride = Math.hypot(
            state.landingTarget.x - footWorld.x,
            state.landingTarget.z - footWorld.z,
        );
        state.trajectoryClearance = Math.min(
            this.maxFootRaise,
            this.swingClearance
                + horizontalStride * PREDICTION_STRIDE_CLEARANCE_SCALE
                + stepUp * 0.35,
        );
        const capsule = this.player?.playerCapsule;
        if (capsule) {
            state.trajectoryRootForward
                .set(0, 0, 1)
                .applyQuaternion(capsule.getWorldQuaternion(this.tmpQ4))
                .setY(0)
                .normalize();
        }
        this.rebuildPredictiveDebugTrajectory(leg);
    }

    /** 使用权威摆动轨迹重建调试折线；移动平台只会通过锚点更新终点。 */
    private rebuildPredictiveDebugTrajectory(leg: ReadyFootIKLeg): void {
        const state = leg.predictive;
        state.debugTrajectoryVisible = this.debug
            && Number.isFinite(state.score)
            && state.mode === "committed";
        if (!state.debugTrajectoryVisible) return;

        const points = state.debugTrajectory;
        for (let i = 0; i < points.length; i++) {
            const t = i / (points.length - 1);
            // 与 IK 目标调用同一个采样函数，保证画出的线路就是脚实际追踪的线路。
            samplePredictiveTrajectory(
                state.trajectoryStart,
                state.landingTarget,
                state.trajectoryClearance,
                t,
                points[i],
            );
        }
    }

    /** 保存首次有效预测候选，并把目标转换为命中平台的局部锚点。 */
    private acceptPredictiveFootCandidate(
        leg: ReadyFootIKLeg,
        candidate: PredictiveFootCandidate,
    ): void {
        const state = leg.predictive;
        state.landingTarget.copy(candidate.target);
        state.supportPoint.copy(candidate.point);
        state.landingNormal.copy(candidate.normal);
        state.score = candidate.score;
        state.supportObject = candidate.object;

        if (state.supportObject) {
            state.supportObject.updateMatrixWorld(true);
            state.supportLocalTarget.copy(state.landingTarget);
            state.supportObject.worldToLocal(state.supportLocalTarget);
            state.supportLocalPoint.copy(state.supportPoint);
            state.supportObject.worldToLocal(state.supportLocalPoint);
            // 法线使用逆法线矩阵转回局部空间，平台旋转后可重新生成正确世界法线。
            this.normalMatrix.getNormalMatrix(state.supportObject.matrixWorld).invert();
            state.supportLocalNormal
                .copy(state.landingNormal)
                .applyMatrix3(this.normalMatrix)
                .normalize();
        }
    }

    /** 根据已保存的平台局部锚点刷新预测目标、支撑点和世界法线。 */
    private refreshPredictiveSupportAnchor(leg: ReadyFootIKLeg): void {
        const state = leg.predictive;
        if (!state.supportObject) return;

        state.supportObject.updateMatrixWorld(true);
        state.landingTarget.copy(state.supportLocalTarget);
        state.supportObject.localToWorld(state.landingTarget);
        state.supportPoint.copy(state.supportLocalPoint);
        state.supportObject.localToWorld(state.supportPoint);
        this.normalMatrix.getNormalMatrix(state.supportObject.matrixWorld);
        state.landingNormal
            .copy(state.supportLocalNormal)
            .applyMatrix3(this.normalMatrix)
            .normalize();
    }

    /** 从已提交的权威轨迹采样摆动目标，使实际 IK 与调试线路保持一致。 */
    private applyPredictiveSwingFoot(
        leg: ReadyFootIKLeg,
        footWorld: Vector3,
        phase: FootPhaseRuntimeState | undefined,
    ): boolean {
        if (!this.predictivePlacement || !phase || leg.planted) return false;
        const state = leg.predictive;
        if (state.mode !== "committed" || !Number.isFinite(state.score)) return false;
        this.refreshPredictiveSupportAnchor(leg);
        this.rebuildPredictiveDebugTrajectory(leg);

        const remainingProgress = Math.max(1e-6, 1 - state.trajectoryStartProgress);
        const trajectoryProgress = MathUtils.clamp(
            (phase.progress - state.trajectoryStartProgress)
                / remainingProgress,
            0,
            1,
        );
        samplePredictiveTrajectory(
            state.trajectoryStart,
            state.landingTarget,
            state.trajectoryClearance,
            trajectoryProgress,
            leg.smoothedTarget,
        );
        this.clampPredictiveTargetToReach(leg, leg.smoothedTarget);
        state.trajectoryCurrentTarget.copy(leg.smoothedTarget);

        // 预测线路替代摆动脚原有的防穿透目标，每帧都以完整权重执行位置 IK。
        leg.movePenetrating = false;
        leg.plantedWeight = 0;
        leg.weight = 1;
        leg.offsetY = leg.smoothedTarget.y - footWorld.y;
        leg.hitPoint.copy(state.supportPoint);
        leg.hitNormal.copy(state.landingNormal);
        leg.supportPoint.copy(state.supportPoint);
        leg.supportNormal.copy(state.landingNormal);
        this.updateFootDebug(leg, state.supportPoint);
        return true;
    }

    /** 将预测目标限制在当前髋部的安全可达区间，避免跑步大步幅把膝盖拉到极限。 */
    private clampPredictiveTargetToReach(leg: ReadyFootIKLeg, target: Vector3): void {
        const hip = leg.upper.getWorldPosition(this.tmpV1);
        const knee = leg.lower.getWorldPosition(this.tmpV2);
        const foot = leg.foot.getWorldPosition(this.tmpV3);
        const upperLen = Math.max(0.0001, hip.distanceTo(knee));
        const lowerLen = Math.max(0.0001, knee.distanceTo(foot));
        const safeMaxReach = Math.sqrt(
            upperLen * upperLen
            + lowerLen * lowerLen
            + 2 * upperLen * lowerLen * Math.cos(this.pelvisKneeBend),
        );
        const safeMinReach = Math.sqrt(
            upperLen * upperLen
            + lowerLen * lowerLen
            + 2 * upperLen * lowerLen * Math.cos(this.maxKneeBend),
        );
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

        let maxY = -Infinity;
        let maxIndex = -1;
        let maxHit: FootIKGroundHit | null = null;
        const hits: Array<FootIKGroundHit | null> = new Array(samples.length).fill(null);

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            sample.hasHit = false;
            const hit = this.castGroundAtSample(sample.point);
            if (!hit) continue;
            sample.hasHit = true;
            sample.hitPoint.copy(hit.point);
            hits[i] = hit;
            if (hit.point.y > maxY) {
                maxY = hit.point.y;
                maxIndex = i;
                maxHit = hit;
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
        const planeEpsilon = Math.max(1e-6, 2 * this.appliedScale);
        leg.supportPoint.set(0, 0, 0);
        leg.supportNormal.set(0, 0, 0);
        let supportCount = 0;
        for (const sampleHit of hits) {
            if (!sampleHit) continue;
            const planeDistance = Math.abs(
                bestHit.normal.dot(this.tmpV4.copy(sampleHit.point).sub(bestHit.point)),
            );
            if (planeDistance > planeEpsilon || sampleHit.normal.dot(bestHit.normal) < 0.95) continue;
            leg.supportPoint.add(sampleHit.point);
            leg.supportNormal.add(sampleHit.normal);
            supportCount++;
        }

        if (supportCount > 0) {
            leg.supportPoint.multiplyScalar(1 / supportCount);
            leg.supportNormal.normalize();
        } else {
            leg.supportPoint.copy(bestHit.point);
            leg.supportNormal.copy(bestHit.normal);
        }

        leg.bestGroundSampleIndex = bestIndex;
        leg.footSamplePoint.copy(samples[bestIndex].point);
        return {
            point: bestHit.point,
            normal: leg.supportNormal,
        };
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
        const alignQ = this.tmpQ2.setFromUnitVectors(this.up, supportNormal);
        const realAngle = 2 * Math.acos(MathUtils.clamp(alignQ.w, -1, 1));
        if (realAngle > this.maxFootTilt) {
            alignQ.slerp(this.identityQ, 1 - this.maxFootTilt / realAngle);
        }
        alignQ.slerp(this.identityQ, 1 - this.footAlignWeight);
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

    // 优先读取移动系统最终采用的支撑。
    private castCapsuleGround(): FootIKGroundHit | null {
        const capsule = this.player?.playerCapsule;
        if (!capsule) return null;

        const activeBody = this.player?.getActiveDynamicBody?.();
        const ignoreSupport = activeBody?.kind === "sphere";

        const getGroundSupport = this.player?.getGroundSupport;
        if (getGroundSupport && !ignoreSupport) {
            const support = getGroundSupport.call(this.player);
            return support
                ? { point: support.point, normal: support.normal }
                : null;
        }

        return this.castGroundFrom(capsule.position.x, capsule.position.y, capsule.position.z);
    }

    // 从指定世界坐标向下射线检测可踩踏地面。
    private castGroundFrom(x: number, y: number, z: number): FootIKGroundHit | null {
        const meshes = this.player?.getColliderMeshes() ?? [];
        this.raycaster.ray.origin.set(x, y, z);
        const hits = this.raycaster.intersectObjects(meshes, false);
        const meshHit = hits.find(hit => this.getMeshWorldHitNormal(hit, this.tmpV3).y > 0.18);
        let bestHit: FootIKGroundHit | null = null;
        if (meshHit) {
            bestHit = {
                point: meshHit.point,
                normal: this.getMeshWorldHitNormal(meshHit, this.tmpV3).clone(),
                object: meshHit.object,
            };
        }

        const dynamicHit = this.player?.raycastDynamicGround?.(
            this.raycaster.ray.origin,
            0.18,
            FOOT_IK_IGNORED_DYNAMIC_KINDS,
        );
        if (!dynamicHit) return bestHit;
        const distance = y - dynamicHit.point.y;
        if (distance < this.raycaster.near || distance > this.raycaster.far) return bestHit;
        if (bestHit && bestHit.point.y >= dynamicHit.point.y) return bestHit;
        return {
            point: dynamicHit.point.clone(),
            normal: dynamicHit.normal.clone(),
            object: dynamicHit.body?.mesh,
        };
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
        const maxReach = Math.sqrt(
            upperLen * upperLen
            + lowerLen * lowerLen
            + 2 * upperLen * lowerLen * Math.cos(this.pelvisKneeBend),
        );

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

    // 对指定腿执行 IK 求解并贴合脚掌。
    private applyLeg(side: FootIKSide, useStraightPole: boolean): void {
        const leg = this.legs[side];
        if (!isReadyLeg(leg) || leg.weight <= 0.001) return;

        // 保存动画给出的 foot 世界旋转，普通 IK 解腿后按权重恢复该旋转。
        this.savedFootWorldQ.copy(leg.foot.getWorldQuaternion(this.tmpQ1));

        const predictiveSwing = this.predictivePlacement
            && !leg.planted
            && leg.predictive.mode === "committed";
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
        const alignQ = this.tmpQ2.setFromUnitVectors(this.up, leg.hitNormal);

        const maxTilt = this.maxFootTilt;
        const realAngle = 2 * Math.acos(MathUtils.clamp(alignQ.w, -1, 1));
        if (realAngle > maxTilt) {
            alignQ.slerp(this.identityQ, 1 - maxTilt / realAngle);
        }
        alignQ.slerp(this.identityQ, 1 - leg.weight * this.footAlignWeight);

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
            predictionMinSupportSamples: this.predictionMinSupportSamples,
            swingClearance: this.toBaseDistance(this.swingClearance),
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
        if (options.predictionMinSupportSamples !== undefined) {
            this.predictionMinSupportSamples = MathUtils.clamp(
                Math.round(options.predictionMinSupportSamples),
                1,
                4,
            );
        }
        if (options.swingClearance !== undefined) {
            this.swingClearance = this.scaleDistance(options.swingClearance);
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
        if (!Number.isFinite(state.score)) return state.mode;
        return `${state.mode} score=${state.score.toFixed(2)}`;
    }

}
