import * as THREE from "three";
import { MeshBVH, BVHHelper, acceleratedRaycast } from "three-mesh-bvh";
import type { GLTF } from "three/examples/jsm/Addons.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { MobileControls } from "./utils/mobileControls";
import type { PlayerControllerOptions, PlayerModelOptions, VehicleInstance, VehicleOptions, DynamicColliderEntry } from "./types";
import { AnimationSystem } from "./systems/AnimationSystem";
import { CameraSystem } from "./systems/CameraSystem";
import { InputSystem } from "./systems/InputSystem";
import { VehicleSystem } from "./systems/VehicleSystem";
import { applyCapsuleCollision, createCollisionTemps, type CollisionTemps } from "./utils/capsuleCollision";

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const clock = new THREE.Clock();

function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export class playerController {

    // ==================== 场景引用 ====================
    loader: GLTFLoader = new GLTFLoader(); // GLTF加载器
    scene!: THREE.Scene; // 三维场景
    camera!: THREE.PerspectiveCamera; // 透视相机
    controls!: OrbitControls; // 轨道控制器

    // ==================== 玩家配置 ====================
    playerModelConfig!: PlayerModelOptions; // 模型配置项
    private initPos!: THREE.Vector3; // 初始出生位置
    gravity = -2400; // 重力加速度
    jumpHeight = 600; // 跳跃初速度
    playerSpeed = 300; // 行走速度
    playerFlySpeed = 2100; // 飞行速度
    private curPlayerSpeed = 0; // 当前实际速度
    playerFlyEnabled = true; // 飞行是否开启
    enableOverShoulderView = false; // 越肩视角开关
    private isShowMobileControls = true; // 显示移动端控件

    // ==================== 玩家胶囊体 ====================
    private playerCapsuleRadius = 30; // 胶囊体半径
    private playerCapsuleRadiusRatio = 1; // 半径缩放比
    private playerCapsuleHeight = 180; // 胶囊体高度
    isFirstPerson = false; // 第一人称状态
    private boundingBoxMinY = 0; // 碰撞体最低点

    // ==================== 运行状态 ====================
    controllerMode: 0 | 1 = 0; // 0步行 1载具
    playerIsOnGround = false; // 是否在地面
    isupdate = true; // 帧更新开关
    isFlying = false; // 飞行状态
    isChangeControllerTransitionTimer: any = null; // 模式切换计时器
    enableToward = true; // 启用朝向输入

    // ==================== 玩家物体 ====================
    playerCapsule!: THREE.Mesh & { capsuleInfo?: any }; // 玩家碰撞胶囊
    playerModel: THREE.Object3D | null = null; // 模型根节点
    playerModelHead: THREE.Object3D | null = null; // 头骨节点

    // ==================== 碰撞体 ====================
    collider: THREE.Mesh | null = null; // 静态碰撞体
    private visualizer: BVHHelper | null = null; // BVH可视化
    collected: THREE.BufferGeometry[] = []; // 静态几何收集
    private dynamicColliders: DynamicColliderEntry[] = []; // 动态碰撞体列表
    activeDynamicCollider: DynamicColliderEntry | null = null; // 当前站立的动态碰撞体

    // ==================== 碰撞阈值 ====================
    private readonly slopeAngleThreshold = 50; // 斜坡阈值（度）
    private readonly maxStepHeight = 40; // 可跨越台阶/立面高度阈值

    // ==================== 移动端 ====================
    mobileControls: MobileControls | null = null; // 移动端控件
    private isNearVehicle = false; // 靠近车辆
    private nearCheckLocal = new THREE.Vector3(); // 近距检测局部坐标
    private nearCheckWorld = new THREE.Vector3(); // 近距检测世界坐标

    // ==================== 调试 ====================
    private displayPlayer = false; // 显示玩家碰撞体
    private displayCollider = false; // 显示场景碰撞体
    private displayVisualizer = false; // 显示BVH辅助

    // ==================== 方向常量 & 复用向量 ====================
    private rotationSpeed = 10; // 朝向旋转速度
    upVector = new THREE.Vector3(0, 1, 0); // 世界上方向
    private DIR_FWD = new THREE.Vector3(0, 0, -1); // 前
    private DIR_BKD = new THREE.Vector3(0, 0, 1); // 后
    private DIR_LFT = new THREE.Vector3(-1, 0, 0); // 左
    private DIR_RGT = new THREE.Vector3(1, 0, 0); // 右

    playerVelocity = new THREE.Vector3(); // 玩家速度
    private camDir = new THREE.Vector3(); // 相机方向缓存
    private moveDir = new THREE.Vector3(); // 移动方向缓存
    targetQuat = new THREE.Quaternion(); // 目标四元数
    targetMat = new THREE.Matrix4(); // 目标变换矩阵
    private staticTemps: CollisionTemps = createCollisionTemps(); // 静态碰撞临时对象
    private dynTemps: CollisionTemps = createCollisionTemps();    // 动态碰撞临时对象
    private groundRaycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0)); // 地面检测射线

    // ==================== 事件回调 ====================
    onAnimationChange?: (name: string, action: THREE.AnimationAction) => void; // 动画切换回调
    onBeforeViewChange?: (isFirstPerson: boolean) => void; // 视角切换前回调
    onViewChange?: (isFirstPerson: boolean) => void; // 视角切换后回调
    onGroundChange?: (onGround: boolean) => void; // 落地状态回调
    onVehicleEnter?: (vehicle: VehicleInstance) => void; // 上车回调
    onVehicleExit?: (vehicle: VehicleInstance) => void; // 下车回调
    onTowardChange?: (dx: number, dy: number, speed: number) => void; // 朝向变化回调

    // ==================== 子系统 ====================
    animation = new AnimationSystem(this); // 动画系统
    cam = new CameraSystem(this); // 相机系统
    input = new InputSystem(this); // 输入系统
    vehicle = new VehicleSystem(this); // 载具系统

    constructor() {
        (this.groundRaycaster as any).firstHitOnly = true;
    }

    // ==================== 初始化 ====================

    // 主初始化入口
    async init(opts: PlayerControllerOptions, callback?: () => void) {
        const m = opts.playerModelConfig;
        const s = m.scale ?? 1;

        this.scene = opts.scene;
        this.camera = opts.camera;
        this.camera.rotation.order = "YXZ";
        this.controls = opts.controls;

        this.playerModelConfig = m;
        this.initPos = opts.initPos
            ? new THREE.Vector3(opts.initPos.x, opts.initPos.y, opts.initPos.z)
            : new THREE.Vector3(0, 0, 0);

        // 应用玩家参数
        const pm = this.playerModelConfig;
        this.gravity = (pm.gravity ?? this.gravity) * s;
        this.jumpHeight = (pm.jumpHeight ?? this.jumpHeight) * s;
        this.playerSpeed = (pm.speed ?? this.playerSpeed) * s;
        this.playerFlySpeed = (pm.flySpeed ?? this.playerFlySpeed) * s;
        this.curPlayerSpeed = this.playerSpeed;
        this.playerFlyEnabled = pm.flyEnabled ?? this.playerFlyEnabled;
        this.playerCapsuleRadiusRatio = pm.capsuleRadiusRatio ?? this.playerCapsuleRadiusRatio;

        // 应用相机参数
        this.cam.sensitivity = opts.mouseSensitivity ?? this.cam.sensitivity;
        this.cam.mouseMode = opts.thirdMouseMode ?? this.cam.mouseMode;
        this.cam.zoomEnabled = opts.enableZoom ?? this.cam.zoomEnabled;
        this.cam.minDist = (opts.minCamDistance ?? this.cam.minDist) * s;
        this.cam.maxDist = (opts.maxCamDistance ?? this.cam.maxDist) * s;
        this.cam.lookAtHeightRatio = opts.camLookAtHeightRatio ?? this.cam.lookAtHeightRatio;
        this.cam.originMaxDist = this.cam.maxDist;
        this.cam.epsilon = this.cam.epsilon * s;

        this.isShowMobileControls = (opts.isShowMobileControls ?? this.isShowMobileControls) && isMobileDevice();
        this.enableOverShoulderView = opts.enableOverShoulderView ?? this.enableOverShoulderView;
        this.isFirstPerson = opts.isFirstPerson ?? this.isFirstPerson;

        // 初始化移动端控件
        if (this.isShowMobileControls) {
            this.mobileControls = new MobileControls(i => this.input.setInput(i), this.controls);
            await this.mobileControls.init(opts.mobileControls);
        }

        await this.initLoader();
        this.buildStaticCollider(opts.staticCollider);
        await this.loadPlayerModelGLB();

        // 初始化时注册动态碰撞体
        if (opts.dynamicCollider) {
            const list = Array.isArray(opts.dynamicCollider) ? opts.dynamicCollider : [opts.dynamicCollider];
            for (const obj of list) this.addDynamicCollider(obj);
        }

        this.input.bindEvents();
        this.cam.setCamPos();
        this.cam.initControls();
        this.cam.setOverShoulder(this.isFirstPerson ? false : this.enableOverShoulderView);
        callback?.();
    }

    // 初始化加载器
    private async initLoader() {
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath("https://unpkg.com/three@0.182.0/examples/jsm/libs/draco/gltf/");
        this.loader.setDRACOLoader(dracoLoader);
    }

    // ==================== 玩家模型 ====================

    // 加载模型与动画
    private async loadPlayerModelGLB() {
        try {
            const gltf = await this.loader.loadAsync(this.playerModelConfig.url) as GLTF;
            this.playerModel = gltf.scene;

            // 初始化动画混合器
            this.animation.mixer = new THREE.AnimationMixer(this.playerModel);
            const animations = gltf.animations ?? [];
            this.animation.clips = animations;
            this.animation.actions = new Map();

            // 构建动作映射表
            const mappings: [string, string][] = [
                [this.playerModelConfig.idleAnim, "idle"],
                [this.playerModelConfig.walkAnim, "walking"],
                [this.playerModelConfig.leftWalkAnim || this.playerModelConfig.walkAnim, "left_walking"],
                [this.playerModelConfig.rightWalkAnim || this.playerModelConfig.walkAnim, "right_walking"],
                [this.playerModelConfig.backwardAnim || this.playerModelConfig.walkAnim, "walking_backward"],
                [this.playerModelConfig.jumpAnim, "jumping"],
                [this.playerModelConfig.runAnim, "running"],
                [this.playerModelConfig.flyIdleAnim || this.playerModelConfig.idleAnim, "flyidle"],
                [this.playerModelConfig.flyAnim || this.playerModelConfig.idleAnim, "flying"],
                [this.playerModelConfig.enterCarAnim || this.playerModelConfig.idleAnim, "enterCar"],
                [this.playerModelConfig.exitCarAnim || this.playerModelConfig.idleAnim, "exitCar"],
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
                if (done === this.animation.actions?.get("jumping")) {
                    if (this.input.fwd) { this.animation.playByName(this.input.shift ? "running" : "walking"); return; }
                    if (this.input.bkd) { this.animation.playByName("walking_backward"); return; }
                    if (this.input.rgt || this.input.lft) { this.animation.playByName("walking"); return; }
                    this.animation.playByName("idle");
                }
                if (done === this.animation.actions?.get("enterCar")) this.vehicle.onEnterAnimFinished();
            };
            this.animation.mixer.addEventListener("finished", this.animation.mixerCb);

            this.animation.mixer.update(0);
            this.playerModel.updateMatrixWorld(true);

            // 计算胶囊体尺寸
            const { size } = this.getBbox(this.playerModel);
            const modelScale = this.playerCapsuleHeight / size.y;

            const s = this.playerModelConfig.scale;
            const r = this.playerCapsuleRadius * s * this.playerCapsuleRadiusRatio;
            const h = this.playerCapsuleHeight * s;

            // 创建胶囊体网格
            this.playerCapsule = new THREE.Mesh(
                new RoundedBoxGeometry(r * 2, h, r * 2, 1, 75),
                new THREE.MeshStandardMaterial({
                    color: new THREE.Color(1, 0, 0),
                    shadowSide: THREE.DoubleSide,
                    depthTest: false,
                    wireframe: true,
                    depthWrite: false,
                }),
            );
            const segmentLength = h - 2 * r;
            this.playerCapsule.geometry.translate(0, -segmentLength / 2, 0);
            this.playerCapsule.capsuleInfo = {
                radius: r,
                segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -segmentLength, 0)),
            };
            this.playerCapsule.name = "capsule";
            (this.playerCapsule.material as THREE.Material).visible = this.displayPlayer;
            this.scene.add(this.playerCapsule);
            this.reset();
            this.playerCapsule.rotateY(this.playerModelConfig.rotateY ?? 0);

            // 挂载模型到胶囊
            this.playerModel.scale.multiplyScalar(modelScale * s);
            this.playerModel.position.set(0, -segmentLength - r, 0);
            this.playerModel.traverse((child: any) => {
                if (child.name === this.playerModelConfig?.headBoneName) this.playerModelHead = child;
            });
            this.playerCapsule.add(this.playerModel);
            this.reset();
        } catch (e) {
            console.error("加载玩家模型失败:", e);
        }
    }

    // 切换玩家模型
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
        this.playerModelConfig = { ...this.playerModelConfig, ...newPlayerModel };

        this.gravity *= ratio;
        this.jumpHeight *= ratio;
        this.playerSpeed *= ratio;
        this.playerFlySpeed *= ratio;
        this.curPlayerSpeed *= ratio;
        this.cam.epsilon *= ratio;
        this.cam.minDist *= ratio;
        this.cam.maxDist *= ratio;
        this.cam.originMaxDist *= ratio;

        await this.loadPlayerModelGLB();
        this.playerCapsule.position.copy(savedPos);
        this.playerCapsule.quaternion.copy(savedQuat);
        if (wasFirstPerson) this.cam.setFirstPerson();
        this.setDebug(this.displayCollider);
    }

    // ==================== 碰撞体构建和查询 ====================

    // 获取包围盒
    private getBbox(object: THREE.Object3D) {
        const bbox = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        bbox.getCenter(center);
        bbox.getSize(size);
        return { bbox, center, size };
    }

    // 补全必要属性
    private ensureAttributesMinimal(geom: THREE.BufferGeometry): THREE.BufferGeometry | null {
        if (!geom.attributes.position) return null;
        if (!geom.attributes.normal) geom.computeVertexNormals();
        if (!geom.attributes.uv) {
            const count = geom.attributes.position.count;
            geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        }
        return geom;
    }

    // 统一属性格式
    private unifiedAttribute(collected: THREE.BufferGeometry[]) {
        type AttrMeta = { itemSize: number; arrayCtor: any; examples: number; normalized: boolean };
        const attrMap = new Map<string, AttrMeta>();
        const attrConflict = new Set<string>();
        const required = new Set(["position", "normal", "uv"]);

        // 清除非必要属性
        for (const g of collected)
            for (const name of Object.keys(g.attributes))
                if (!required.has(name)) g.deleteAttribute(name);

        // 统计属性元信息
        for (const g of collected) {
            for (const name of Object.keys(g.attributes)) {
                const attr = g.attributes[name] as THREE.BufferAttribute;
                const ctor = (attr.array as any).constructor;
                if (!attrMap.has(name)) {
                    attrMap.set(name, { itemSize: attr.itemSize, arrayCtor: ctor, examples: 1, normalized: attr.normalized });
                } else {
                    const m = attrMap.get(name)!;
                    if (m.itemSize !== attr.itemSize || m.arrayCtor !== ctor || m.normalized !== attr.normalized) attrConflict.add(name);
                    else m.examples++;
                }
            }
        }

        // 移除冲突属性
        for (const name of attrConflict) {
            for (const g of collected) if (g.attributes[name]) g.deleteAttribute(name);
            attrMap.delete(name);
        }

        // 补全缺失属性
        for (const [name, meta] of attrMap) {
            for (const g of collected) {
                if (!g.attributes[name]) {
                    const count = g.attributes.position.count;
                    g.setAttribute(name, new THREE.BufferAttribute(new meta.arrayCtor(count * meta.itemSize), meta.itemSize, meta.normalized));
                }
            }
        }
        return collected;
    }

    // 构建静态碰撞体
    buildStaticCollider(sources?: THREE.Object3D | THREE.Object3D[]) {
        this.collected = [];
        if (this.collider) { this.scene.remove(this.collider); this.collider = null; }

        const collectMesh = (mesh: THREE.Mesh | THREE.LineSegments) => {
            try {
                let geom = mesh.geometry.clone();
                geom.applyMatrix4(mesh.matrixWorld);
                if (geom.index) geom = geom.toNonIndexed();
                const safe = this.ensureAttributesMinimal(geom);
                if (safe) this.collected.push(safe);
            } catch (e) {
                console.warn("处理网格时出错：", mesh, e);
            }
        };

        // 收集碰撞网格：传入则用指定对象，否则遍历整个场景
        if (sources) {
            const list = Array.isArray(sources) ? sources : [sources];
            for (const obj of list) {
                obj.updateMatrixWorld(true);
                obj.traverse(c => {
                    const a = c as any;
                    if ((a.isMesh || a.isLineSegments) && a.geometry && c.name !== "capsule") collectMesh(a);
                });
            }
        } else {
            this.scene.traverse(c => {
                const m = c as THREE.Mesh;
                if (m?.isMesh && m.geometry && c.name !== "capsule") collectMesh(m);
            });
        }

        if (!this.collected.length) return;
        this.collected = this.unifiedAttribute(this.collected);

        // 合并并构建BVH
        const merged = BufferGeometryUtils.mergeGeometries(this.collected, false);
        if (!merged) { console.error("合并几何失败"); return; }
        (merged as any).boundsTree = new MeshBVH(merged, { maxDepth: 100 });
        this.collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true, wireframe: true, depthTest: true, side: THREE.DoubleSide }));
        this.collider.layers.enable(1);

        if (this.displayCollider) this.scene.add(this.collider);
        if (this.displayVisualizer) {
            if (this.visualizer) this.scene.remove(this.visualizer);
            this.visualizer = new BVHHelper(this.collider, 10);
            this.scene.add(this.visualizer);
        }
        this.boundingBoxMinY = (this.collider as any).geometry.boundingBox.min.y;
    }

    // 注册动态碰撞体
    addDynamicCollider(source: THREE.Object3D) {
        if (this.dynamicColliders.find(e => e.source === source)) return;
        source.updateMatrixWorld(true);

        // 收集网格，几何保留在 source 本地空间
        const collected: THREE.BufferGeometry[] = [];
        const invSource = new THREE.Matrix4().copy(source.matrixWorld).invert();
        source.traverse(c => {
            const m = c as THREE.Mesh;
            if (!m?.isMesh || !m.geometry || c.name === "capsule") return;
            try {
                let geom = (m.geometry as THREE.BufferGeometry).clone();
                geom.applyMatrix4(new THREE.Matrix4().multiplyMatrices(invSource, m.matrixWorld));
                if (geom.index) geom = geom.toNonIndexed();
                const safe = this.ensureAttributesMinimal(geom);
                if (safe) collected.push(safe);
            } catch (e) { console.warn("处理动态网格出错：", m, e); }
        });

        if (!collected.length) return;
        const unified = this.unifiedAttribute(collected);
        const merged = BufferGeometryUtils.mergeGeometries(unified, false);
        if (!merged) { console.error("合并动态几何失败"); return; }
        (merged as any).boundsTree = new MeshBVH(merged);

        const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true, wireframe: true, depthTest: true, side: THREE.DoubleSide }));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(source.matrixWorld);
        mesh.updateMatrixWorld(true);

        this.dynamicColliders.push({ source, mesh, prevWorldMatrix: new THREE.Matrix4().copy(source.matrixWorld), deltaPos: new THREE.Vector3(), deltaRotY: 0 });
        if (this.displayCollider) this.scene.add(mesh);
    }

    // 注销动态碰撞体
    removeDynamicCollider(source: THREE.Object3D) {
        const idx = this.dynamicColliders.findIndex(e => e.source === source);
        if (idx === -1) return;
        const entry = this.dynamicColliders[idx];
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        (entry.mesh.material as THREE.Material).dispose();
        if (this.activeDynamicCollider === entry) this.activeDynamicCollider = null;
        this.dynamicColliders.splice(idx, 1);
    }

    // 清除所有动态碰撞体
    clearDynamicColliders() {
        for (const entry of this.dynamicColliders) {
            this.scene.remove(entry.mesh);
            entry.mesh.geometry.dispose();
            (entry.mesh.material as THREE.Material).dispose();
        }
        this.dynamicColliders = [];
        this.activeDynamicCollider = null;
    }

    // 更新动态碰撞体
    private updateDynamicColliders() {
        if (!this.playerCapsule) return;
        const playerWorldPos = this.playerCapsule.position.clone();

        for (const entry of this.dynamicColliders) {
            // 将玩家位置变换到平台上一帧本地空间
            const prevInv = new THREE.Matrix4().copy(entry.prevWorldMatrix).invert();
            const playerInLocal = playerWorldPos.clone().applyMatrix4(prevInv);

            // 更新 mesh 跟随 source
            entry.source.updateMatrixWorld(true);
            entry.mesh.matrix.copy(entry.source.matrixWorld);
            entry.mesh.updateMatrixWorld(true);

            // 变换回新世界空间，得到含旋转的完整位移
            const playerInNewWorld = playerInLocal.clone().applyMatrix4(entry.source.matrixWorld);
            entry.deltaPos.subVectors(playerInNewWorld, playerWorldPos);

            // 计算平台本帧 Y 轴旋转增量
            const prevEuler = new THREE.Euler().setFromRotationMatrix(entry.prevWorldMatrix, "YXZ");
            const curEuler = new THREE.Euler().setFromRotationMatrix(entry.source.matrixWorld, "YXZ");
            entry.deltaRotY = curEuler.y - prevEuler.y;

            // 保存当前矩阵供下帧使用
            entry.prevWorldMatrix.copy(entry.source.matrixWorld);
        }
    }

    // 判断是否跳过三角面碰撞
    private shouldSkipTriCollision(tri: any): boolean {
        const normal = tri.getNormal(new THREE.Vector3());
        const normalYAangle = normal.angleTo(this.upVector) * 180 / Math.PI;
        // 小于 slopeAngleThreshold° 斜坡，不处理碰撞
        if (normalYAangle < this.slopeAngleThreshold) return true;
        // 忽略立面阈值高度以下的碰撞
        if (normalYAangle > 85 && normalYAangle < 95) {
            const triHeight = Math.max(tri.a.y, tri.b.y, tri.c.y) - Math.min(tri.a.y, tri.b.y, tri.c.y); // 三角面y高度
            if (triHeight < this.maxStepHeight * this.playerModelConfig.scale) return true; // 阈值高度
        }
        return false;
    }


    // ==================== 主循环 ====================

    // 主循环
    async update(delta = clock.getDelta()) {
        if (!this.isupdate || !this.playerCapsule || !this.collider) return;
        delta = Math.min(delta, 1 / 40);
        if (this.controllerMode === 1) {
            this.vehicle.updateVehicle(delta);
        } else {
            this.updatePlayer(delta);
            if (this.isChangeControllerTransitionTimer) this.vehicle.updateInertia(delta);
        }
    }

    // 玩家帧更新
    updatePlayer(delta: number) {
        // 更新动态碰撞体位置与增量
        this.updateDynamicColliders();

        const v = this.vehicle;
        if (v.isMovingToBoarding) v.updateMoveTo(delta);

        // 上车关门计时
        if (v.isBoardingAnim) {
            const action = this.animation.actions?.get("enterCar");
            if (action) {
                const duration = action.getClip().duration;
                const remaining = ((duration - action.time) / action.getEffectiveTimeScale()) * 1000;
                if (!v.doorClosed && remaining <= 500) { v.doorClosed = true; v.openDoor(false); }
                if (action.time >= duration) {
                    v.isBoardingAnim = false;
                    v.doorClosed = false;
                    v.onEnterAnimFinished();
                    return;
                }
            }
        }

        // 下车关门计时
        if (v.isExitAnim) {
            const action = this.animation.actions?.get("exitCar");
            if (action) {
                const duration = action.getClip().duration;
                const remaining = ((duration - action.time) / action.getEffectiveTimeScale()) * 1000;
                if (!v.exitDoorClosed && remaining <= 500) { v.exitDoorClosed = true; v.openDoor(false); }
                if (action.time >= duration) { v.isExitAnim = false; v.exitDoorClosed = false; this.onVehicleExit?.(v.active!); }
            }
        }

        // 更新动画混合器
        this.animation.updateMixers(delta);
        // 车辆模式下退出
        if (this.controllerMode === 1) return;

        // 计算移动方向
        this.camera.getWorldDirection(this.camDir);
        const angle = 2 * Math.PI - (Math.atan2(this.camDir.z, this.camDir.x) + Math.PI / 2);

        // 按键移动方向
        this.moveDir.set(0, 0, 0);
        if (this.input.fwd) this.moveDir.add(this.DIR_FWD);
        if (this.input.bkd) this.moveDir.add(this.DIR_BKD);
        if (this.input.lft) this.moveDir.add(this.DIR_LFT);
        if (this.input.rgt) this.moveDir.add(this.DIR_RGT);
        if (this.isFlying) {
            this.moveDir.y = this.input.fwd ? this.camDir.y : 0;
            if (this.input.space) this.moveDir.y += 1;
            if (this.input.ctrlKey) this.moveDir.y -= 1;
            this.curPlayerSpeed = this.input.shift ? this.playerFlySpeed * 2 : this.playerFlySpeed;
        } else {
            this.curPlayerSpeed = this.input.shift ? this.playerSpeed * 2 : this.playerSpeed;
        }

        // 归一化并应用相机角度
        this.moveDir.normalize().applyAxisAngle(this.upVector, angle);

        // 地面检测
        const s = this.playerModelConfig.scale;
        this.groundRaycaster.ray.origin.copy(this.playerCapsule.position);
        const staticHits = this.groundRaycaster.intersectObject(this.collider!, false);

        // 同时检测动态碰撞体，取最高地面点
        let bestHit: THREE.Intersection | undefined = staticHits[0];
        let hitEntry: DynamicColliderEntry | null = null;
        for (const entry of this.dynamicColliders) {
            const dynHits = this.groundRaycaster.intersectObject(entry.mesh, false);
            if (dynHits.length > 0 && (!bestHit || dynHits[0].point.y > bestHit.point.y)) {
                bestHit = dynHits[0];
                hitEntry = entry;
            }
        }
        // 更新当前动态碰撞体
        this.activeDynamicCollider = hitEntry;

        if (!this.isFlying) {
            if (bestHit) {
                const capsuleInfo = this.playerCapsule.capsuleInfo;
                const snapH = parseFloat((-capsuleInfo.segment.end.y + capsuleInfo.radius).toFixed(6));
                const maxH = parseFloat((snapH * 1.2).toFixed(6));
                const dist = parseFloat((this.playerCapsule.position.y - bestHit.point.y).toFixed(6));
                if (dist > maxH) {
                    // console.log('应用重力');
                    this.applyGravity(delta);
                } else {
                    if (this.playerVelocity.y <= 0) {
                        // console.log('吸附到地面');
                        this.snapToGround(bestHit.point.y + snapH);
                    }
                }
            } else {
                // console.log('应用重力');
                this.applyGravity(delta);
            }
        }

        // 分步碰撞移动
        const capsuleInfo = this.playerCapsule.capsuleInfo;
        const totalDist = this.curPlayerSpeed * delta;
        const maxStep = capsuleInfo.radius * 0.8;
        const steps = Math.ceil(totalDist / maxStep) || 1;
        const stepDist = totalDist / steps;
        for (let i = 0; i < steps; i++) {
            this.playerCapsule.position.addScaledVector(this.moveDir, stepDist);
            this.playerCapsule.updateMatrixWorld();

            if (!v.isMovingToBoarding) {
                // 静态碰撞检测
                applyCapsuleCollision(
                    this.playerCapsule,
                    capsuleInfo,
                    this.collider!,
                    this.staticTemps,
                    (tri) => !this.isFlying && this.playerIsOnGround && this.shouldSkipTriCollision(tri),
                );

                // 动态碰撞检测
                for (const dynEntry of this.dynamicColliders) {
                    this.playerCapsule.updateMatrixWorld();
                    applyCapsuleCollision(
                        this.playerCapsule,
                        capsuleInfo,
                        dynEntry.mesh,
                        this.dynTemps,
                        (tri) => !this.isFlying && this.playerIsOnGround && this.shouldSkipTriCollision(tri),
                    );
                }
            }
        }

        // 动态平台带动玩家
        if (this.activeDynamicCollider && this.playerIsOnGround && !this.isFlying) {
            this.playerCapsule.position.add(this.activeDynamicCollider.deltaPos);
            if (this.activeDynamicCollider.deltaRotY !== 0) {
                this.playerCapsule.rotateY(this.activeDynamicCollider.deltaRotY);
            }
        }

        // 玩家朝向
        if (!this.isFirstPerson) {
            const camDirFlat = this.camDir.clone().setY(0).normalize().negate();
            const moveDirFlat = this.moveDir.clone().normalize().negate();

            if (!this.isFlying) {
                if (this.cam.mouseMode === 4 || this.cam.mouseMode === 5) {
                    // mode 4/5: 胶囊朝向始终与相机水平朝向一致，鼠标旋转即驱动人物转向
                    this.targetMat.lookAt(this.playerCapsule.position, this.playerCapsule.position.clone().add(camDirFlat), this.playerCapsule.up);
                    this.playerCapsule.quaternion.copy(this.targetQuat.setFromRotationMatrix(this.targetMat));
                } else if (this.cam.mouseMode === 0 || this.cam.mouseMode === 2) {
                    const lookTarget = this.playerCapsule.position.clone().add(moveDirFlat.lengthSq() > 0 ? moveDirFlat : camDirFlat);
                    this.targetMat.lookAt(this.playerCapsule.position, lookTarget, this.playerCapsule.up);
                    this.playerCapsule.quaternion.slerp(this.targetQuat.setFromRotationMatrix(this.targetMat), Math.min(1, this.rotationSpeed * delta));
                } else if (moveDirFlat.lengthSq() > 0) {
                    this.targetMat.lookAt(this.playerCapsule.position, this.playerCapsule.position.clone().add(moveDirFlat), this.playerCapsule.up);
                    this.playerCapsule.quaternion.slerp(this.targetQuat.setFromRotationMatrix(this.targetMat), Math.min(1, this.rotationSpeed * delta));
                }
            } else {
                const lookTarget = this.playerCapsule.position.clone().add(this.input.fwd ? moveDirFlat : camDirFlat);
                this.targetMat.lookAt(this.playerCapsule.position, lookTarget, this.playerCapsule.up);
                this.playerCapsule.quaternion.slerp(this.targetQuat.setFromRotationMatrix(this.targetMat), Math.min(1, this.rotationSpeed * delta));
            }
        }

        // 第三人称相机跟随
        if (!this.isFirstPerson) {
            const lookTarget = this.cam.getLookAtPoint();
            this.camera.position.sub(this.controls.target);
            this.controls.target.copy(lookTarget);
            this.camera.position.add(lookTarget);
            this.controls.update();

            if (!this.cam.zoomEnabled) {
                this.cam.updateWithRaycast(
                    this.controls.target,
                    this.cam.playerToCam.subVectors(this.camera.position, this.controls.target).length(),
                    this.cam.maxDist,
                );
            }
        }

        // 掉落重置
        if (this.playerCapsule.position.y < this.boundingBoxMinY - this.playerCapsuleHeight * s * 3 && !this.isFlying) {
            this.reset();
        }

        // 移动端车辆按钮检测
        if (this.isShowMobileControls && this.vehicle.list.length) {
            let near = false;
            for (const veh of this.vehicle.list) {
                this.nearCheckLocal.copy(veh.boardingPoint).multiplyScalar(veh.scale);
                veh.vehicleGroup.localToWorld(this.nearCheckWorld.copy(this.nearCheckLocal));
                if (this.playerCapsule.position.distanceTo(this.nearCheckWorld) < 800 * this.playerModelConfig.scale) { near = true; break; }
            }
            if (near !== this.isNearVehicle) {
                this.isNearVehicle = near;
                this.mobileControls?.syncVehicleBtn(near);
            }
        }
    }

    // ==================== 内部辅助 ====================

    // 同步 debug 可见性
    syncDebugVisibility() {
        if (!this.playerCapsule) return;
        const dbg = this.displayCollider;
        const isVehicle = this.controllerMode === 1;

        // 静态碰撞体：两种模式下都显示
        if (this.collider) {
            if (dbg) { if (!this.scene.children.includes(this.collider)) this.scene.add(this.collider); }
            else this.scene.remove(this.collider);
        }

        // 玩家胶囊线框：步行模式才显示
        (this.playerCapsule.material as THREE.Material).visible = dbg && !isVehicle;

        // 动态碰撞体线框：步行模式才显示
        for (const entry of this.dynamicColliders) {
            if (dbg && !isVehicle) { if (!this.scene.children.includes(entry.mesh)) this.scene.add(entry.mesh); }
            else this.scene.remove(entry.mesh);
        }

        // Rapier 物理调试：车辆模式才开启
        this.vehicle.params.debug.showPhysicsBox = dbg && isVehicle;
        for (const v of this.vehicle.list) {
            if (!v.physicsBoxMesh) continue;
            if (dbg && isVehicle) { if (!v.vehicleGroup.children.includes(v.physicsBoxMesh)) v.vehicleGroup.add(v.physicsBoxMesh); }
            else v.vehicleGroup.remove(v.physicsBoxMesh);
        }
    }

    // 设置落地状态
    setOnGround(val: boolean) {
        if (this.playerIsOnGround === val) return;
        this.playerIsOnGround = val;
        this.onGroundChange?.(val);
    }

    // 应用重力
    private applyGravity(delta: number) {
        this.playerVelocity.y += delta * this.gravity;
        this.playerCapsule.position.addScaledVector(this.playerVelocity, delta);
        this.setOnGround(false);
    }

    // 吸附到地面
    private snapToGround(groundY: number) {
        this.playerVelocity.set(0, 0, 0);
        this.playerCapsule.position.y = THREE.MathUtils.lerp(this.playerCapsule.position.y, groundY, 0.5);
        this.setOnGround(true);
    }

    // 动态修改缩放
    setPlayerScale(newScale: number) {
        if (newScale <= 0) return;
        const ratio = newScale / this.playerModelConfig.scale;
        this.playerModelConfig.scale = newScale;

        // 更新比例相关参数
        this.gravity *= ratio;
        this.jumpHeight *= ratio;
        this.playerSpeed *= ratio;
        this.playerFlySpeed *= ratio;
        this.curPlayerSpeed *= ratio;
        this.cam.epsilon *= ratio;
        this.cam.minDist *= ratio;
        this.cam.maxDist *= ratio;
        this.cam.originMaxDist *= ratio;

        if (this.isFirstPerson) this.scene.attach(this.camera);
        this.playerCapsule?.scale.multiplyScalar(ratio);
        if (this.playerCapsule?.capsuleInfo) {
            this.playerCapsule.capsuleInfo.radius *= ratio;
            this.playerCapsule.capsuleInfo.segment.end.y *= ratio;
        }
        if (this.isFirstPerson) this.cam.setFirstPerson();
    }

    // 重置玩家位置
    reset(position?: THREE.Vector3) {
        if (!this.playerCapsule) return;
        this.playerVelocity.set(0, 0, 0);
        this.playerCapsule.position.copy(position ?? this.initPos);
    }

    // ==================== API ====================

    // 获取当前位置
    getPosition() { return this.playerCapsule?.position; }
    // 获取速度
    getVelocity() { return this.playerVelocity.clone(); }
    // 获取第一人称状态
    getIsFirstPerson() { return this.isFirstPerson; }
    // 获取飞行状态
    getIsFlying() { return this.isFlying; }
    // 获取落地状态
    getIsOnGround() { return this.playerIsOnGround; }
    // 获取控制器模式
    getControllerMode() { return this.controllerMode; }
    // 获取玩家模型
    getPlayerModel() { return this.playerModel; }
    // 获取胶囊体
    getPlayerCapsule() { return this.playerCapsule; }
    // 获取当前载具
    getActiveVehicle() { return this.vehicle.active; }
    // 获取所有载具
    getAllVehicles() { return this.vehicle.list; }
    // 获取碰撞体
    getCollider() { return this.collider; }
    // 获取当前站立的动态碰撞体
    getActiveDynamicCollider() { return this.activeDynamicCollider; }

    // 设置鼠标灵敏度
    setMouseSensitivity(value: number) {
        this.cam.sensitivity = value;
        this.controls.rotateSpeed = value * 0.05;
    }

    // --- 玩家参数 ---
    // 设置重力
    setGravity(gravity: number) { this.gravity = gravity * this.playerModelConfig.scale; }
    // 设置跳跃高度
    setJumpHeight(jumpHeight: number) { this.jumpHeight = jumpHeight * this.playerModelConfig.scale; }
    // 设置行走速度
    setPlayerSpeed(speed: number) { this.playerSpeed = speed * this.playerModelConfig.scale; this.curPlayerSpeed = this.playerSpeed; }
    // 设置飞行速度
    setPlayerFlySpeed(flySpeed: number) { this.playerFlySpeed = flySpeed * this.playerModelConfig.scale; }
    // 设置朝向开关
    setEnableToward(v: boolean) { this.enableToward = v; }

    // --- 相机参数 ---
    // 设置相机最近距
    setMinCamDistance(dist: number) { this.cam.minDist = dist * this.playerModelConfig.scale; }
    // 设置相机最远距
    setMaxCamDistance(dist: number) { this.cam.maxDist = dist * this.playerModelConfig.scale; this.cam.originMaxDist = this.cam.maxDist; }
    // 设置相机看向点高度比例
    setCamLookAtHeightRatio(ratio: number) { this.cam.lookAtHeightRatio = ratio; }
    // 设置鼠标模式
    setThirdMouseMode(mode: 0 | 1 | 2 | 3 | 4 | 5) { this.cam.mouseMode = mode; this.cam.setPointerLock(); }
    // 设置缩放开关
    setEnableZoom(enable: boolean) { this.cam.zoomEnabled = enable; this.controls.enableZoom = enable; }

    // --- 调试 ---
    // 切换调试显示
    setDebug(debug: boolean) {
        this.displayCollider = debug;
        this.syncDebugVisibility();
    }

    // --- 动画 ---
    // 按名播放动画
    playPlayerAnimationByName(name: string, fade?: number) { this.animation.playByName(name, fade); }
    // 注册自定义动画
    registerAnimation(key: string, clipName: string, opts?: Parameters<AnimationSystem["register"]>[2]) { this.animation.register(key, clipName, opts); }
    // 播放已注册动画
    playAnimation(key: string, opts?: Parameters<AnimationSystem["play"]>[1]) { this.animation.play(key, opts); }
    // 注册移动动作组
    registerLocomotionSet(setName: string, map: Parameters<AnimationSystem["registerLocomotionSet"]>[1]) { this.animation.registerLocomotionSet(setName, map); }
    // 切换移动动作组
    switchLocomotionSet(setName: string, fade?: number) { this.animation.switchLocomotionSet(setName, fade); }
    // 获取当前动画名
    getCurrentPlayerAnimationName() { return this.animation.getCurrentName(); }
    // 获取当前移动动作组名
    getCurrentLocomotionSet() { return this.animation.currentLocomotionSet; }

    // --- 相机 ---
    // 切换视角模式
    changeView() { this.cam.changeView(); }
    // 设置第一人称
    setFirstPersonCamera(v = 0) { this.cam.setFirstPerson(v); }
    // 设置指针锁定
    setPointerLock() { this.cam.setPointerLock(); }
    // 设置越肩视角
    setOverShoulderView(v: boolean) { this.cam.setOverShoulder(v); }
    // 屏幕中心检测
    getCenterScreenRaycastHit() { return this.cam.getCenterHit(); }

    // --- 输入 ---
    // 设置输入状态
    setInput(input: Parameters<InputSystem["setInput"]>[0]) { this.input.setInput(input); }
    // 绑定输入事件
    onAllEvent() { this.input.bindEvents(); }
    // 解绑输入事件
    offAllEvent() { this.input.unbindEvents(); }

    // --- 载具 ---
    // 加载车辆模型
    loadVehicleModel(opts: VehicleOptions) { return this.vehicle.load(opts); }

    // --- 销毁 ---
    destroy() {
        this.input.unbindEvents();

        // 清除玩家对象
        if (this.playerCapsule) { this.playerCapsule.remove(this.camera); this.scene.remove(this.playerCapsule); }
        (this.playerCapsule as any) = null;
        if (this.playerModel) { this.scene.remove(this.playerModel); this.playerModel = null; }

        // 清除碰撞体和相机
        this.cam.resetControls();
        if (this.visualizer) { this.scene.remove(this.visualizer); this.visualizer = null; }
        if (this.collider) { this.scene.remove(this.collider); this.collider = null; }
        this.mobileControls?.destroy();
        this.mobileControls = null;

        // 清除动态碰撞体
        this.clearDynamicColliders();

        // 清除所有车辆
        for (const v of this.vehicle.list) { this.scene.remove(v.vehicleGroup); v.pathPlanner?.dispose(); v.vehicleController?.destroy?.(); }
        this.vehicle.list = [];
        this.vehicle.active = null;
    }
}