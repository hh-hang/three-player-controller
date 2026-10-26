import * as THREE from "three";
import type { BVHVehicleController } from "../utils/vehiclePhysics/BVHVehicleController";
import type { VehicleRigidBody } from "../utils/vehiclePhysics/VehicleRigidBody";

// ==================== 玩家配置 ====================

/** 已加载的模型来源（玩家使用）。 */
export type LoadedModelSource = {
    /** 已加载的模型根节点。 */
    model: THREE.Object3D;
    /** 模型使用的动画片段。 */
    animations: THREE.AnimationClip[];
    /** 已加载模型与旧模型路径不能同时使用。 */
    url?: never;
};

/** 旧版 glTF 模型路径来源（玩家使用）。 */
export type LegacyModelSource = {
    /**
     * 模型路径（GLB/GLTF）。
     * @deprecated 请在外部加载模型，并传入 model 和 animations。
     */
    url: string;
    /** 模型路径与已加载模型不能同时使用。 */
    model?: never;
    /** 模型路径与外部动画片段不能同时使用。 */
    animations?: never;
};

/** 已加载的玩家模型来源。 */
export type LoadedPlayerModelSource = LoadedModelSource;

/** 旧版 glTF 玩家模型来源。 */
export type LegacyPlayerModelSource = LegacyModelSource;

/** 玩家模型来源。 */
export type PlayerModelSource = LoadedPlayerModelSource | LegacyPlayerModelSource;

/** 玩家模型、动画和移动参数。 */
export type PlayerModelOptions = PlayerModelSource & {
    /** 模型缩放。 */
    scale: number;
    /** 静止动画名。 */
    idleAnim: string;
    /** 行走动画名。 */
    walkAnim: string;
    /** 跑步动画名。 */
    runAnim: string;
    /** 跳跃动画名；或 [起跳, 循环, 落地] 三段动画名。 */
    jumpAnim: string | [startAnim: string, loopAnim: string, endAnim: string];
    /** 左移动画，默认复用 walkAnim。 */
    leftWalkAnim?: string;
    /** 右移动画，默认复用 walkAnim。 */
    rightWalkAnim?: string;
    /** 后退动画，默认复用 walkAnim。 */
    backwardAnim?: string;
    /** 飞行动画，默认复用 idleAnim。 */
    flyAnim?: string;
    /** 飞行待机动画，默认复用 idleAnim。 */
    flyIdleAnim?: string;
    /** 飞行前进悬停动画，默认复用 flyAnim。 */
    flyHoverForwardAnim?: string;
    /** 飞行后退悬停动画，默认复用 flyIdleAnim。 */
    flyHoverBackAnim?: string;
    /** 飞行左移悬停动画，默认复用 flyIdleAnim。 */
    flyHoverLeftAnim?: string;
    /** 飞行右移悬停动画，默认复用 flyIdleAnim。 */
    flyHoverRightAnim?: string;
    /** 飞行上升悬停动画，默认复用 flyIdleAnim。 */
    flyHoverUpAnim?: string;
    /** 飞行下降悬停动画，默认复用 flyIdleAnim。 */
    flyHoverDownAnim?: string;
    /** 驾驶循环动画名，默认复用 idleAnim。 */
    drivingAnim?: string;
    /** 重力基准值（按 scale 缩放），默认 -2400。 */
    gravity?: number;
    /** 跳跃高度基准值（按 scale 缩放），默认 600。 */
    jumpHeight?: number;
    /** 移动速度基准值（按 scale 缩放），默认 200。 */
    speed?: number;
    /** 跑步速度基准值（按 scale 缩放），默认 600。 */
    runSpeed?: number;
    /** 飞行速度基准值（按 scale 缩放），默认 2100。 */
    flySpeed?: number;
    /** 人物初始朝向，单位为弧度，默认 0。 */
    rotateY?: number;
    /** 头部骨骼名，用于第一人称相机挂载。 */
    headBoneName?: string;
    /** 第一人称相机局部偏移。 */
    firstPersonCameraOffset?: [number, number, number];
    /** 胶囊体半径倍率，默认 1。 */
    capsuleRadiusRatio?: number;
    /** XZ 加速响应速度，默认 30。 */
    acceleration?: number;
    /** XZ 减速响应速度，默认 30。 */
    deceleration?: number;
};

/** 移动端按钮的布局和图标配置。 */
export type MobileButtonOptions = {
    /** 左侧位置，单位为 px。 */
    left?: number;
    /** 右侧位置，单位为 px。 */
    right?: number;
    /** 顶部位置，单位为 px。 */
    top?: number;
    /** 底部位置，单位为 px。 */
    bottom?: number;
    /** 按钮直径，单位为 px，默认 56。 */
    size?: number;
    /** 自定义图片 URL。 */
    icon?: string;
};

/** 跳跃按钮配置。 */
export type JumpButtonOptions = MobileButtonOptions & {
    /** 车辆模式下的刹车图片 URL。 */
    brakeIcon?: string;
};

/** 移动端虚拟控制 UI 配置。 */
export type MobileControlsOptions = {
    /** 是否显示摇杆，默认 true。 */
    joystick?: boolean;
    /** 跳跃/刹车按钮；false 隐藏，对象可自定义图片和布局。 */
    jump?: boolean | JumpButtonOptions;
    /** 飞行按钮；false 隐藏，对象可自定义图片和布局。 */
    fly?: boolean | MobileButtonOptions;
    /** 视角切换按钮；false 隐藏，对象可自定义图片和布局。 */
    view?: boolean | MobileButtonOptions;
    /** 上下车按钮；false 隐藏，对象可自定义图片和布局。 */
    vehicle?: boolean | MobileButtonOptions;
};

/** 可重映射的输入动作。 */
export type KeyAction =
    | "forward" | "backward" | "left" | "right"
    | "sprint" | "jump" | "toggleView" | "toggleFly" | "toggleVehicle";

/** 自定义键位映射；未填使用默认键，传入 code 或数组覆盖，传入 null 禁用。 */
export type KeyMap = Partial<Record<KeyAction, string | string[] | null>>;

/** 外部输入状态；移动轴范围为 -1 到 1，切换动作只在 true 时触发。 */
export type PlayerInput = Partial<{
    moveX: number;
    moveY: number;
    lookDeltaX: number;
    lookDeltaY: number;
    jump: boolean;
    shift: boolean;
    toggleView: boolean;
    toggleFly: boolean;
    toggleVehicle: boolean;
}>;

/** 玩家控制器初始化配置。 */
export type PlayerControllerOptions = {
    /** three.js 场景实例。 */
    scene: THREE.Scene;
    /** three.js 相机实例。 */
    camera: THREE.PerspectiveCamera;
    /** 外部相机控制器，通常为 OrbitControls。 */
    controls: any;
    /** 是否接管相机与外部 Controls，默认 true；false 时由应用更新相机。 */
    manageCamera?: boolean;
    /** 是否绑定键盘输入，默认 true；不影响鼠标视角、滚轮、移动端控件或 setInput。 */
    bindKeyboardEvents?: boolean;
    /** 是否绑定内置鼠标、滚轮和移动端视角手势，默认 true；不影响相机跟随、避障或 setInput。 */
    bindLookEvents?: boolean;
    /** 角色模型与参数配置。 */
    playerModelConfig: PlayerModelOptions;
    /** 初始出生点，默认 (0, 0, 0)。 */
    initPos?: THREE.Vector3;
    /** 鼠标灵敏度，默认 5。 */
    mouseSensitivity?: number;
    /** 第三人称最小镜头距离，默认 100。 */
    minCamDistance?: number;
    /** 第三人称最大镜头距离，默认 440。 */
    maxCamDistance?: number;
    /** 相机看向点高度比例（0 为底部，1 为顶部），默认 0.8。 */
    camLookAtHeightRatio?: number;
    /** 初始化时批量创建的碰撞体；未传则不自动建碰撞，需事后 `addCollider`。 */
    colliders?: import("../collision/colliderDesc").ColliderDesc[];
    /** 移动端是否显示虚拟控制 UI，默认 true。 */
    isShowMobileControls?: boolean;
    /** 移动端按钮显隐配置。 */
    mobileControls?: MobileControlsOptions;
    /** 第三人称鼠标控制模式，默认 1。 */
    thirdMouseMode?: 0 | 1 | 2 | 3 | 4 | 5;
    /** 是否允许滚轮缩放，默认 false。 */
    enableZoom?: boolean;
    /** 是否启用过肩视角，默认 false。 */
    enableOverShoulderView?: boolean;
    /** 第三人称相机过肩视角横向偏移比例，默认 0.2。 */
    camOverShoulderOffsetRatio?: number;
    /** 初始是否进入第一人称，默认 false。 */
    isFirstPerson?: boolean;
    /** 是否启用弹簧相机，默认 false。 */
    enableSpringCamera?: boolean;
    /** 弹簧相机平滑时间，单位为秒，默认 0.05。 */
    springCameraTime?: number;
    /** 第三人称移动时相机是否跟随人物朝向，默认 false。 */
    followPlayerDirection?: boolean;
    /** 人物朝向跟随响应速度，单位为 1/秒，默认 3；越大越快，0 暂停跟随。 */
    playerDirectionFollowSpeed?: number;
    /** 时间缩放系数；小于 1 为慢动作，大于 1 为快进，默认 1。 */
    timeScale?: number;
    /**
     * 是否启用向下体积地面探测。
     * 中心射线未命中近距离支撑时，用带宽度的圆柱传感区覆盖细缝两侧；默认 true。
     */
    enableGroundVolumeProbe?: boolean;
    /** 自定义键位映射。 */
    keyMap?: KeyMap;
};

// ==================== 车辆配置 ====================

/** 已加载的车辆模型来源（车辆不使用动画片段）。 */
export type LoadedVehicleModelSource = {
    /** 已加载的模型根节点。 */
    model: THREE.Object3D;
    /** 已加载模型与旧模型路径不能同时使用。 */
    url?: never;
};

/** 旧版 glTF 车辆模型来源。 */
export type LegacyVehicleModelSource = {
    /**
     * 模型路径（GLB/GLTF）。
     * @deprecated 请在外部加载模型，并传入 model。
     */
    url: string;
    /** 模型路径与已加载模型不能同时使用。 */
    model?: never;
};

/** 车辆模型来源。 */
export type VehicleModelSource = LoadedVehicleModelSource | LegacyVehicleModelSource;

/** 底盘碰撞盒与阻尼。 */
export type VehicleChassisOptions = {
    /** 密度，质量 = 碰撞盒体积 × 密度，默认 1。 */
    density?: number;
    /** 线阻尼，默认 0.05。 */
    linearDamping?: number;
    /** 角阻尼，默认 0.5。 */
    angularDamping?: number;
    /** 盒底相对轮胎触地点的高度（随 scale 缩放）；不传则盒底至少罩到轮心。 */
    clearance?: number;
    /**
     * 相对自动 AABB 的尺寸比例，默认 1。
     * X/Z 绕水平中心缩放；Y 从盒底向上缩放，不改变底盘离地高度。
     */
    sizeScale?: {
        x?: number;
        y?: number;
        z?: number;
    };
};

/** 悬挂与轮胎。 */
export type VehicleSuspensionOptions = {
    /** 静止长度（米，随 scale 缩放）；不传则取 max(轮直径 × 0.2, 静载下沉 × 1.2)。 */
    restLength?: number;
    /** 最大行程（米，随 scale 缩放），默认 0.35。 */
    maxTravel?: number;
    /** 刚度（质量归一化），默认 18。 */
    stiffness?: number;
    /** 压缩阻尼，默认 2.1。 */
    compression?: number;
    /** 回弹阻尼，默认 2.5。 */
    relaxation?: number;
    /** 单轮最大悬挂力，默认 6000。 */
    maxForce?: number;
    /** 纵向抓地，默认 8。 */
    frictionSlip?: number;
    /** 侧向摩擦刚度，默认 1。 */
    sideFrictionStiffness?: number;
    /** 侧向力对侧倾的影响，默认 0.12。 */
    rollInfluence?: number;
};

/** 转向手感。 */
export type VehicleSteeringOptions = {
    /** 最大转向角（弧度），默认 π/5。 */
    maxSteerAngle?: number;
    /** 打满舵时间（秒），默认 0.45。 */
    steerTime?: number;
    /** 低速回正时间（秒），默认 0.55。 */
    steerReturnTimeSlow?: number;
    /** 高速回正时间（秒），默认 0.4。 */
    steerReturnTimeFast?: number;
    /** 最高车速时转向角相对满舵的比例，默认 0.3。 */
    highSpeedSteerScale?: number;
};

/** 过弯抓地与手刹。 */
export type VehicleGripOptions = {
    /** 侧向加速度上限（g），默认 1.2。 */
    maxG?: number;
    /** 直线侧向摩擦，默认 1。 */
    sideFrictionIdle?: number;
    /** 满载前轮侧向摩擦下限，默认 0.55。 */
    sideFrictionFrontMin?: number;
    /** 满载后轮侧向摩擦下限，默认 0.45。 */
    sideFrictionRearMin?: number;
    /** 手刹后轮侧向摩擦，默认 0.35。 */
    handbrakeRearFriction?: number;
    /** 手刹时后驱比例，默认 0.65。 */
    handbrakeRearDriveScale?: number;
    /** 松手刹恢复时间（秒），默认 0.15。 */
    handbrakeReleaseTime?: number;
    /** 轴距相对车长比例，默认 0.55。 */
    wheelbaseRatio?: number;
};

/** 动力。 */
export type VehiclePowerOptions = {
    /** 最高速度基准（km/h，按 scale 缩放），默认 100。 */
    maxSpeed?: number;
    /** 加速度基准（m/s²，按 scale 缩放），默认 5。 */
    acceleration?: number;
    /** 制动减速度基准（m/s²，按 scale 缩放），默认 5。 */
    deceleration?: number;
};

/** 车辆模型、物理和驾驶参数。 */
export type VehicleOptions = VehicleModelSource & {
    /** 车辆初始世界坐标；y 为最低轮底对齐高度。 */
    position: THREE.Vector3;
    /** 车轮节点名，顺序为左前、右前、左后、右后。 */
    wheelsNames: string[];
    /** 车辆模型缩放，默认 1。 */
    scale?: number;
    /** 驾驶位胶囊中心，使用车辆底盘局部坐标。 */
    driverSeatPosition: THREE.Vector3;
    /** 驾驶位相对底盘局部的水平旋转（弧度），默认 0。 */
    driverSeatRotation?: number;
    /** 模型绕 Y 旋转（弧度），默认 -π/2。 */
    modelRotation?: number;
    /** 驾驶时镜头是否跟随车辆朝向，默认 true。 */
    followVehicleDirection?: boolean;
    /** 车辆朝向跟随响应速度，单位为 1/秒，默认 3；越大越快，0 暂停跟随。 */
    vehicleDirectionFollowSpeed?: number;
    /** 调试显示。 */
    debug?: {
        /** 是否显示底盘物理盒，默认 false。 */
        showPhysicsBox?: boolean;
        /** 是否显示车轮射线，默认 false。 */
        showWheelRays?: boolean;
        /** 是否显示车轮 Y 向活动范围，默认 false。 */
        showWheelTravel?: boolean;
        /** 是否显示车轮动态碰撞球，默认 false。 */
        showWheelSpheres?: boolean;
    };
    /** 底盘碰撞盒与阻尼。 */
    chassis?: VehicleChassisOptions;
    /** 悬挂与轮胎。 */
    suspension?: VehicleSuspensionOptions;
    /** 转向手感。 */
    steering?: VehicleSteeringOptions;
    /** 过弯抓地与手刹。 */
    grip?: VehicleGripOptions;
    /** 动力。 */
    power?: VehiclePowerOptions;
};

/** 已加载车辆的运行时对象。 */
export type VehicleInstance = {
    /** 车辆模型组。 */
    vehicleGroup: THREE.Group;
    /** 底盘刚体。 */
    chassisBody: VehicleRigidBody;
    /** BVH 车辆控制器。 */
    vehicleController: BVHVehicleController;
    /** 同步车轮视觉的回调。 */
    updateWheelVisuals: (delta?: number) => void;
    /** 销毁车辆控制器的回调。 */
    destroyVehicleController: () => void;
    /** 车辆缩放。 */
    scale: number;
    /** 驾驶位胶囊中心，使用车辆底盘局部坐标。 */
    driverSeatPosition: THREE.Vector3;
    /** 驾驶位相对车辆底盘局部的水平旋转（弧度）。 */
    driverSeatRotation: number;
    /** 由前后轮中心推算的车辆底盘本地前向。 */
    forwardLocal: THREE.Vector3;
    /** 驻车时侧向摩擦。 */
    sideFrictionStiffness: number;
    /** 转向参数。 */
    steering: {
        maxSteerAngle: number;
        steerTime: number;
        steerReturnTimeSlow: number;
        steerReturnTimeFast: number;
        highSpeedSteerScale: number;
    };
    /** 抓地预算。 */
    grip: {
        maxG: number;
        sideFrictionIdle: number;
        sideFrictionFrontMin: number;
        sideFrictionRearMin: number;
        handbrakeRearFriction: number;
        handbrakeRearDriveScale: number;
        handbrakeReleaseTime: number;
        wheelbaseRatio: number;
    };
    /** 车辆尺寸（长、宽、高）。 */
    size: {
        l: number;
        w: number;
        h: number;
    };
    /** 底盘碰撞盒半边长（底盘局部坐标）。 */
    halfExtents: THREE.Vector3;
    /** 当前盒底相对轮胎触地点的高度，使用 scale=1 基准值。 */
    chassisClearance: number;
    /** 车身顶面相对轮胎触地点的高度，使用 scale=1 基准值。 */
    chassisTopClearance: number;
    /** 底盘碰撞盒的 X 轴尺寸比例。 */
    chassisSizeScaleX: number;
    /** 底盘碰撞盒的 Y 轴尺寸比例。 */
    chassisSizeScaleY: number;
    /** 底盘碰撞盒的 Z 轴尺寸比例。 */
    chassisSizeScaleZ: number;
    /** 最高速度（km/h）。 */
    maxSpeed: number;
    /** 加速度（m/s²）。 */
    acceleration: number;
    /** 制动减速度（m/s²）。 */
    deceleration: number;
    /** 相机是否跟随车辆方向。 */
    followVehicleDirection: boolean;
    /** 车辆朝向跟随响应速度，单位为 1/秒。 */
    vehicleDirectionFollowSpeed: number;
    /** 物理盒体调试网格。 */
    physicsBoxMesh?: THREE.Mesh;
    /** 车轮射线调试。 */
    wheelRayDebug?: THREE.Group;
    /** 车轮 Y 向活动范围调试。 */
    wheelTravelDebug?: THREE.Group;
    /** 车轮动态碰撞球线框调试。 */
    wheelSphereDebug?: THREE.Group;
    /** CollisionWorld 中底盘动态碰撞体 id。 */
    chassisColliderId?: number;
    /** CollisionWorld 中车模运动学网格 id。 */
    meshColliderId?: number;
    /**
     * 仅与动态刚体碰撞的车轮球 collider id（与车轮一一对应）。
     * 运动学登记，无独立质量；冲量回写到底盘。
     */
    wheelColliderIds?: number[];
};

/** 车轮球在 CollisionWorld.userData 上的挂载数据。 */
export type VehicleWheelColliderUserData = {
    vehicle: VehicleInstance;
    wheelIndex: number;
};

/** 运动学碰撞体的 BVH 与帧间变换数据。 */
export type KinematicColliderEntry = {
    /** 原始物体。 */
    source: THREE.Object3D;
    /** BVH 网格；顶点是世界烘焙后绕 RTC 中心的小坐标。 */
    mesh: THREE.Mesh;
    /**相对建造时几何的额外均匀缩放。 */
    contentScale: number;
    /** 相对 source 本地空间的额外位移。 */
    contentOffset: THREE.Vector3;
    /** inv(source.matrixWorld_bake) * T(rtcCenter)；预置 mesh 时为单位阵。 */
    bakeInverse: THREE.Matrix4;
    /** 上一帧世界矩阵。 */
    prevWorldMatrix: THREE.Matrix4;
    /** 本帧位移增量。 */
    deltaPos: THREE.Vector3;
    /** 本帧 Y 轴旋转增量，单位为弧度。 */
    deltaRotY: number;
    /** Worker / 同步 BVH 是否已就绪。 */
    ready: boolean;
    /** 用于作废过期的异步 BVH 构建结果。 */
    buildId: number;
    /** CollisionWorld 中的运动学碰撞体 id。 */
    worldId: number;
};
