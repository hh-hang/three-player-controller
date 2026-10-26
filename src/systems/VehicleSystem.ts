import * as THREE from "three";
import type { playerController } from "../PlayerController";
import { loadVehicleModel as loadVehicleModelUtil } from "../utils/vehicleLoader";
import { DEFAULT_MAX_SUSPENSION_TRAVEL, DEFAULT_WHEEL_PHYSICS } from "../utils/vehicleController";
import { applyCapsuleCollision, createCollisionTemps } from "../utils/capsuleCollision";
import type { VehicleInstance, VehicleOptions, KinematicColliderEntry, VehicleWheelColliderUserData } from "../types";
import { CollisionGroup } from "../collision/groups";
import { createObbObbTemps, resolveObbObb } from "../collision/obbObb";

export class VehicleSystem {
    private ctrl: playerController; // 主控制器引用

    list: VehicleInstance[] = []; // 车辆实例列表
    active: VehicleInstance | null = null; // 当前乘坐车辆
    meshSkipIds: number[] = []; // 全部车辆外观 collider id，网格查询时跳过
    vehicleLength = 6; // 车辆模型归一化后的最大边长度
    params = {
        debug: { showPhysicsBox: false, showWheelRays: false, showWheelTravel: false, showWheelSpheres: false }, // 调试显示
        chassis: { density: 1, linearDamping: 0.05, angularDamping: 0.5 }, // 车身参数
        model: { rotation: -Math.PI / 2 }, // 模型旋转
        power: { acceleration: 5, deceleration: 5, maxSpeed: 100 }, // 动力参数
        steering: { maxSteerAngle: Math.PI / 5, steerTime: 0.45, steerReturnTimeSlow: 0.55, steerReturnTimeFast: 0.4, highSpeedSteerScale: 0.3 }, // 转向：打满/回正时间（秒），高速收舵
        grip: {
            maxG: 1.2,
            sideFrictionIdle: 1,
            sideFrictionFrontMin: 0.55,
            sideFrictionRearMin: 0.45,
            handbrakeRearFriction: 0.35,
            handbrakeRearDriveScale: 0.65,
            handbrakeReleaseTime: 0.15,
            wheelbaseRatio: 0.55,
        }, // 抓地预算
        suspension: {
            maxTravel: DEFAULT_MAX_SUSPENSION_TRAVEL,
            stiffness: DEFAULT_WHEEL_PHYSICS.suspensionStiffness,
            compression: DEFAULT_WHEEL_PHYSICS.suspensionCompression,
            relaxation: DEFAULT_WHEEL_PHYSICS.suspensionRelaxation,
            maxForce: DEFAULT_WHEEL_PHYSICS.maxSuspensionForce,
            frictionSlip: DEFAULT_WHEEL_PHYSICS.frictionSlip,
            sideFrictionStiffness: DEFAULT_WHEEL_PHYSICS.sideFrictionStiffness,
            rollInfluence: DEFAULT_WHEEL_PHYSICS.rollInfluence,
        },
        followVehicleDirection: true, // 相机跟随方向
        vehicleDirectionFollowSpeed: 3, // 朝向跟随响应速度，越大越快
    };

    boardingPadding = 0.25; // 上车/下车余量基准值（按车辆 scale 缩放）
    parkingCreepThreshold = 0.05; // 驻车状态下清除低速蠕动的水平速度阈值
    private handbrakeBlend = 0; // 1 为手刹全开，松键后插值回 0

    private scratchLocal = new THREE.Vector3();
    private scratchWorld = new THREE.Vector3();
    private scratchForward = new THREE.Vector3();
    private scratchUp = new THREE.Vector3();
    private scratchQuat = new THREE.Quaternion();
    private scratchDown = new THREE.Vector3(0, -1, 0);
    private wheelSphereDir = new THREE.Vector3();
    private carryPrevInv = new THREE.Matrix4();
    private carryYaw = new THREE.Quaternion();
    private carryUp = new THREE.Vector3(0, 1, 0);
    private raycaster = new THREE.Raycaster();
    private exitCheckTemps = createCollisionTemps();
    private obbTemps = createObbObbTemps();

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
        (this.raycaster as any).firstHitOnly = true;
    }

    /** 切换车辆底盘物理盒。 */
    setPhysicsDebugVisible(visible: boolean): void {
        this.params.debug.showPhysicsBox = visible;
        this.syncDebugVisibility();
    }

    /** 同步全部车辆调试对象的显隐。 */
    syncDebugVisibility(): void {
        for (const v of this.list) {
            if (v.physicsBoxMesh) {
                if (this.params.debug.showPhysicsBox) {
                    if (!v.vehicleGroup.children.includes(v.physicsBoxMesh)) v.vehicleGroup.add(v.physicsBoxMesh);
                } else {
                    v.vehicleGroup.remove(v.physicsBoxMesh);
                }
            }
            if (v.wheelRayDebug) v.wheelRayDebug.visible = this.params.debug.showWheelRays;
            if (v.wheelTravelDebug) v.wheelTravelDebug.visible = this.params.debug.showWheelTravel;
            if (v.wheelSphereDebug) {
                v.wheelSphereDebug.visible = this.params.debug.showWheelSpheres;
                if (v.wheelSphereDebug.visible) this.syncWheelSphereDebug(v);
            }
        }
    }

    /** 由车身水平包围圆和人物胶囊半径推算上车范围。 */
    boardingRadius(v: VehicleInstance): number {
        return Math.hypot(v.halfExtents.x, v.halfExtents.z)
            + this.capsuleRadius()
            + this.boardingPadding * v.scale;
    }

    /** 返回人物到车辆中心的水平距离，高度超出车辆邻域时返回 Infinity。 */
    boardingDistance(v: VehicleInstance, position: THREE.Vector3): number {
        v.vehicleGroup.updateMatrixWorld(true);
        this.scratchLocal.copy(position);
        v.vehicleGroup.worldToLocal(this.scratchLocal);
        const verticalLimit = v.halfExtents.y + this.capsuleHeight();
        if (Math.abs(this.scratchLocal.y) > verticalLimit) return Infinity;
        return Math.hypot(this.scratchLocal.x, this.scratchLocal.z);
    }

    /** 是否处于车辆中心的上车范围内。 */
    isInBoardingRange(v: VehicleInstance, position: THREE.Vector3): boolean {
        return this.boardingDistance(v, position) <= this.boardingRadius(v);
    }

    // 加载车辆模型
    async load(opts: VehicleOptions): Promise<VehicleInstance | undefined> {
        try {
            const instance = await loadVehicleModelUtil(opts, {
                loader: this.ctrl.loader,
                scene: this.ctrl.scene,
                vehicleParams: this.params,
                vehicleLength: this.vehicleLength,
            });

            this.list.push(instance);
            const kin = this.ctrl.addCollider({
                motion: "kinematic",
                shape: { kind: "mesh", source: instance.vehicleGroup },
                follow: instance.vehicleGroup,
            });
            instance.meshColliderId = kin.id;
            const chassis = this.ctrl.addCollider({
                motion: "dynamic",
                shape: { kind: "box", halfExtents: instance.halfExtents.clone() },
                groups: CollisionGroup.VEHICLE,
                mask: CollisionGroup.DEFAULT | CollisionGroup.VEHICLE | CollisionGroup.DEBRIS,
                userData: instance,
                simulate: false, // 默认会建 DynamicBoxBody；底盘改由 VehicleRigidBody 推进，此处只登记
            });
            instance.chassisColliderId = chassis.id;
            instance.wheelColliderIds = this.registerWheelSpheres(instance);
            this.attachWheelSphereDebug(instance);
            return instance;
        } catch (e) {
            console.error("加载车辆模型失败:", e);
            return undefined;
        }
    }

    // 触发上车流程
    enter() {
        if (!this.list.length || this.ctrl.controllerMode === 1) return;

        // 查找最近可上车的车辆
        let nearest: VehicleInstance | null = null;
        let nearestDist = Infinity;
        const pos = this.ctrl.playerCapsule.position;
        for (const v of this.list) {
            const dist = this.boardingDistance(v, pos);
            if (dist <= this.boardingRadius(v) && dist < nearestDist) {
                nearestDist = dist;
                nearest = v;
            }
        }

        if (!nearest) return;
        // 车辆移动中不允许上车
        const vel = nearest.chassisBody.linvel();
        if (Math.hypot(vel.x, vel.z) > 0.1) return;
        this.releaseParkingBrake(nearest);
        this.active = nearest;
        const c = this.ctrl;
        c.controllerMode = 1;
        c.playerVelocity.set(0, 0, 0);
        c.activeDynamicBody = null;
        c.mobileControls?.syncControllerModeBtn(1);
        c.cam.setOverShoulder(false);
        c.animation.playByName("driving");
        c.syncMountedPlayer(nearest);
        c.syncDebugVisibility();
        c.onVehicleEnter?.(nearest);
    }

    // 触发下车流程
    exit() {
        const c = this.ctrl;
        const v = this.active;
        if (!v) return;

        this.applyParkingBrake(v, c.getCurrentDelta() || 1 / 60);
        this.findExitPosition(v, this.scratchWorld);
        this.getDriverForward(v, this.scratchForward);
        c.controllerMode = 0;
        c.mobileControls?.syncControllerModeBtn(0);
        c.cam.setOverShoulder(c.enableOverShoulderView);
        c.leaveVehicleAt(this.scratchWorld, this.scratchForward);
        c.animation.playByName("idle");
        c.syncDebugVisibility();
        this.handbrakeBlend = 0;
        c.onVehicleExit?.(v);
    }

    // 物理步进前更新车辆控制器
    preparePhysics(delta: number) {
        if (this.ctrl.controllerMode === 1 && this.active) this.applyDriving(delta, this.active);
    }

    // 物理步进后同步车辆视觉
    finishPhysics(delta: number) {
        for (const v of this.list) {
            const parked = this.ctrl.controllerMode !== 1 || this.active !== v;
            if (parked) this.applyParkingBrake(v, delta);
            v.vehicleController.updateVehicle(delta, this.ctrl.getVehicleGroundMeshes(v));
            this.applyKinematicCarry(v);
        }
        this.resolveVehiclePairs();
        for (const v of this.list) {
            const parked = this.ctrl.controllerMode !== 1 || this.active !== v;
            const vel = v.chassisBody.linvel();
            const speed = Math.hypot(vel.x, vel.z);
            const max = v.maxSpeed / 3.6;
            if (speed > max) {
                const s = max / speed;
                v.chassisBody.setLinvel({ x: vel.x * s, y: vel.y, z: vel.z * s });
            } else if (parked && speed > 0 && speed <= this.parkingCreepThreshold) {
                let hasWheelContact = false;
                for (let i = 0; i < v.vehicleController.numWheels(); i++) {
                    if (v.vehicleController.wheelIsInContact(i)) { hasWheelContact = true; break; }
                }
                if (hasWheelContact) v.chassisBody.setLinvel({ x: 0, y: vel.y, z: 0 });
            }
            this.syncVehicleVisual(v, delta);
        }
        if (this.ctrl.controllerMode === 1 && this.active) this.ctrl.syncMountedPlayer(this.active);
    }

    /** 两车底盘盒对盒：跳过自身，驻车中的车仍可被撞开。 */
    private resolveVehiclePairs() {
        const n = this.list.length;
        if (n < 2) return;
        for (let iter = 0; iter < 2; iter++) {
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    resolveObbObb(this.list[i].chassisBody, this.list[j].chassisBody, this.obbTemps);
                }
            }
        }
    }

    // 更新车辆驾驶
    private applyDriving(delta: number, v: VehicleInstance) {
        const c = this.ctrl;
        const { vehicleController, chassisBody } = v;

        // 坡度补偿
        const rotation = chassisBody.rotation();
        this.scratchQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
        const forward = this.scratchForward.copy(v.forwardLocal).applyQuaternion(this.scratchQuat);
        const throttle = Number(c.input.fwd) - Number(c.input.bkd);
        const sinTheta = Math.max(-1, Math.min(1, forward.y));
        const gEff = 9.81 * v.scale;
        const extraAccel = (throttle * sinTheta > 0.05) ? Math.abs(sinTheta) * gEff : 0;
        const wheelCount = Math.max(1, vehicleController.numWheels());
        const mass = chassisBody.mass();
        const linv = chassisBody.linvel();
        const speed01 = Math.min(1, Math.hypot(linv.x, linv.z) / Math.max(0.01, v.maxSpeed / 3.6));

        // 转向：参数为走完满舵行程的时间（秒）；车速越高可用转角越小
        const { maxSteerAngle, steerTime, steerReturnTimeSlow, steerReturnTimeFast, highSpeedSteerScale = 0.3 } = v.steering;
        const currentSteering = vehicleController.wheelSteering(0) || 0;
        const steerDir = Number(c.input.lft) - Number(c.input.rgt);
        const speedSteer = 1 - (1 - highSpeedSteerScale) * speed01 * speed01;
        const steerLimit = maxSteerAngle * speedSteer;
        const targetSteering = steerLimit * steerDir;
        const responseTime = steerDir === 0
            ? steerReturnTimeSlow + (steerReturnTimeFast - steerReturnTimeSlow) * speed01
            : steerTime;
        const maxStep = Math.max(steerLimit, 1e-4) / Math.max(1e-4, responseTime) * delta;
        const steeringDelta = targetSteering - currentSteering;
        const steering = currentSteering + Math.sign(steeringDelta) * Math.min(Math.abs(steeringDelta), maxStep);
        vehicleController.setWheelSteering(0, steering);
        vehicleController.setWheelSteering(1, steering);

        // 抓地预算
        const { maxG, sideFrictionIdle, sideFrictionFrontMin, sideFrictionRearMin, handbrakeRearFriction, handbrakeRearDriveScale, handbrakeReleaseTime, wheelbaseRatio } = v.grip;
        const vFwd = linv.x * forward.x + linv.y * forward.y + linv.z * forward.z;
        const wheelbase = Math.max(0.01, v.size.l * wheelbaseRatio);
        const latA = vFwd * vFwd * Math.tan(Math.min(1.5, Math.abs(steering))) / wheelbase;
        const latG = Math.min(maxG, latA / gEff);
        const engineForce = throttle * mass * (v.acceleration + extraAccel) / wheelCount;

        // Shift 漂移：降后轮侧向摩擦甩尾，保留部分后驱维持车速，不额外后轮制动
        if (c.input.shift) this.handbrakeBlend = 1;
        else if (this.handbrakeBlend > 0) {
            this.handbrakeBlend = Math.max(0, this.handbrakeBlend - delta / Math.max(1e-4, handbrakeReleaseTime));
        }
        const rearDriveScale = 1 - this.handbrakeBlend * (1 - handbrakeRearDriveScale);
        for (let i = 0; i < wheelCount; i++) {
            vehicleController.setWheelEngineForce(i, i >= 2 ? engineForce * rearDriveScale : engineForce);
        }

        const spaceBrake = Number(c.input.space) * mass * v.deceleration / wheelCount * delta;
        for (let i = 0; i < wheelCount; i++) {
            vehicleController.setWheelBrake(i, spaceBrake);
        }

        const gripUsed = latG / maxG;
        const frontFriction = sideFrictionIdle + (sideFrictionFrontMin - sideFrictionIdle) * gripUsed;
        const gripRearFriction = sideFrictionIdle + (sideFrictionRearMin - sideFrictionIdle) * gripUsed;
        const rearFriction = gripRearFriction + (handbrakeRearFriction - gripRearFriction) * this.handbrakeBlend;
        vehicleController.setWheelSideFrictionStiffness(0, frontFriction);
        vehicleController.setWheelSideFrictionStiffness(1, frontFriction);
        vehicleController.setWheelSideFrictionStiffness(2, rearFriction);
        vehicleController.setWheelSideFrictionStiffness(3, rearFriction);
    }

    // 翻车复位
    resetUpright() {
        const v = this.active;
        if (!v || this.ctrl.controllerMode !== 1) return;
        const { chassisBody } = v;
        const t = chassisBody.translation();
        chassisBody.setTranslation({ x: t.x, y: t.y + v.size.h, z: t.z });
        chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 });
        chassisBody.setLinvel({ x: 0, y: 0, z: 0 });
        chassisBody.setAngvel({ x: 0, y: 0, z: 0 });
        this.handbrakeBlend = 0;
    }

    // 计算车身外侧的可用下车位置
    private findExitPosition(v: VehicleInstance, out: THREE.Vector3): THREE.Vector3 {
        v.vehicleGroup.updateMatrixWorld(true);
        this.scratchLocal.copy(v.driverSeatPosition).multiplyScalar(v.scale);
        const seatX = Math.max(-v.halfExtents.x, Math.min(v.halfExtents.x, this.scratchLocal.x));
        const side = this.scratchLocal.z >= 0 ? 1 : -1;
        const clearance = this.capsuleRadius() + this.boardingPadding * v.scale;
        const sideOffset = v.halfExtents.z + clearance;
        const endOffset = v.halfExtents.x + clearance;
        const candidates = [
            { x: seatX, z: side * sideOffset },
            { x: seatX, z: -side * sideOffset },
            { x: endOffset, z: 0 },
            { x: -endOffset, z: 0 },
        ];
        let groundedFallback: THREE.Vector3 | null = null;
        const maxDist = v.size.h + this.capsuleHeight() * 3 + 2;
        this.raycaster.far = maxDist;

        for (const candidate of candidates) {
            this.scratchLocal.set(candidate.x, v.halfExtents.y + this.capsuleHeight() + 0.5, candidate.z);
            v.vehicleGroup.localToWorld(this.scratchLocal);
            out.copy(this.scratchLocal);
            this.raycaster.set(out, this.scratchDown);
            let bestHit: THREE.Intersection | undefined;
            for (const mesh of this.ctrl.getColliderMeshes()) {
                const hits = this.raycaster.intersectObject(mesh, false);
                if (hits.length && (!bestHit || hits[0].distance < bestHit.distance)) {
                    bestHit = hits[0];
                }
            }
            if (!bestHit) continue;
            out.copy(bestHit.point);
            out.y += this.ctrl.getCapsuleGroundHeight();
            groundedFallback ??= out.clone();
            if (this.isCharacterPositionFree(out, v)) return out;
        }

        if (groundedFallback) return out.copy(groundedFallback);
        this.scratchLocal.set(seatX, -v.halfExtents.y + this.ctrl.getCapsuleGroundHeight(), side * sideOffset);
        v.vehicleGroup.localToWorld(this.scratchLocal);
        return out.copy(this.scratchLocal);
    }

    /** 检测下车点处胶囊是否与静态/其他运动学碰撞体重叠。 */
    private isCharacterPositionFree(position: THREE.Vector3, v: VehicleInstance): boolean {
        const cap = this.ctrl.playerCapsule;
        const info = cap.capsuleInfo;
        if (!info || !this.ctrl.getColliderMeshes().length) return true;

        const origParent = cap.parent;
        const origPos = cap.position.clone();
        const origQuat = cap.quaternion.clone();
        const skipMesh = this.ctrl.getKinematicColliderEntries().find(e => e.source === v.vehicleGroup)?.mesh;
        this.ctrl.scene.attach(cap);
        cap.position.copy(position);
        cap.updateMatrixWorld(true);
        const before = position.clone();
        for (const mesh of this.ctrl.getColliderMeshes()) {
            if (mesh === skipMesh) continue;
            cap.updateMatrixWorld(true);
            applyCapsuleCollision(cap, info, mesh, this.exitCheckTemps);
        }
        const free = cap.position.distanceTo(before) < info.radius * 0.5;
        origParent?.attach(cap);
        cap.position.copy(origPos);
        cap.quaternion.copy(origQuat);
        cap.updateMatrixWorld(true);
        return free;
    }

    /** 有轮子打在运动学网格上时，按平台 prev→current 带走车身。 */
    private applyKinematicCarry(v: VehicleInstance) {
        const votes = new Map<KinematicColliderEntry, number>();
        const n = v.vehicleController.numWheels();
        for (let i = 0; i < n; i++) {
            const mesh = v.vehicleController.wheelContactMesh(i);
            if (!mesh) continue;
            const entry = this.ctrl.getKinematicColliderEntries().find(e => e.mesh === mesh);
            if (!entry) continue;
            votes.set(entry, (votes.get(entry) ?? 0) + 1);
        }

        let best: KinematicColliderEntry | null = null;
        let bestCount = 0;
        for (const [entry, count] of votes) {
            if (count > bestCount) {
                best = entry;
                bestCount = count;
            }
        }
        if (!best) return;

        this.carryPrevInv.copy(best.prevWorldMatrix).invert();
        this.scratchWorld.copy(v.chassisBody.position).applyMatrix4(this.carryPrevInv);
        v.chassisBody.position.copy(this.scratchWorld).applyMatrix4(best.source.matrixWorld);
        if (best.deltaRotY !== 0) {
            this.carryYaw.setFromAxisAngle(this.carryUp, best.deltaRotY);
            v.chassisBody.quaternion.premultiply(this.carryYaw);
        }
    }

    // 同步单辆车的模型、车轮和调试盒
    private syncVehicleVisual(v: VehicleInstance, delta = 1 / 60) {
        const t = v.chassisBody.translation();
        const r = v.chassisBody.rotation();
        v.vehicleGroup.position.set(t.x, t.y, t.z);
        v.vehicleGroup.quaternion.set(r.x, r.y, r.z, r.w);
        if (v.wheelRayDebug) v.wheelRayDebug.visible = this.params.debug.showWheelRays;
        if (v.wheelTravelDebug) v.wheelTravelDebug.visible = this.params.debug.showWheelTravel;
        if (v.wheelSphereDebug) {
            v.wheelSphereDebug.visible = this.params.debug.showWheelSpheres;
            if (v.wheelSphereDebug.visible) this.syncWheelSphereDebug(v);
        }
        v.updateWheelVisuals?.(delta);
    }

    /** 取车辆世界前向。 */
    getForward(v: VehicleInstance, out = new THREE.Vector3()): THREE.Vector3 {
        v.vehicleGroup.updateMatrixWorld(true);
        return out.copy(v.forwardLocal).transformDirection(v.vehicleGroup.matrixWorld).normalize();
    }

    /** 取驾驶位世界前向。 */
    getDriverForward(v: VehicleInstance, out = new THREE.Vector3()): THREE.Vector3 {
        this.scratchQuat.setFromAxisAngle(this.scratchUp.set(0, 1, 0), v.driverSeatRotation);
        this.scratchLocal.set(0, 0, -1).applyQuaternion(this.scratchQuat);
        v.vehicleGroup.updateMatrixWorld(true);
        return out.copy(this.scratchLocal).transformDirection(v.vehicleGroup.matrixWorld).normalize();
    }

    /** 取车辆世界上向。 */
    getUp(v: VehicleInstance, out = new THREE.Vector3()): THREE.Vector3 {
        v.vehicleGroup.updateMatrixWorld(true);
        return out.set(0, 1, 0).transformDirection(v.vehicleGroup.matrixWorld).normalize();
    }

    /**
     * 为每只车轮登记只碰 DEBRIS 的运动学球。
     * 球心每帧由底盘位姿 + 悬挂长度推算，不在此写位置。
     */
    private registerWheelSpheres(v: VehicleInstance): number[] {
        const ids: number[] = [];
        const n = v.vehicleController.numWheels();
        for (let i = 0; i < n; i++) {
            const wheel = v.vehicleController.wheelAt(i);
            if (!wheel) continue;
            const userData: VehicleWheelColliderUserData = { vehicle: v, wheelIndex: i };
            const handle = this.ctrl.addCollider({
                motion: "kinematic",
                shape: { kind: "sphere", radius: Math.max(1e-4, wheel.radius) },
                groups: CollisionGroup.VEHICLE,
                mask: CollisionGroup.DEBRIS,
                userData,
            });
            ids.push(handle.id);
        }
        return ids;
    }

    /** 创建车轮碰撞球线框，挂在 vehicleGroup 下（底盘局部坐标）。 */
    private attachWheelSphereDebug(v: VehicleInstance): void {
        const group = new THREE.Group();
        group.name = "wheelSphereDebug";
        group.userData.excludeFromCollider = true;
        const geo = new THREE.SphereGeometry(1, 16, 12);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x00e8a0,
            wireframe: true,
            transparent: true,
            opacity: 0.45,
        });
        const n = v.vehicleController.numWheels();
        for (let i = 0; i < n; i++) {
            const wheel = v.vehicleController.wheelAt(i);
            if (!wheel) continue;
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = `wheelSphereDebug_${i}`;
            mesh.frustumCulled = false;
            mesh.renderOrder = 22;
            mesh.scale.setScalar(Math.max(1e-4, wheel.radius));
            group.add(mesh);
        }
        group.visible = this.params.debug.showWheelSpheres;
        v.vehicleGroup.add(group);
        v.wheelSphereDebug = group;
        this.syncWheelSphereDebug(v);
    }

    /** 按悬挂长度把轮球线框对齐到轮心（底盘局部）。 */
    private syncWheelSphereDebug(v: VehicleInstance): void {
        const group = v.wheelSphereDebug;
        if (!group) return;
        let meshIndex = 0;
        const n = v.vehicleController.numWheels();
        for (let i = 0; i < n; i++) {
            const wheel = v.vehicleController.wheelAt(i);
            const mesh = group.children[meshIndex] as THREE.Mesh | undefined;
            if (!wheel || !mesh) continue;
            meshIndex++;
            this.wheelSphereDir.copy(wheel.direction);
            const dirLen = this.wheelSphereDir.length();
            if (dirLen > 1e-8) this.wheelSphereDir.multiplyScalar(1 / dirLen);
            else this.wheelSphereDir.set(0, -1, 0);
            mesh.position.copy(wheel.connectionPoint).addScaledVector(this.wheelSphereDir, wheel.suspensionLength);
            mesh.scale.setScalar(Math.max(1e-4, wheel.radius));
        }
    }

    /** 移除车轮碰撞球调试线框并释放几何 / 材质。 */
    private disposeWheelSphereDebug(v: VehicleInstance): void {
        const group = v.wheelSphereDebug;
        if (!group) return;
        group.removeFromParent();
        const geos = new Set<THREE.BufferGeometry>();
        const mats = new Set<THREE.Material>();
        for (const child of group.children) {
            const mesh = child as THREE.Mesh;
            if (mesh.geometry) geos.add(mesh.geometry);
            const mat = mesh.material;
            if (Array.isArray(mat)) for (const m of mat) mats.add(m);
            else if (mat) mats.add(mat);
        }
        for (const g of geos) g.dispose();
        for (const m of mats) m.dispose();
        v.wheelSphereDebug = undefined;
    }

    // 销毁全部车辆
    destroy() {
        for (const v of this.list) {
            if (v.meshColliderId != null) this.ctrl.removeCollider(v.meshColliderId);
            if (v.chassisColliderId != null) this.ctrl.removeCollider(v.chassisColliderId);
            for (const id of v.wheelColliderIds ?? []) this.ctrl.removeCollider(id);
            this.disposeWheelSphereDebug(v);
            this.ctrl.scene.remove(v.vehicleGroup);
            v.destroyVehicleController?.();
        }
        this.list = [];
        this.active = null;
    }

    // 清除活动车辆的驱动力
    stopActive() {
        if (this.active) {
            this.applyParkingBrake(this.active, this.ctrl.getCurrentDelta() || 1 / 60);
        }
    }

    // 对无人车辆施加四轮驻车制动
    private applyParkingBrake(v: VehicleInstance, delta: number) {
        const wheelCount = Math.max(1, v.vehicleController.numWheels());
        const brake = v.chassisBody.mass() * v.deceleration / wheelCount * delta;
        for (let i = 0; i < wheelCount; i++) {
            v.vehicleController.setWheelEngineForce(i, 0);
            v.vehicleController.setWheelBrake(i, brake);
            v.vehicleController.setWheelSideFrictionStiffness(i, v.sideFrictionStiffness);
        }
    }

    /**
     * 运行时修改底盘盒底相对轮胎触地点的高度。
     * 重定底盘中心的同时反向平移车模和车轮，使车辆外观及轮胎触地点保持原位。
     */
    setClearance(v: VehicleInstance, clearance: number): void {
        if (!v || !Number.isFinite(clearance) || v.scale <= 0) return;

        const sy = Math.max(1e-3, v.chassisSizeScaleY);
        const minHeight = 1e-3;
        const maxClearance = Math.max(
            0,
            v.chassisTopClearance - minHeight / (v.scale * sy),
        );
        const nextClearance = THREE.MathUtils.clamp(clearance, 0, maxClearance);
        const previousClearance = v.chassisClearance;
        if (Math.abs(nextClearance - previousClearance) < 1e-8) return;

        const oldHalfY = v.halfExtents.y;
        const newHalfY = Math.max(
            minHeight * 0.5,
            (v.chassisTopClearance - nextClearance) * v.scale * sy * 0.5,
        );
        // 底盘中心相对轮胎触地点的位置 = clearance + 碰撞盒半高。
        const centerShift = (nextClearance - previousClearance) * v.scale
            + (newHalfY - oldHalfY);

        const nextHalfExtents = v.halfExtents.clone();
        nextHalfExtents.y = newHalfY;
        v.chassisClearance = nextClearance;
        this.applyChassisShape(v, nextHalfExtents, centerShift);
    }

    /** 运行时修改底盘碰撞盒三轴尺寸比例；Y 轴仍以盒底为缩放锚点。 */
    setChassisSizeScale(
        v: VehicleInstance,
        sizeScale: { x?: number; y?: number; z?: number },
    ): void {
        if (!v || v.scale <= 0) return;

        const oldSx = Math.max(1e-3, v.chassisSizeScaleX);
        const oldSy = Math.max(1e-3, v.chassisSizeScaleY);
        const oldSz = Math.max(1e-3, v.chassisSizeScaleZ);
        const sx = Math.max(1e-3, sizeScale.x ?? oldSx);
        const sy = Math.max(1e-3, sizeScale.y ?? oldSy);
        const sz = Math.max(1e-3, sizeScale.z ?? oldSz);
        if (
            Math.abs(sx - oldSx) < 1e-8
            && Math.abs(sy - oldSy) < 1e-8
            && Math.abs(sz - oldSz) < 1e-8
        ) return;

        const nextHalfExtents = new THREE.Vector3(
            v.halfExtents.x / oldSx * sx,
            Math.max(
                5e-4,
                (v.chassisTopClearance - v.chassisClearance) * v.scale * sy * 0.5,
            ),
            v.halfExtents.z / oldSz * sz,
        );
        const centerShift = nextHalfExtents.y - v.halfExtents.y;
        v.chassisSizeScaleX = sx;
        v.chassisSizeScaleY = sy;
        v.chassisSizeScaleZ = sz;
        this.applyChassisShape(v, nextHalfExtents, centerShift);
    }

    /** 同步底盘尺寸、车轮硬点、视觉原点和两套碰撞表示。 */
    private applyChassisShape(
        v: VehicleInstance,
        nextHalfExtents: THREE.Vector3,
        centerShift: number,
    ): void {
        const shiftsCenter = Math.abs(centerShift) >= 1e-8;

        if (shiftsCenter) {
            for (const child of v.vehicleGroup.children) {
                if (
                    child === v.physicsBoxMesh
                    || child === v.wheelRayDebug
                    || child === v.wheelTravelDebug
                    || child === v.wheelSphereDebug
                    || child === this.ctrl.playerCapsule
                ) continue;
                child.position.y -= centerShift;
            }

            const wheelCount = v.vehicleController.numWheels();
            for (let i = 0; i < wheelCount; i++) {
                const wheel = v.vehicleController.wheelAt(i);
                if (!wheel) continue;
                this.scratchLocal.copy(wheel.connectionPoint);
                this.scratchLocal.y -= centerShift;
                v.vehicleController.setWheelChassisConnectionPointCs(i, this.scratchLocal);
            }

            v.driverSeatPosition.y -= centerShift / v.scale;

            // 移动底盘中心以抵消本地内容位移，车身与轮胎在世界空间保持不动。
            this.scratchUp.set(0, centerShift, 0).applyQuaternion(v.chassisBody.quaternion);
            v.chassisBody.position.add(this.scratchUp);
            v.vehicleGroup.position.copy(v.chassisBody.position);
            v.vehicleGroup.quaternion.copy(v.chassisBody.quaternion);
            v.vehicleGroup.updateMatrixWorld(true);

            this.ctrl.translateKinematicColliderContent(
                v.vehicleGroup,
                this.scratchLocal.set(0, -centerShift, 0),
            );
        }

        v.halfExtents.copy(nextHalfExtents);
        v.chassisBody.setHalfExtents(v.halfExtents);

        const chassisCol = v.chassisColliderId != null
            ? this.ctrl.collisionWorld.get(v.chassisColliderId)
            : undefined;
        if (chassisCol?.shape.kind === "box") {
            chassisCol.shape.halfExtents.copy(v.halfExtents);
        }

        if (v.physicsBoxMesh) {
            v.physicsBoxMesh.geometry.dispose();
            v.physicsBoxMesh.geometry = new THREE.BoxGeometry(
                v.halfExtents.x * 2,
                v.halfExtents.y * 2,
                v.halfExtents.z * 2,
            );
            v.physicsBoxMesh.scale.set(1, 1, 1);
        }
        if (v.wheelSphereDebug) this.syncWheelSphereDebug(v);
        if (this.active === v && this.ctrl.controllerMode === 1) {
            this.ctrl.syncMountedPlayer(v);
        }
    }

    // 解除四轮驻车制动
    private releaseParkingBrake(v: VehicleInstance) {
        for (let i = 0; i < v.vehicleController.numWheels(); i++) v.vehicleController.setWheelBrake(i, 0);
    }

    /**
     * 运行时等比缩放车辆。
     * 保持 vehicleGroup.scale = 1，只缩放子节点与物理尺寸，避免座椅/下车点与 halfExtents 双重缩放。
     * 悬挂刚度、阻尼、摩擦滑移不随 scale 变。
     */
    setScale(v: VehicleInstance, newScale: number): void {
        if (!v || newScale <= 0) return;
        const prev = v.scale > 0 ? v.scale : 1;
        const ratio = newScale / prev;
        if (Math.abs(ratio - 1) < 1e-12) {
            v.scale = newScale;
            return;
        }

        const { chassisBody, vehicleController } = v;
        const n = vehicleController.numWheels();

        // 缩放前用局部轮底估算，缩放后抬/降底盘使胎底高度基本不变
        let localBottom = Infinity;
        for (let i = 0; i < n; i++) {
            const wheel = vehicleController.wheelAt(i);
            if (!wheel) continue;
            localBottom = Math.min(localBottom, wheel.connectionPoint.y - wheel.radius);
        }
        if (!Number.isFinite(localBottom)) localBottom = -v.halfExtents.y;

        for (const child of v.vehicleGroup.children) {
            if (child === v.wheelRayDebug || child === v.wheelTravelDebug || child === v.wheelSphereDebug) continue;
            child.position.multiplyScalar(ratio);
            child.scale.multiplyScalar(ratio);
        }

        v.halfExtents.multiplyScalar(ratio);
        v.size.l *= ratio;
        v.size.w *= ratio;
        v.size.h *= ratio;
        v.maxSpeed *= ratio;
        v.acceleration *= ratio;
        v.deceleration *= ratio;
        v.scale = newScale;

        chassisBody.setHalfExtents(v.halfExtents);
        chassisBody.setMass(chassisBody.mass() * ratio * ratio * ratio);
        chassisBody.gravityScale = newScale;
        chassisBody.linearVelocity.multiplyScalar(ratio);

        for (let i = 0; i < n; i++) {
            const wheel = vehicleController.wheelAt(i);
            if (!wheel) continue;
            vehicleController.setWheelChassisConnectionPointCs(i, wheel.connectionPoint.multiplyScalar(ratio));
            vehicleController.setWheelRadius(i, wheel.radius * ratio);
            vehicleController.setWheelSuspensionRestLength(i, wheel.restLength * ratio);
            vehicleController.setWheelMaxSuspensionTravel(i, wheel.maxSuspensionTravel * ratio);
            wheel.suspensionLength *= ratio;
            wheel.visualLength *= ratio;
        }

        const chassisCol = v.chassisColliderId != null
            ? this.ctrl.collisionWorld.get(v.chassisColliderId)
            : undefined;
        if (chassisCol?.shape.kind === "box") {
            chassisCol.shape.halfExtents.copy(v.halfExtents);
        }

        for (const id of v.wheelColliderIds ?? []) {
            const col = this.ctrl.collisionWorld.get(id);
            if (col?.shape.kind !== "sphere") continue;
            const data = col.userData as VehicleWheelColliderUserData | undefined;
            const wheel = data != null ? v.vehicleController.wheelAt(data.wheelIndex) : undefined;
            if (wheel) col.shape.radius = Math.max(1e-4, wheel.radius);
        }

        if (v.wheelSphereDebug) this.syncWheelSphereDebug(v);

        // 外观 mesh 碰撞在加载时烘焙，用 contentScale 对齐子节点缩放
        this.ctrl.scaleKinematicColliderContent(v.vehicleGroup, ratio);

        chassisBody.position.y += localBottom * (1 - ratio);
        v.vehicleGroup.position.copy(chassisBody.position);
        v.vehicleGroup.quaternion.copy(chassisBody.quaternion);
        v.vehicleGroup.updateMatrixWorld(true);

        if (this.active === v && this.ctrl.controllerMode === 1) {
            this.ctrl.syncMountedPlayer(v);
        }
    }

    /** 将列表中全部车辆缩放到同一绝对 scale。 */
    setScaleAll(newScale: number): void {
        for (const v of this.list) this.setScale(v, newScale);
    }

    private capsuleRadius(): number {
        return this.ctrl.playerCapsule?.capsuleInfo?.radius ?? 0;
    }

    private capsuleHeight(): number {
        const info = this.ctrl.playerCapsule?.capsuleInfo;
        if (!info) return 0;
        const sy = this.ctrl.playerCapsule.scale.y || 1;
        return (-info.segment.end.y) * sy + 2 * info.radius;
    }
}
