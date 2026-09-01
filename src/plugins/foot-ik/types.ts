import type {
    AnimationAction,
    AnimationClip,
    Bone,
    Line3,
    Line,
    LineSegments,
    Mesh,
    Object3D,
    Quaternion,
    Scene,
    Vector3,
} from "three";

/** 骨骼对象或用于查找骨骼的名称。 */
export type BoneRef = Bone | string;

/** 左右脚标识。 */
export type FootIKSide = "left" | "right";

/** Foot IK 地面检测时忽略的动态刚体形状。 */
export type FootIKIgnoredDynamicKind = "sphere" | "box";

/** FootIK 使用的控制器字段；实际传入对象仍是 playerController。 */
export type FootIKPlayer = {
    /** Three.js 场景。 */
    scene: Scene;
    /** 返回可供脚底射线检测的静态与运动学碰撞网格。 */
    getColliderMeshes: () => Mesh[];
    /** 返回动态刚体列表；用于判断当前是否存在可参与脚底检测的动态地面。 */
    getDynamicBodies?: () => unknown[];
    /** 从世界坐标向下检测动态刚体，并过滤法线过陡、不可站立的表面。 */
    raycastDynamicGround?: (
        origin: Vector3,
        minNormalY?: number,
        excludeKinds?: readonly FootIKIgnoredDynamicKind[],
    ) => {
        /** 动态刚体表面的世界空间命中点。 */
        point: Vector3;
        /** 命中面的世界空间单位法线。 */
        normal: Vector3;
        /** 动态刚体及其视觉变换；预测线路使用其局部空间保存落点。 */
        body?: { mesh: Object3D };
    } | null;
    /** 当前站立的动态刚体；站在球体上时 Foot IK 会忽略该支撑。 */
    getActiveDynamicBody?: () => { kind: FootIKIgnoredDynamicKind } | null;
    /** 返回角色当前世界空间速度；预测落脚启用时用于补充胶囊实际位移速度。 */
    getVelocity?: () => Vector3;
    /** 角色移动系统本帧最终采用的支撑点；可来自射线或体积探测。 */
    getGroundSupport?: () => {
        /** 控制器实际用于贴地的世界空间支撑点。 */
        point: Vector3;
        /** 实际支撑面的世界空间单位法线。 */
        normal: Vector3;
    } | null;
    /** 玩家碰撞胶囊；其世界位置同时作为角色根节点和骨盆支撑参考。 */
    playerCapsule: Mesh & {
        /** 胶囊几何参数；尚未完成玩家初始化时可能不存在。 */
        capsuleInfo?: {
            /** 胶囊半径，使用当前角色缩放后的世界尺度。 */
            radius: number;
            /** 胶囊中心轴线段，保存于胶囊本地空间。 */
            segment: Line3;
        };
    };
    /** 玩家可见模型根节点；Foot IK 从该节点中查找骨盆和腿部骨骼。 */
    playerModel: Object3D | null;
    /** 角色当前是否接地；未接地时跳过脚底贴合与骨盆补偿。 */
    playerIsOnGround: boolean;
    /** 角色是否处于飞行模式；飞行时不执行 Foot IK。 */
    isFlying?: boolean;
    /** Foot IK 需要使用的玩家缩放和移动动画名称配置。 */
    playerModelConfig: {
        /** 玩家当前整体缩放，用于同步射线长度、容差和脚底尺寸。 */
        scale: number;
        /** 默认向前行走动画名称。 */
        walkAnim: string;
        /** 默认向前奔跑动画名称。 */
        runAnim: string;
        /** 可选的左向移动动画名称。 */
        leftWalkAnim?: string;
        /** 可选的右向移动动画名称。 */
        rightWalkAnim?: string;
        /** 可选的后退动画名称。 */
        backwardAnim?: string;
    };
    /** 当前玩家动画资源与正在播放的动画动作。 */
    animation: {
        /** 用于建立脚步着地相位数据库的全部动画片段。 */
        clips: AnimationClip[];
        /** 当前动画动作；用于读取动画名称、播放时间和脚步相位。 */
        state?: AnimationAction;
    };
    /** 0 步行 / 1 载具；载具模式时跳过贴地 IK。 */
    getControllerMode?: () => number;
};

/** 单条腿参与 IK 的骨骼配置。 */
export type FootIKLegBoneConfig = {
    /** 大腿骨骼。 */
    upper?: BoneRef;
    /** 小腿骨骼。 */
    lower?: BoneRef;
    /** 脚部骨骼。 */
    foot?: BoneRef;
    /** 脚趾骨骼。 */
    toe?: BoneRef;
};

/** FootIK 使用的骨盆和左右腿骨骼配置。 */
export type FootIKSkeletonConfig = {
    /** 骨盆骨骼。 */
    hips?: BoneRef;
    /** 左右腿骨骼配置。 */
    legs?: {
        /** 左腿骨骼配置。 */
        left?: FootIKLegBoneConfig;
        /** 右腿骨骼配置。 */
        right?: FootIKLegBoneConfig;
    };
};

/** FootIK 插件初始化配置。 */
export type FootIKOptions = {
    /** 腿部骨骼绑定；未传时根据骨骼名自动匹配。 */
    skeleton?: FootIKSkeletonConfig;
    /**
     * 是否显示统一调试对象，默认 false。
     * 包含：IK 目标、最高地面命中、脚底四点（采样原点 + 命中 + 射线）。
     */
    debug?: boolean;
    /** 是否启用插件，默认 true。 */
    enabled?: boolean;
    /** 骨盆最大下沉距离基准值（按 scale 缩放），默认 50。 */
    maxPelvisDrop?: number;
    /** 双脚同处高台面时的骨盆最大上抬距离基准值（按 scale 缩放），默认 50。 */
    maxPelvisRaise?: number;
    /** 脚部 IK 最大上抬距离基准值（按 scale 缩放）；超出时放弃 IK，默认 50。 */
    maxFootRaise?: number;
    /** 支撑脚 IK 最大下探距离基准值（按 scale 缩放）；超出时放弃 IK，默认 50。 */
    maxFootDrop?: number;
    /** 虚拟脚底左右半宽基准值（按 scale 缩放），默认 7。 */
    soleHalfWidth?: number;
    /** 脚尖采样点向前延伸距离基准值（按 scale 缩放），默认 7。 */
    soleToeExtend?: number;
    /** 脚跟采样点向后延伸距离基准值（按 scale 缩放），默认 3。 */
    soleHeelExtend?: number;
    /**
     * 脚骨到脚底蒙皮的厚度补偿基准值（按 scale 缩放），默认 3。
     * 贴地校正时额外上抬，避免按骨骼贴地导致鞋底陷入地面；平地接近满值，斜坡按法线衰减。
     */
    soleSkinThickness?: number;
    /** 脚掌贴合地面法线的权重，范围 0 到 1，默认 1。 */
    footAlignWeight?: number;
    /** 脚掌最大倾斜角，单位为弧度，默认 Math.PI / 2。 */
    maxFootTilt?: number;
    /** 膝盖最小弯曲角，单位为弧度，默认 2°。 */
    minKneeBend?: number;
    /** 膝盖最大弯曲角，单位为弧度，默认 145°。 */
    maxKneeBend?: number;
    /** 骨盆可达性计算保留的膝盖弯曲角，单位为弧度，默认 15°。 */
    pelvisKneeBend?: number;
    /** 移动时脚底穿透触发阈值基准值（按 scale 缩放），默认 0.1。 */
    moveLiftThreshold?: number;
    /** 单个移动动画的脚步相位采样数，默认 96。 */
    footPhaseSampleCount?: number;
    /** 脚步相位接地高度阈值基准值（按 scale 缩放），默认 5。 */
    footPhaseGroundThreshold?: number;
    /** 最短接触段占动画周期的比例，默认 0.04。 */
    footPhaseMinContactRatio?: number;
    /** 支撑脚水平速度过滤倍率，默认 1.35。 */
    footPhaseSpeedSlack?: number;
    /** 是否启用预测落脚；默认 false，关闭时完全沿用反应式 Foot IK。 */
    predictivePlacement?: boolean;
    /** 最长预测时间，单位为秒，默认 0.45。 */
    predictionHorizon?: number;
    /** 预测地面候选重新探测间隔，单位为秒，默认 0.05。 */
    predictionProbeInterval?: number;
    /** 预测落脚候选相对动画落点的搜索半径基准值（按 scale 缩放），默认 20。 */
    predictionSearchRadius?: number;
    /** 允许预测目标偏离动画落点的最大水平距离基准值（按 scale 缩放），默认 45。 */
    maxPredictionCorrection?: number;
    /** 预测落脚允许的最小地面法线 Y 分量，默认 0.55。 */
    predictionMinNormalY?: number;
    /** 候选落脚面至少需要命中的脚底采样点数量，范围 1 到 4，默认 3。 */
    predictionMinSupportSamples?: number;
    /** 摆动轨迹的基础净空基准值（按 scale 缩放），大步幅和上台阶时会额外增加，默认 8。 */
    swingClearance?: number;
};

/** 预测落脚运行时状态。 */
export type PredictiveFootMode = "none" | "tracking" | "committed";

/** 单只脚的预测目标、支撑面和平台锚点。 */
export type PredictiveFootState = {
    mode: PredictiveFootMode;
    landingTarget: Vector3;
    landingNormal: Vector3;
    supportPoint: Vector3;
    animatedLanding: Vector3;
    animatedLandingRotation: Quaternion;
    trajectoryStart: Vector3;
    trajectoryCurrentTarget: Vector3;
    trajectoryRootForward: Vector3;
    trajectoryStartProgress: number;
    trajectoryClearance: number;
    supportObject: Object3D | null;
    supportLocalTarget: Vector3;
    supportLocalPoint: Vector3;
    supportLocalNormal: Vector3;
    probeElapsed: number;
    score: number;
    debugTrajectory: Vector3[];
    debugTrajectoryVisible: boolean;
    debugCandidates: Array<{
        point: Vector3;
        evaluated: boolean;
        valid: boolean;
        selected: boolean;
    }>;
};

// 单个地面探测采样点的运行时数据。
export type FootIKProbeSample = {
    name: string;
    point: Vector3;
    hitPoint: Vector3;
    hasHit: boolean;
};

// 固定在 foot 本地空间中的脚底采样点
export type FootIKSoleSample = FootIKProbeSample & {
    local: Vector3;
    /** 地面命中调试球（线框）。 */
    marker: Mesh | null;
    /** 采样原点 → 命中点。 */
    rayLine: Line | null;
    /** 脚底采样原点调试球（实心）。 */
    footMarker: Mesh | null;
};

// 单条腿的骨骼引用、IK 状态和调试对象。
export type FootIKLeg = {
    side: FootIKSide;
    upper: Bone | null;
    lower: Bone | null;
    foot: Bone | null;
    toe: Bone | null;
    ready: boolean;
    smoothedTarget: Vector3;
    pelvisTarget: Vector3;
    hasPelvisTarget: boolean;
    hitPoint: Vector3;
    hitNormal: Vector3;
    supportPoint: Vector3;
    supportNormal: Vector3;
    footSamplePoint: Vector3;
    soleSamples: FootIKSoleSample[];
    bestGroundSampleIndex: number;
    offsetY: number;
    movePenetrating: boolean;
    weight: number;
    plantedWeight: number;
    planted: boolean;
    predictive: PredictiveFootState;
    lastPole: Vector3;
    hasLastPole: boolean;
    marker: Mesh | null;
    hitMarker: Mesh | null;
    rayLine: Line | null;
    raiseLimitLine: LineSegments | null;
    predictiveLine: Line | null;
    predictiveCandidateMarkers: Mesh[];
};

// 已完成必要骨骼绑定的腿链。
export type ReadyFootIKLeg = FootIKLeg & {
    upper: Bone;
    lower: Bone;
    foot: Bone;
    ready: true;
};

// 左右腿运行时数据集合。
export type FootIKLegs = Record<FootIKSide, FootIKLeg>;

// IK 修改前保存的单个骨骼姿态。
export type FootIKBonePose = {
    position: Vector3;
    quaternion: Quaternion;
};

// 脚步相位离线采样配置。
export type FootPhaseOptions = {
    sampleCount: number;
    groundThreshold: number;
    minContactRatio: number;
    speedSlack: number;
};

// 单只脚在当前动画帧的相位状态。
export type FootPhaseRuntimeState = {
    planted: boolean;
    progress: number;
    timeToLand: number;
    nextLanding: FootPhaseLanding | null;
};

/** 动画周期内一次落脚事件及其模型局部脚骨位姿。 */
export type FootPhaseLanding = {
    phase: number;
    localPosition: Vector3;
    localRotation: Quaternion;
};

// 左右脚在当前动画帧的相位状态。
export type FootPhaseRuntime = Record<FootIKSide, FootPhaseRuntimeState>;

// 当前动画及其左右脚相位状态。
export type FootPhaseControllerState = FootPhaseRuntime & {
    clipName: string;
    normalizedTime: number;
};

// 单只脚在一个动画周期内的接触区间数据。
export type FootPhaseSideData = {
    contacts: boolean[];
    land: number[];
    lift: number[];
    landings: FootPhaseLanding[];
};

// 单个移动动画的左右脚相位数据。
export type FootPhaseClipData = {
    name: string;
    duration: number;
    left: FootPhaseSideData;
    right: FootPhaseSideData;
};

// 以动画名称索引的脚步相位数据库。
export type FootPhaseDatabase = Map<string, FootPhaseClipData>;

// 单只脚在某个采样帧的接触高度和模型局部脚骨位姿。
export type FootPhaseSamplePoint = {
    y: number;
    x: number;
    localY: number;
    z: number;
    localRotation: Quaternion;
};

// 左右脚在动画采样时刻的位置数据。
export type FootPhaseFrameSample = {
    time: number;
    left: FootPhaseSamplePoint;
    right: FootPhaseSamplePoint;
};

// 一个连续脚底接触区间包含的采样索引。
export type FootPhaseContactRun = {
    indices: number[];
};
