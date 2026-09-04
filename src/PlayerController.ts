import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { MobileControls } from "./utils/MobileControls";
import type { PlayerControllerOptions, PlayerModelOptions, VehicleInstance, VehicleOptions, KinematicColliderEntry, KeyMap } from "./types";
import type { PlayerPlugin } from "./plugins/types";
import { AnimationSystem } from "./systems/AnimationSystem";
import { CameraSystem } from "./systems/CameraSystem";
import { InputSystem } from "./systems/InputSystem";
import { VehicleSystem } from "./systems/VehicleSystem";
import { DynamicBodySystem } from "./systems/DynamicBodySystem";
import { ColliderRegistry } from "./systems/ColliderRegistry";
import type { DynamicBody, DynamicBodyKind } from "./collision/DynamicBody";
import type { ColliderDesc, ColliderHandle } from "./collision/colliderDesc";
import type { MotionType } from "./collision/CollisionWorld";
import { applyCapsuleCollision, createCollisionTemps, type CollisionTemps } from "./utils/capsuleCollision";
import { getBbox } from "./utils/bbox";
import { BvhWorkerPool } from "./utils/BvhWorkerPool";
import { CollisionWorld } from "./collision/CollisionWorld";
import { CHARACTER_QUERY_MASK } from "./collision/groups";
import { CharacterMovement } from "./systems/CharacterMovement";
import { PlayerDebug } from "./systems/PlayerDebug";

/** 未传入delta时计算帧间隔。 */
let _lastUpdateTime = performance.now();

function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export class playerController {

    // ==================== 场景引用 ====================
    /** GLTF加载器缓存。 */
    private _loader: GLTFLoader | null = null;
    /** GLTF加载器。 */
    get loader(): GLTFLoader {
        return this.initLoader();
    }
    set loader(loader: GLTFLoader) {
        this._loader = loader;
    }
    /** 三维场景。 */
    scene!: THREE.Scene;
    /** 透视相机。 */
    camera!: THREE.PerspectiveCamera;
    /** 轨道控制器。 */
    controls!: OrbitControls;

    // ==================== 玩家配置 ====================
    /** 模型配置项。 */
    playerModelConfig!: PlayerModelOptions;
    /** 初始出生位置。 */
    private initPos: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    /** 重力加速度。 */
    gravity = -2400;
    /** 跳跃初速度。 */
    jumpHeight = 600;
    /** 行走速度。 */
    playerSpeed = 200;
    /** 跑步速度。 */
    playerRunSpeed = 600;
    /** 飞行速度。 */
    playerFlySpeed = 2100;
    /** 当前实际速度。 */
    curPlayerSpeed = 0;
    /** 越肩视角开关。 */
    enableOverShoulderView = false;
    /** 显示移动端控件。 */
    isShowMobileControls = true;

    // ==================== 玩家胶囊体 ====================
    /** 胶囊体半径。 */
    private playerCapsuleRadius = 30;
    /** 半径缩放比。 */
    private playerCapsuleRadiusRatio = 1;
    /** 胶囊体高度。 */
    private playerCapsuleHeight = 180;
    /** 第一人称状态。 */
    isFirstPerson = false;

    // ==================== 运行状态 ====================
    /** 0步行 1载具。 */
    controllerMode: 0 | 1 = 0;
    /** 是否在地面。 */
    playerIsOnGround = false;
    /** 帧更新开关。 */
    isupdate = true;
    /** 时间缩放系数。 */
    timeScale = 1;
    /** 本帧实际使用的 delta（已钳制 + timeScale）。 */
    currentDelta = 0;
    /** 飞行状态。 */
    isFlying = false;
    /** 临时跳过玩家胶囊碰撞检测。 */
    skipCapsuleCollision = false;
    /** 启用朝向输入。 */
    enableToward = true;

    // ==================== 玩家物体 ====================
    /** 玩家碰撞胶囊。 */
    playerCapsule!: THREE.Mesh & { capsuleInfo?: any };
    /** 模型根节点。 */
    playerModel: THREE.Object3D | null = null;
    /** 头骨节点。 */
    playerModelHead: THREE.Object3D | null = null;

    // ==================== 碰撞体 ====================
    /** 碰撞体注册表。 */
    collisionWorld = new CollisionWorld();
    /** 统一创建 / 运动学跟随。 */
    private colliders = new ColliderRegistry(this);
    /** 人物胶囊与地面探测调试。 */
    private playerDebug = new PlayerDebug(this);
    /** 人物移动（胶囊推出）。 */
    private character = new CharacterMovement(this, this.playerDebug);
    /** 当前站立的运动学碰撞体。 */
    activeKinematicCollider: KinematicColliderEntry | null = null;
    /** 当前站立的动态刚体。 */
    activeDynamicBody: DynamicBody | null = null;
    /** 移动系统本帧最终采用的地面支撑；供 IK 等插件与角色接地逻辑保持一致。 */
    private hasGroundSupport = false;
    private readonly groundSupportHit = {
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 1, 0),
    };
    /** 异步 BVH 构建队列。 */
    private readonly bvhWorkerPool = new BvhWorkerPool();

    // ==================== 碰撞阈值 ====================
    /** 悬空胶囊离地高度。 */
    readonly rideHeight = 40;
    // 站立 / 落地阈值
    /** 站立时胶囊原点应离地的高度。 */
    snapH = 0;
    /** 离地超过此值判为悬空、施加重力。 */
    maxH = 0;

    // ==================== 台阶视觉平滑 ====================
    /** 插值追赶速度，越大追得越快。 */
    private stepSmoothFactor = 10;
    /** 模型相对胶囊的基准 Y。 */
    private modelBaseY = 0;
    /** 最小法线 Y 分量，地面法线与竖直夹角 ≤ 8° 视为台阶/平地（注入平滑）。 */
    readonly minFloorNormalY = Math.cos(8 * Math.PI / 180);

    // ==================== 移动端 ====================
    /** 移动端控件。 */
    mobileControls: MobileControls | null = null;
    /** 靠近车辆。 */
    isNearVehicle = false;

    // ==================== 方向常量 & 复用向量 ====================
    /** 朝向旋转速度。 */
    rotationSpeed = 10;
    /** 世界上方向。 */
    upVector = new THREE.Vector3(0, 1, 0);
    /** 前。 */
    DIR_FWD = new THREE.Vector3(0, 0, -1);
    /** 右。 */
    DIR_RGT = new THREE.Vector3(1, 0, 0);

    /** XZ 加速响应速度。 */
    playerAcceleration = 30;
    /** XZ 减速响应速度。 */
    playerDeceleration = 30;
    /** 减速基准速度。 */
    decelBase = 300;
    /** 玩家速度。 */
    playerVelocity = new THREE.Vector3();
    /** 相机方向缓存。 */
    camDir = new THREE.Vector3();
    /** 移动方向缓存。 */
    moveDir = new THREE.Vector3();
    /** 步进方向缓存。 */
    xzDir = new THREE.Vector3();
    /** 本步移动前的胶囊位置。 */
    moveStepOrigin = new THREE.Vector3();
    /** 单帧胶囊碰撞子步上限。 */
    maxMoveSteps = 8;
    /** 目标四元数。 */
    targetQuat = new THREE.Quaternion();
    /** 目标变换矩阵。 */
    targetMat = new THREE.Matrix4();
    /** 静态碰撞临时对象。 */
    staticTemps: CollisionTemps = createCollisionTemps();
    /** 运动学碰撞临时对象。 */
    kinematicTemps: CollisionTemps = createCollisionTemps();
    /** 地面检测射线。 */
    groundRaycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

    // ==================== 插件 ====================
    /** 后处理等可选插件。 */
    private plugins: PlayerPlugin[] = [];

    // ==================== 事件回调 ====================
    /** 动画切换回调。 */
    onAnimationChange?: (name: string, action: THREE.AnimationAction) => void;
    /** 视角切换前回调。 */
    onBeforeViewChange?: (isFirstPerson: boolean) => void;
    /** 视角切换后回调。 */
    onViewChange?: (isFirstPerson: boolean) => void;
    /** 落地状态回调。 */
    onGroundChange?: (onGround: boolean) => void;
    /** 上车回调。 */
    onVehicleEnter?: (vehicle: VehicleInstance) => void;
    /** 下车回调。 */
    onVehicleExit?: (vehicle: VehicleInstance) => void;
    /** 朝向变化回调。 */
    onTowardChange?: (dx: number, dy: number, speed: number) => void;

    // ==================== 子系统 ====================
    /** 动画系统。 */
    animation = new AnimationSystem(this);
    /** 相机系统。 */
    cam = new CameraSystem(this);
    /** 输入系统。 */
    input = new InputSystem(this);
    /** 载具系统。 */
    vehicle = new VehicleSystem(this);
    /** 动态刚体系统。 */
    dynamics = new DynamicBodySystem(this);

    constructor() {
        (this.groundRaycaster as any).firstHitOnly = true;
    }

    // ==================== 初始化 ====================

    /** 主初始化入口。 */
    async init(opts: PlayerControllerOptions, callback?: () => void) {
        const m = opts.playerModelConfig;
        const s = m.scale ?? 1;

        this.scene = opts.scene;
        this.camera = opts.camera;
        this.camera.rotation.order = "YXZ";
        this.controls = opts.controls;

        this.playerModelConfig = m;
        this.initPos = opts.initPos ? opts.initPos.clone() : this.initPos;

        // 应用玩家参数
        const pm = this.playerModelConfig;
        this.gravity = (pm.gravity ?? this.gravity) * s;
        this.jumpHeight = (pm.jumpHeight ?? this.jumpHeight) * s;
        this.playerSpeed = (pm.speed ?? this.playerSpeed) * s;
        this.playerRunSpeed = (pm.runSpeed ?? this.playerRunSpeed) * s;
        this.playerFlySpeed = (pm.flySpeed ?? this.playerFlySpeed) * s;
        this.curPlayerSpeed = this.playerSpeed;
        this.playerCapsuleRadiusRatio = pm.capsuleRadiusRatio ?? this.playerCapsuleRadiusRatio;
        this.playerAcceleration = pm.acceleration ?? this.playerAcceleration;
        this.playerDeceleration = pm.deceleration ?? this.playerDeceleration;
        this.decelBase = this.playerSpeed;

        // 应用相机参数
        this.cam.sensitivity = opts.mouseSensitivity ?? this.cam.sensitivity;
        this.cam.mouseMode = opts.thirdMouseMode ?? this.cam.mouseMode;
        this.cam.enableSpringCamera = opts.enableSpringCamera ?? this.cam.enableSpringCamera;
        this.cam.springCameraTime = opts.springCameraTime ?? this.cam.springCameraTime;
        this.cam.zoomEnabled = opts.enableZoom ?? this.cam.zoomEnabled;
        this.cam.minDist = (opts.minCamDistance ?? this.cam.minDist) * s;
        this.cam.maxDist = (opts.maxCamDistance ?? this.cam.maxDist) * s;
        this.cam.lookAtHeightRatio = opts.camLookAtHeightRatio ?? this.cam.lookAtHeightRatio;
        this.cam.overShoulderOffsetRatio = opts.camOverShoulderOffsetRatio ?? this.cam.overShoulderOffsetRatio;
        this.cam.originMaxDist = this.cam.maxDist;
        this.cam.epsilon = this.cam.epsilon * s;

        this.isShowMobileControls = (opts.isShowMobileControls ?? this.isShowMobileControls) && isMobileDevice();
        this.enableOverShoulderView = opts.enableOverShoulderView ?? this.enableOverShoulderView;
        this.isFirstPerson = opts.isFirstPerson ?? this.isFirstPerson;
        this.timeScale = opts.timeScale ?? this.timeScale;

        // 自定义键位
        if (opts.keyMap) this.input.buildKeyMap(opts.keyMap);

        // 初始化移动端控件
        if (this.isShowMobileControls) {
            this.mobileControls = new MobileControls(i => this.input.setInput(i), this.controls);
            await this.mobileControls.init(opts.mobileControls);
        }

        if (opts.colliders?.length) {
            for (const desc of opts.colliders) this.addCollider(desc);
        }
        await this.loadPlayerModel();

        this.input.bindEvents();
        this.cam.setCamPos();
        this.cam.initControls();
        this.cam.setOverShoulder(this.isFirstPerson ? false : this.enableOverShoulderView);
        callback?.();
    }

    /** 初始化加载器。 */
    private initLoader(): GLTFLoader {
        if (this._loader) return this._loader;

        const loader = new GLTFLoader();
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath("https://unpkg.com/three@0.182.0/examples/jsm/libs/draco/gltf/");
        loader.setDRACOLoader(dracoLoader);
        this._loader = loader;
        return loader;
    }

    // ==================== 玩家模型 ====================

    /** 加载模型与动画。 */
    private async loadPlayerModel() {
        try {
            const config = this.playerModelConfig;
            let model: THREE.Object3D;
            let animations: THREE.AnimationClip[];

            if (config.model) {
                model = config.model;
                animations = config.animations;
            } else {
                const gltf = await this.loader.loadAsync(config.url);
                model = gltf.scene;
                animations = gltf.animations ?? [];
            }

            this.playerModel = model;

            // 初始化动画混合器
            this.animation.mixer = new THREE.AnimationMixer(this.playerModel);
            this.animation.clips = animations;
            this.animation.actions = new Map();

            // 构建动作映射表
            const mc = this.playerModelConfig;
            const isThreePartJump = Array.isArray(mc.jumpAnim);
            this.animation.hasThreePartJump = isThreePartJump;
            const mappings: [string, string][] = [
                [mc.idleAnim, "idle"],
                [mc.walkAnim, "walking"],
                [mc.leftWalkAnim || mc.walkAnim, "left_walking"],
                [mc.rightWalkAnim || mc.walkAnim, "right_walking"],
                [mc.backwardAnim || mc.walkAnim, "walking_backward"],
                ...(typeof mc.jumpAnim === "string"
                    ? [[mc.jumpAnim, "jumping"]] as [string, string][]
                    : [] as [string, string][]),
                [mc.runAnim, "running"],
                [mc.flyIdleAnim || mc.idleAnim, "flyidle"],
                [mc.flyAnim || mc.idleAnim, "flying"],
                [mc.flyHoverForwardAnim || mc.flyAnim || mc.idleAnim, "flyHoverForward"],
                [mc.flyHoverBackAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverBack"],
                [mc.flyHoverLeftAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverLeft"],
                [mc.flyHoverRightAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverRight"],
                [mc.flyHoverUpAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverUp"],
                [mc.flyHoverDownAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverDown"],
                [mc.drivingAnim || mc.idleAnim, "driving"],
            ];

            for (const [clipName, actionName] of mappings) {
                const clip = animations.find(a => a.name === clipName);
                if (!clip) continue;
                const action = this.animation.mixer.clipAction(clip);
                if (actionName === "jumping") {
                    action.setLoop(THREE.LoopOnce, 1);
                    action.clampWhenFinished = true;
                    action.setEffectiveTimeScale(1.2);
                } else {
                    action.setLoop(THREE.LoopRepeat, Infinity);
                    action.setEffectiveTimeScale(1);
                }
                action.enabled = true;
                action.setEffectiveWeight(0);
                this.animation.actions.set(actionName, action);
            }

            // 注册三段跳跃动画
            if (Array.isArray(mc.jumpAnim)) {
                const [startClip, loopClip, endClip] = mc.jumpAnim;
                const jumpDefs: [string, string, number, boolean][] = [
                    [startClip, "jumpStart", THREE.LoopOnce, true],
                    [loopClip, "jumpLoop", THREE.LoopRepeat, false],
                    [endClip, "jumpEnd", THREE.LoopOnce, true],
                ];
                for (const [clipName, key, loop, clamp] of jumpDefs) {
                    const clip = animations.find(a => a.name === clipName);
                    if (!clip) { console.warn(`找不到跳跃动画 clip: "${clipName}"`); continue; }
                    const action = this.animation.mixer!.clipAction(clip);
                    action.setLoop(loop as THREE.AnimationActionLoopStyles, loop === THREE.LoopOnce ? 1 : Infinity);
                    action.clampWhenFinished = clamp;
                    action.setEffectiveTimeScale(key === "jumpStart" ? 1.2 : 1);
                    action.enabled = true;
                    action.setEffectiveWeight(0);
                    this.animation.actions.set(key, action);
                }
            }

            // 注册默认动作组
            const defaultSet = new Map<string, THREE.AnimationAction>();
            for (const key of ["idle", "walking", "walking_backward", "running", "jumping", "flyidle", "flying"]) {
                const action = this.animation.actions.get(key);
                if (action) defaultSet.set(key, action);
            }
            this.animation.sets.set("default", defaultSet);

            this.animation.actions.get("idle")?.setEffectiveWeight(1);
            this.animation.actions.get("idle")?.play();
            this.animation.state = this.animation.actions.get("idle")!;

            // 监听动画完成事件
            this.animation.mixerCb = (ev: any) => {
                const done: THREE.AnimationAction = ev.action;
                const resolveGroundAnim = () => {
                    if (this.input.fwd) { this.animation.playByName(this.input.shift ? "running" : "walking"); return; }
                    if (this.input.bkd) { this.animation.playByName("walking_backward"); return; }
                    if (this.input.rgt || this.input.lft) { this.animation.playByName("walking"); return; }
                    this.animation.playByName("idle");
                };
                if (done === this.animation.actions?.get("jumping")) {
                    if (this.animation.state === done) resolveGroundAnim();
                    return;
                }
                if (done === this.animation.actions?.get("jumpStart")) {
                    if (this.animation.state === done) this.animation.playByName("jumpLoop");
                    return;
                }
                if (done === this.animation.actions?.get("jumpEnd")) {
                    if (this.animation.state === done) resolveGroundAnim();
                    return;
                }
            };
            this.animation.mixer.addEventListener("finished", this.animation.mixerCb);

            this.animation.mixer.update(0);
            this.playerModel.updateMatrixWorld(true);

            // 计算胶囊体尺寸
            const { size } = getBbox(this.playerModel);
            const modelScale = this.playerCapsuleHeight / size.y;

            const s = this.playerModelConfig.scale;
            const r = this.playerCapsuleRadius * s * this.playerCapsuleRadiusRatio;
            const h = this.playerCapsuleHeight * s;

            // 悬空胶囊：碰撞椭球底部永久离脚 rideHeight
            const rideHeightScaled = this.rideHeight * s;   // 当前缩放下的实际悬空高度
            const colliderHeight = h - rideHeightScaled;    // 缩短后胶囊总高

            const segmentLength = colliderHeight - 2 * r;

            // 创建胶囊体网格（原点对齐 segment 上端；depthTest 与其它调试线框一致）
            this.playerCapsule = new THREE.Mesh(
                new THREE.CapsuleGeometry(r, Math.max(segmentLength, 1e-6), 4, 8),
                new THREE.MeshBasicMaterial({
                    color: 0xc45cff,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.7,
                    side: THREE.DoubleSide,
                }),
            );
            this.playerCapsule.geometry.translate(0, -segmentLength / 2, 0);
            this.playerCapsule.capsuleInfo = {
                radius: r,
                segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -segmentLength, 0)),
                // 动态体用接到脚底的完整胶囊，避免球从悬空间隙钻过
                dynamicsSegment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -segmentLength - rideHeightScaled, 0)),
            };
            this.recomputeGroundThresholds();
            this.playerCapsule.name = "capsule";
            (this.playerCapsule.material as THREE.Material).visible = false;
            this.scene.add(this.playerCapsule);
            this.reset();
            this.playerCapsule.rotateY(this.playerModelConfig.rotateY ?? 0);

            // 挂载模型到胶囊
            this.playerModel.scale.multiplyScalar(modelScale * s);
            this.modelBaseY = -segmentLength - r - rideHeightScaled;
            this.playerModel.position.set(0, this.modelBaseY, 0);
            this.playerModel.traverse((child: any) => {
                if (child.name === this.playerModelConfig?.headBoneName) this.playerModelHead = child;
            });
            this.playerCapsule.add(this.playerModel);
            this.reset();
        } catch (e) {
            console.error("加载玩家模型失败:", e);
        }
    }

    /** 切换玩家模型。 */
    async switchPlayerModel(newPlayerModel: PlayerModelOptions) {
        // 保存当前状态
        const savedPos = this.playerCapsule.position.clone();
        const savedQuat = this.playerCapsule.quaternion.clone();
        const wasFirstPerson = this.isFirstPerson;

        if (wasFirstPerson) this.scene.attach(this.camera);
        if (this.playerCapsule) this.scene.remove(this.playerCapsule);
        if (this.playerModel) { this.playerCapsule.remove(this.playerModel); this.playerModel = null; this.playerModelHead = null; }

        // 清除旧动画资源
        const anim = this.animation;
        if (anim.mixer) {
            if (anim.mixerCb) { anim.mixer.removeEventListener("finished", anim.mixerCb); anim.mixerCb = undefined; }
            anim.mixer.stopAllAction();
            anim.mixer.uncacheRoot(anim.mixer.getRoot());
            anim.mixer = undefined;
            anim.actions = undefined;
        }

        // 更新比例相关参数
        const ratio = newPlayerModel.scale / this.playerModelConfig.scale;
        this.playerModelConfig = {
            ...this.playerModelConfig,
            url: undefined,
            model: undefined,
            animations: undefined,
            ...newPlayerModel,
        } as PlayerModelOptions;

        this.applyGameplayScaleRatio(ratio);

        await this.loadPlayerModel();
        this.playerCapsule.position.copy(savedPos);
        this.playerCapsule.quaternion.copy(savedQuat);
        if (wasFirstPerson) this.cam.setFirstPerson();
        this.syncDebugVisibility();
        for (const plugin of this.plugins) plugin.onPlayerModelChange?.();
    }

    // ==================== 插件 ====================

    /** 注册后处理插件。 */
    use(plugin: PlayerPlugin): this {
        if (this.plugins.includes(plugin)) return this;
        if (plugin.name) {
            const existing = this.plugins.find(p => p.name === plugin.name);
            if (existing) this.unuse(existing);
        }
        this.plugins.push(plugin);
        plugin.onAttach?.(this);
        return this;
    }

    /** 卸载已注册的插件。 */
    unuse(plugin: PlayerPlugin): this {
        const index = this.plugins.indexOf(plugin);
        if (index < 0) return this;
        this.plugins.splice(index, 1);
        plugin.onDetach?.();
        return this;
    }

    /** 获取当前插件列表的只读副本。 */
    getPlugins(): PlayerPlugin[] {
        return this.plugins.slice();
    }

    // ==================== 碰撞体构建和查询 ====================

    /** @internal BVH worker。 */
    getBvhWorkerPool() { return this.bvhWorkerPool; }
    /** @internal 静态 / 运动学 mesh 线框开关。 */
    getDisplayCollider() { return this.colliders.getDebugVisible(); }
    /** @internal 动态刚体线框开关。 */
    getDisplayDynamicBody() { return this.dynamics.getDebugVisible(); }

    /** 统一创建碰撞体。 */
    addCollider(desc: ColliderDesc): ColliderHandle {
        return this.colliders.add(desc);
    }

    /** 按句柄移除碰撞体。 */
    removeCollider(handle: ColliderHandle | number): void {
        this.colliders.remove(handle);
    }

    /** 运行时等比缩放已烘焙的运动学 mesh 碰撞（不重建 BVH）。 */
    scaleKinematicColliderContent(source: THREE.Object3D, ratio: number): void {
        this.colliders.scaleKinematicContent(source, ratio);
    }

    /** 运行时平移已烘焙的运动学 mesh 碰撞（本地空间，不重建 BVH）。 */
    translateKinematicColliderContent(source: THREE.Object3D, localOffset: THREE.Vector3): void {
        this.colliders.translateKinematicContent(source, localOffset);
    }

    /** 清除碰撞体；可按 motion 过滤。 */
    clearColliders(filter?: { motion?: MotionType }): void {
        this.colliders.clear(filter);
    }

    /** 人物胶囊 / 相机查询用的静态与运动学网格。 */
    getColliderMeshes(options?: { skipIds?: number[] }): THREE.Mesh[] {
        return this.collisionWorld.queryMeshes({ mask: CHARACTER_QUERY_MASK }, options);
    }

    /** 车辆轮射线 / 车身接触使用的网格。跳过全部车辆外观，车车改走底盘盒。 */
    getVehicleGroundMeshes(v: VehicleInstance): THREE.Mesh[] {
        const chassis = v.chassisColliderId != null ? this.collisionWorld.get(v.chassisColliderId) : null;
        const skipIds = this.vehicle.meshSkipIds;
        skipIds.length = 0;
        for (const other of this.vehicle.list) {
            if (other.meshColliderId != null) skipIds.push(other.meshColliderId);
        }
        if (!chassis) return [];
        return this.collisionWorld.queryMeshes(chassis, { skipIds });
    }

    /** 静态碰撞体是否已有至少一份就绪的 mesh。 */
    isStaticColliderUsable() {
        return this.colliders.isStaticUsable();
    }

    /** 运动学碰撞体是否已就绪。 */
    isKinematicColliderUsable(entry: KinematicColliderEntry) {
        return this.colliders.isKinematicUsable(entry);
    }

    /** 更新运动学碰撞体网格，并计算本帧位移增量。 */
    private updateKinematicColliders() {
        this.colliders.updateKinematicFollow();
    }

    /** 本帧碰撞用完后再提交平台矩阵，供车辆按 prev→current 带走。 */
    private commitKinematicPrevMatrices() {
        this.colliders.commitKinematicPrev();
    }

    // ==================== 主循环 ====================

    /** 主循环。 */
    async update(delta?: number) {
        if (delta === undefined) {
            const now = performance.now();
            delta = (now - _lastUpdateTime) / 1000;
            _lastUpdateTime = now;
        }
        if (!this.isupdate || !this.playerCapsule) return;
        delta = Math.min(delta, 1 / 40) * this.timeScale;
        this.currentDelta = delta;
        this.updateKinematicColliders();
        if (this.controllerMode === 1) {
            this.vehicle.preparePhysics(delta);
            this.vehicle.finishPhysics(delta);
            if (!this.isFirstPerson) this.cam.updateThirdPersonVehicle(delta);
            this.runAnimationPass(delta);
        } else {
            this.updatePlayer(delta);
            // 停着的车也每帧步进，避免球砸/叠车冲量攒着、视觉冻住
            this.vehicle.finishPhysics(delta);
        }
        this.dynamics.step(delta);
        this.character.applyDynamicSupportCarry();
        this.commitKinematicPrevMatrices();
    }

    /** 玩家帧更新。 */
    updatePlayer(delta: number) {
        this.character.update(delta);
    }

    /** 在插件的恢复与应用钩子之间更新动画混合器。 */
    runAnimationPass(delta: number): void {
        for (const plugin of this.plugins) plugin.onBeforeAnimationUpdate?.(delta);
        this.animation.updateMixers(delta);
        for (const plugin of this.plugins) plugin.onAfterAnimationUpdate?.(delta);
    }

    // ==================== 内部辅助 ====================

    /** 同步全部 debug 可见性。 */
    syncDebugVisibility() {
        this.playerDebug.syncVisibility();
        this.colliders.syncDebugVisibility();
        this.dynamics.syncDebugVisibility();
        this.vehicle.syncDebugVisibility();
    }

    /** 设置落地状态。 */
    setOnGround(val: boolean) {
        if (!val) this.clearGroundSupport(); // 离地时立即作废上一帧支撑。
        if (this.playerIsOnGround === val) return;
        this.playerIsOnGround = val;
        this.onGroundChange?.(val);
        if (val) this.animation.onLand();
        else this.animation.onBecomeAirborne();
    }

    /** 应用重力。 */
    applyGravity(delta: number) {
        this.playerVelocity.y += delta * this.gravity;
        this.setOnGround(false);
    }

    /** 判断脚下地面是否为水平台面（法线接近竖直）。 */
    isFlatFloor(hit: THREE.Intersection): boolean {
        const n = hit.face?.normal;
        if (!n) return true;
        return n.y >= this.minFloorNormalY; // 大于等于最小法线 Y 分量时为水平台面
    }

    /** 吸附到地面。 */
    snapToGround(groundY: number, smooth = false, delta = 0) {
        this.playerVelocity.y = 0;
        const dy = groundY - this.playerCapsule.position.y;
        if (smooth && Math.abs(dy) <= this.rideHeight * this.playerModelConfig.scale) {
            // 平滑吸附
            this.playerCapsule.position.y += dy * Math.min(1, this.stepSmoothFactor * delta);
        } else {
            // 瞬时吸附
            this.playerCapsule.position.y = groundY;
        }
        this.setOnGround(true);
    }

    /** 按比例同步重力、速度、相机距离等玩法参数。 */
    private applyGameplayScaleRatio(ratio: number) {
        this.gravity *= ratio;
        this.jumpHeight *= ratio;
        this.playerSpeed *= ratio;
        this.playerRunSpeed *= ratio;
        this.playerFlySpeed *= ratio;
        this.curPlayerSpeed *= ratio;
        this.decelBase *= ratio;
        this.cam.epsilon *= ratio;
        this.cam.minDist *= ratio;
        this.cam.maxDist *= ratio;
        this.cam.originMaxDist *= ratio;
        this.controls.minDistance = this.cam.minDist;
    }

    /** 重算站立 / 落地阈值（snapH / maxH）。仅在胶囊创建、缩放后调用。 */
    private recomputeGroundThresholds() {
        const info = this.playerCapsule?.capsuleInfo;
        if (!info) return;
        const sy = this.playerCapsule.scale.y || 1;
        const rideHeightScaled = this.rideHeight * this.playerModelConfig.scale;
        this.snapH = (-info.segment.end.y) * sy + info.radius + rideHeightScaled;
        this.maxH = this.snapH + rideHeightScaled;
    }

    /** 动态修改玩家缩放。 */
    setPlayerScale(newScale: number) {
        if (newScale <= 0) return;
        const ratio = newScale / this.playerModelConfig.scale;
        this.playerModelConfig.scale = newScale;

        // 更新比例相关参数
        this.applyGameplayScaleRatio(ratio);

        if (this.isFirstPerson) this.scene.attach(this.camera);
        this.playerCapsule?.scale.multiplyScalar(ratio);
        if (this.playerCapsule?.capsuleInfo) {
            this.playerCapsule.capsuleInfo.radius *= ratio;
            this.recomputeGroundThresholds();
        }
        if (this.isFirstPerson) this.cam.setFirstPerson();
    }

    /** 动态修改单辆车的缩放（绝对 scale，与加载时 opts.scale 同一语义）。 */
    setVehicleScale(vehicle: VehicleInstance, newScale: number) {
        this.vehicle.setScale(vehicle, newScale);
    }

    /** 动态修改单辆车的底盘离地间隙（scale=1 基准值）。 */
    setVehicleClearance(vehicle: VehicleInstance, clearance: number) {
        this.vehicle.setClearance(vehicle, clearance);
    }

    /** 动态修改单辆车的底盘碰撞盒三轴尺寸比例。 */
    setVehicleChassisSizeScale(
        vehicle: VehicleInstance,
        sizeScale: { x?: number; y?: number; z?: number },
    ) {
        this.vehicle.setChassisSizeScale(vehicle, sizeScale);
    }

    /** 将全部已加载车辆缩放到同一绝对 scale。 */
    setAllVehiclesScale(newScale: number) {
        this.vehicle.setScaleAll(newScale);
    }

    /** 重置玩家位置。 */
    reset(position?: THREE.Vector3) {
        if (!this.playerCapsule) return;
        if (this.controllerMode === 1) {
            this.vehicle.stopActive();
            this.controllerMode = 0;
            this.mobileControls?.syncControllerModeBtn(0);
            this.scene.attach(this.playerCapsule);
            this.animation.playByName("idle");
            this.syncDebugVisibility();
        }
        this.playerVelocity.set(0, 0, 0);
        this.activeDynamicBody = null;
        this.clearGroundSupport();
        this.playerCapsule.position.copy(position ?? this.initPos);
    }

    /** 站立时胶囊原点应离地的高度。 */
    getCapsuleGroundHeight() { return this.snapH; }

    /** 运动学碰撞体列表（供车辆下车检测使用）。 */
    getKinematicColliderEntries() { return this.colliders.kinematicColliders; }

    /** 将人物模型挂载到车辆座位点。 */
    syncMountedPlayer(vehicle: VehicleInstance) {
        const cap = this.playerCapsule;
        if (!cap) return;
        this.clearGroundSupport();
        if (cap.parent !== vehicle.vehicleGroup) vehicle.vehicleGroup.attach(cap);
        cap.position.copy(vehicle.driverSeatPosition).multiplyScalar(vehicle.scale);
        cap.quaternion.setFromAxisAngle(this.upVector, vehicle.driverSeatRotation);
    }

    /** 在车辆下车位置恢复人物控制。 */
    leaveVehicleAt(position: THREE.Vector3, forward: THREE.Vector3) {
        const cap = this.playerCapsule;
        if (!cap) return;
        this.scene.attach(cap);
        cap.position.copy(position);
        const lookTarget = position.clone().add(forward);
        this.targetMat.lookAt(position, lookTarget, this.upVector);
        cap.quaternion.setFromRotationMatrix(this.targetMat);
        this.playerVelocity.set(0, 0, 0);
        this.setOnGround(false);
        if (this.isFirstPerson) this.cam.setFirstPerson();
    }

    // ==================== API ====================

    /** 获取当前位置。 */
    getPosition() { return this.playerCapsule?.position; }
    /** 获取速度。 */
    getVelocity() { return this.playerVelocity.clone(); }
    /** 获取第一人称状态。 */
    getIsFirstPerson() { return this.isFirstPerson; }
    /** 获取飞行状态。 */
    getIsFlying() { return this.isFlying; }
    /** 获取落地状态。 */
    getIsOnGround() { return this.playerIsOnGround; }
    /** 获取移动系统本帧最终采用的地面支撑。 */
    getGroundSupport() { return this.hasGroundSupport ? this.groundSupportHit : null; }
    /** 获取本帧实际使用的 delta（已钳制 + timeScale）。 */
    getCurrentDelta() { return this.currentDelta; }
    /** 获取控制器模式。 */
    getControllerMode() { return this.controllerMode; }
    /** 获取玩家模型。 */
    getPlayerModel() { return this.playerModel; }
    /** 获取胶囊体。 */
    getPlayerCapsule() { return this.playerCapsule; }
    /** 获取当前载具。 */
    getActiveVehicle() { return this.vehicle.active; }
    /** 获取所有载具。 */
    getAllVehicles() { return this.vehicle.list; }
    /** 获取当前站立的运动学碰撞体。 */
    getActiveKinematicCollider() { return this.activeKinematicCollider; }
    /** 获取当前站立的动态刚体。 */
    getActiveDynamicBody() { return this.activeDynamicBody; }

    /** 写入移动系统最终采用的地面点和世界空间法线。 */
    setGroundSupport(point: THREE.Vector3, normal: THREE.Vector3) {
        this.groundSupportHit.point.copy(point);
        this.groundSupportHit.normal.copy(normal).normalize();
        this.hasGroundSupport = true;
    }

    /** 清除已经失效的地面支撑。 */
    clearGroundSupport() { this.hasGroundSupport = false; }

    /** 移除动态刚体。 */
    removeDynamicBody(body: DynamicBody) { this.dynamics.remove(body); }
    /** 从指定世界坐标向下查询动态刚体表面。 */
    raycastDynamicGround(
        origin: THREE.Vector3,
        minNormalY?: number,
        excludeKinds?: readonly DynamicBodyKind[],
    ) {
        return this.dynamics.raycastGround(origin, minNormalY, excludeKinds);
    }
    /** 全部动态刚体。 */
    getDynamicBodies(): DynamicBody[] { return this.dynamics.list; }
    /** 清除全部动态刚体。 */
    clearDynamicBodies() { this.dynamics.clear(); }

    /** 设置鼠标灵敏度。 */
    setMouseSensitivity(value: number) {
        this.cam.sensitivity = value;
        this.controls.rotateSpeed = value * 0.05;
    }

    // --- 玩家参数 ---
    /** 设置重力。 */
    setGravity(gravity: number) { this.gravity = gravity * this.playerModelConfig.scale; }
    /** 设置跳跃高度。 */
    setJumpHeight(jumpHeight: number) { this.jumpHeight = jumpHeight * this.playerModelConfig.scale; }
    /** 设置行走速度。 */
    setPlayerSpeed(speed: number) { this.playerSpeed = speed * this.playerModelConfig.scale; this.curPlayerSpeed = this.playerSpeed; }
    /** 设置跑步速度。 */
    setPlayerRunSpeed(runSpeed: number) { this.playerRunSpeed = runSpeed * this.playerModelConfig.scale; }
    /** 设置飞行速度。 */
    setPlayerFlySpeed(flySpeed: number) { this.playerFlySpeed = flySpeed * this.playerModelConfig.scale; }
    /** 设置朝向开关。 */
    setEnableToward(v: boolean) { this.enableToward = v; }

    // --- 相机参数 ---
    /** 设置相机最近距。 */
    setMinCamDistance(dist: number) {
        this.cam.minDist = dist * this.playerModelConfig.scale;
        this.cam.originMaxDist = Math.max(this.cam.originMaxDist, this.cam.minDist);
        this.cam.maxDist = Math.max(this.cam.maxDist, this.cam.minDist);
        this.controls.minDistance = this.cam.minDist;
    }
    /** 设置相机最远距。 */
    setMaxCamDistance(dist: number) {
        this.cam.originMaxDist = Math.max(this.cam.minDist, dist * this.playerModelConfig.scale);
        this.cam.maxDist = this.cam.originMaxDist;
        this.cam.clearFlySprintMaxDistBoost();
    }
    /** 设置相机看向点高度比例。 */
    setCamLookAtHeightRatio(ratio: number) { this.cam.lookAtHeightRatio = ratio; }
    /** 设置相机过肩视角横向偏移比例。 */
    setCamOverShoulderOffsetRatio(ratio: number) { this.cam.overShoulderOffsetRatio = ratio; this.cam.setOverShoulder(this.enableOverShoulderView && !this.isFirstPerson); }

    /** 设置鼠标模式。 */
    setThirdMouseMode(mode: 0 | 1 | 2 | 3 | 4 | 5) { this.cam.mouseMode = mode; this.cam.setPointerLock(); }
    /** 设置缩放开关。 */
    setEnableZoom(enable: boolean) { this.cam.setZoomEnabled(enable); }

    // --- 调试 ---
    /** 设置静态碰撞线框。 */
    setColliderDebug(debug: boolean) {
        this.colliders.setDebugVisible(debug);
    }
    /** 设置玩家胶囊线框。 */
    setPlayerCapsuleDebug(debug: boolean) {
        this.playerDebug.setVisible(debug);
    }
    /** 设置动态刚体碰撞线框。 */
    setDynamicBodyDebug(debug: boolean) {
        this.dynamics.setDebugVisible(debug);
    }
    /** 设置车辆底盘物理盒。 */
    setVehiclePhysicsDebug(debug: boolean) {
        this.vehicle.setPhysicsDebugVisible(debug);
    }
    /** 临时跳过玩家胶囊碰撞检测。 */
    setSkipCapsuleCollision(skip: boolean) { this.skipCapsuleCollision = skip; }

    // --- 动画 ---
    /** 按名播放动画。 */
    playPlayerAnimationByName(name: string, fade?: number) { this.animation.playByName(name, fade); }
    /** 注册自定义动画。 */
    registerAnimation(key: string, clipName: string, opts?: Parameters<AnimationSystem["register"]>[2]) { this.animation.register(key, clipName, opts); }
    /** 播放已注册动画。 */
    playAnimation(key: string, opts?: Parameters<AnimationSystem["play"]>[1]) { this.animation.play(key, opts); }
    /** 注册移动动作组。 */
    registerLocomotionSet(setName: string, map: Parameters<AnimationSystem["registerLocomotionSet"]>[1]) { this.animation.registerLocomotionSet(setName, map); }
    /** 切换移动动作组。 */
    switchLocomotionSet(setName: string, fade?: number) { this.animation.switchLocomotionSet(setName, fade); }
    /** 获取当前动画名。 */
    getCurrentPlayerAnimationName() { return this.animation.getCurrentName(); }
    /** 获取当前移动动作组名。 */
    getCurrentLocomotionSet() { return this.animation.currentLocomotionSet; }

    // --- 相机 ---
    /** 切换视角模式。 */
    changeView() { this.cam.changeView(); }
    /** 设置第一人称。 */
    setFirstPersonCamera(v = 0) { this.cam.setFirstPerson(v); }
    /** 设置越肩视角。 */
    setOverShoulderView(v: boolean) { this.cam.setOverShoulder(v); this.enableOverShoulderView = v; }
    /** 屏幕中心检测。 */
    getCenterScreenRaycastHit() { return this.cam.getCenterHit(); }

    // --- 输入 ---
    /** 设置输入状态。 */
    setInput(input: Parameters<InputSystem["setInput"]>[0]) { this.input.setInput(input); }
    /** 运行时自定义键位。 */
    setKeyMap(map?: KeyMap) { this.input.buildKeyMap(map); }
    /** 绑定输入事件。 */
    onAllEvent() { this.input.bindEvents(); }
    /** 解绑输入事件。 */
    offAllEvent() { this.input.unbindEvents(); }

    // --- 载具 ---
    /** 加载车辆模型。 */
    loadVehicleModel(opts: VehicleOptions) { return this.vehicle.load(opts); }
    /** 将当前驾驶车辆翻正复位。 */
    resetVehicle() { this.vehicle.resetUpright(); }

    // --- 销毁 ---
    /** 销毁控制器并释放资源。 */
    destroy() {
        this.input.unbindEvents();

        // 卸载插件
        for (const plugin of this.plugins.slice()) {
            this.unuse(plugin);
            plugin.dispose?.();
        }
        this.plugins = [];

        this.playerDebug.dispose();

        // 清除玩家对象
        if (this.playerCapsule) { this.playerCapsule.remove(this.camera); this.scene.remove(this.playerCapsule); }
        (this.playerCapsule as any) = null;
        if (this.playerModel) { this.scene.remove(this.playerModel); this.playerModel = null; }

        // 清除碰撞体和相机
        this.cam.resetControls();
        this.clearColliders();
        this.mobileControls?.destroy();
        this.mobileControls = null;
        this.bvhWorkerPool.dispose();

        // 清除所有车辆
        this.vehicle.destroy();
        this.dynamics.clear();
        this.collisionWorld.clear();
    }
}
