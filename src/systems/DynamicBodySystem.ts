import * as THREE from "three";
import { ExtendedTriangle } from "three-mesh-bvh";
import type { playerController } from "../PlayerController";
import { CollisionGroup } from "../collision/groups";
import { ContactCache } from "../collision/contacts/ContactCache";
import { ContactManifold } from "../collision/contacts/ContactManifold";
import { contactSkinForExtent, type RawContact } from "../collision/contacts/ContactPoint";
import { reduceContacts } from "../collision/contacts/contactReducer";
import { ContactImpulseSolver } from "../collision/solver/ContactImpulseSolver";
import { DynamicBody, type DynamicBodyKind } from "../collision/DynamicBody";
import {
    collectSphereVsMeshContacts,
    collideSphereVsObb,
    createSphereCollisionTemps,
    resolveSphereSphere,
    DynamicSphereBody,
    isSphereBody,
} from "../collision/DynamicSphere";
import {
    capsuleObbOverlap,
    DynamicBoxBody,
    isBoxBody,
} from "../collision/DynamicBox";
import { DYNAMIC_BODY_DEFAULTS, type DynamicColliderDesc } from "../collision/colliderDesc";
import type { VehicleInstance, VehicleWheelColliderUserData } from "../types";
import {
    capsuleSphereOverlap,
    createCollisionTemps,
    createGroundProbeQuery,
    resetGroundProbeQuery,
    tryGroundProbeCandidate,
    tryGroundProbeTriangle,
} from "../utils/capsuleCollision";
import { VehicleCollision } from "../utils/vehiclePhysics/VehicleCollision";
import { createObbObbTemps, resolveObbObb } from "../collision/obbObb";

const TARGET_SUB_DT = 1 / 1200; // 目标子步时长（秒）
const MAX_SUBSTEPS = 20; // 单帧最多子步数
const MAX_PUSH_RATIO = 2; // 单次位置修正不超过特征尺寸的倍数
const MAX_SPEED_GRAVITY = 2; // 速度上限相对 |gravity| 的倍数
const CHARACTER_PUSH_MASS = 10; // 推动态体时用的人物假质量（scale = 1 时）。
const MAX_RAW = 64; // 单体单帧原始接触上限
const POS_CORRECT = 0.4; // 求解后残留穿透的位置修正比例
const MAX_DEPENETRATION_EXTENTS = 20; // 位置修正每秒最多推出的特征尺寸倍数
const ROLL_BLEND = 0.45; // 支撑面上向无滑滚动收敛的插值比例
const SUPPORT_Y = 0.5; // 视为支撑面的法线 y 下限
const DYNAMIC_MASK = CollisionGroup.DEFAULT | CollisionGroup.VEHICLE | CollisionGroup.DEBRIS;
const KIN_CAPSULE_BAUMGARTE = 0.8; // 动态体撞运动学胶囊时的位置修正比例
/** 人物单次相对动态体的最大位置修正（相对胶囊半径）。 */
const CHAR_SEP_MAX_RADIUS = 1.25;
const SLEEP_LINEAR = 0.3; // 线速度低于该值可累计休眠
const SLEEP_ANGULAR = 0.7; // 角速度低于该值可累计休眠
const SLEEP_TIME = 0.35; // 连续满足阈值后进入休眠（秒）
const SLEEP_WAKE_FACTOR = 3; // 超过阈值该倍数才清零休眠计时（迟滞）
const BROADPHASE_CELL_SCALE = 2; // 动态体互撞宽相位：XZ 网格单元 = 最大特征尺寸 × 该系数（下限 1）。
const BOX_TRIANGLES = [
    0, 2, 3, 0, 3, 1,
    4, 5, 7, 4, 7, 6,
    0, 4, 6, 0, 6, 2,
    1, 3, 7, 1, 7, 5,
    0, 1, 5, 0, 5, 4,
    2, 6, 7, 2, 7, 3,
] as const;

/** 人物向下查询命中的动态支撑面。 */
export type DynamicGroundHit = {
    body: DynamicBody;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    velocity: THREE.Vector3;
};

/**
 * 动态刚体推进：按 kind 分派形状窄相（球 / 盒）。
 * 网格接触走 ContactImpulseSolver；球–球 / 盒–盒 / 与人 / 与车用简化或 OBB 冲量。
 */
export class DynamicBodySystem {
    private ctrl: playerController;
    list: DynamicBody[] = []; // 全部动态刚体
    /** 动态刚体碰撞线框开关。 */
    private debugVisible = false;
    private temps = createSphereCollisionTemps();
    private carryPrevInv = new THREE.Matrix4();
    private skipVehicleMeshes: number[] = []; // 跳过车辆外观，避免与底盘盒重复
    private capsuleTemps = createCollisionTemps();
    private contactSolver = new ContactImpulseSolver();
    private contactCaches = new Map<DynamicBody, ContactCache>();
    private raw: RawContact[] = Array.from({ length: MAX_RAW }, () => ({
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        penetration: 0,
    }));
    private manifolds: ContactManifold[] = [];
    private bodyVel = new THREE.Vector3();
    private rollTarget = new THREE.Vector3();
    private boxMeshCollision = new VehicleCollision();
    private obbTemps = createObbObbTemps();
    private contactPoint = new THREE.Vector3();
    private wheelCenter = new THREE.Vector3();
    private wheelDir = new THREE.Vector3();
    private wheelPosBefore = new THREE.Vector3();
    /** 动态体互撞宽相位（XZ 网格，每子步重建）。 */
    private broadphaseGrid = new Map<string, number[]>();
    private broadphaseCellSize = 1;
    private bodyAabbMin: THREE.Vector3[] = [];
    private bodyAabbMax: THREE.Vector3[] = [];
    private broadphaseAxisX = new THREE.Vector3();
    private broadphaseAxisY = new THREE.Vector3();
    private broadphaseAxisZ = new THREE.Vector3();
    private broadphasePairSeen = new Set<number>();
    private groundRay = new THREE.Ray();
    private groundBox = new THREE.Box3();
    private groundSphere = new THREE.Sphere();
    private groundOriginLocal = new THREE.Vector3();
    private groundDirectionLocal = new THREE.Vector3();
    private groundPointLocal = new THREE.Vector3();
    private groundNormalLocal = new THREE.Vector3();
    private groundInvQuat = new THREE.Quaternion();
    private groundPoint = new THREE.Vector3();
    private groundNormal = new THREE.Vector3();
    private groundVolumeQuery = createGroundProbeQuery();
    private groundProbeSegment = new THREE.Line3();
    private groundProbeTriangle = new ExtendedTriangle();
    private groundProbeTrianglePoint = new THREE.Vector3();
    private groundProbeSegmentPoint = new THREE.Vector3();
    private groundProbeSphereDelta = new THREE.Vector3();
    private groundProbeSphereHorizontal = new THREE.Vector3();
    private groundProbeBoxVertices = Array.from({ length: 8 }, () => new THREE.Vector3());
    private groundHit: DynamicGroundHit = {
        body: null as unknown as DynamicBody,
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
    };

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
        this.contactSolver.velocityIterations = 12;
    }

    /** 返回动态刚体调试开关。 */
    getDebugVisible(): boolean {
        return this.debugVisible;
    }

    /** 切换动态刚体碰撞线框。 */
    setDebugVisible(visible: boolean): void {
        this.debugVisible = visible;
        this.syncDebugVisibility();
    }

    /** 同步全部动态刚体碰撞线框。 */
    syncDebugVisibility(): void {
        for (const body of this.list) {
            this.syncDebugMesh(body);
            if (this.debugVisible) {
                if (!this.ctrl.scene.children.includes(body.debugMesh)) this.ctrl.scene.add(body.debugMesh);
            } else {
                this.ctrl.scene.remove(body.debugMesh);
            }
        }
    }

    /** 当前人物推动假质量：CHARACTER_PUSH_MASS × scale。 */
    private characterPushMass(): number {
        const s = this.ctrl.playerModelConfig.scale;
        return CHARACTER_PUSH_MASS * s;
    }

    /** 添加动态球。 */
    addSphere(desc: DynamicColliderDesc): DynamicSphereBody {
        if (desc.shape.kind !== "sphere") {
            throw new Error("[DynamicBodySystem] addSphere 要求 shape.kind 为 \"sphere\"。");
        }
        const mesh = desc.mesh;
        if (!mesh) {
            throw new Error("[DynamicBodySystem] addSphere 必须提供 mesh。");
        }

        const radius = Math.max(1e-4, desc.shape.radius);
        const position = (desc.shape.position ?? new THREE.Vector3()).clone();
        const velocity = (desc.velocity ?? new THREE.Vector3()).clone();
        const density = desc.density ?? DYNAMIC_BODY_DEFAULTS.density;
        const restitution = desc.restitution ?? DYNAMIC_BODY_DEFAULTS.restitution;
        const friction = desc.friction ?? DYNAMIC_BODY_DEFAULTS.friction;
        const linearDamping = desc.linearDamping ?? DYNAMIC_BODY_DEFAULTS.linearDamping;
        const angularDamping = desc.angularDamping ?? DYNAMIC_BODY_DEFAULTS.angularDamping;
        const gravity = desc.gravity ?? this.ctrl.gravity;

        mesh.scale.setScalar(radius);
        mesh.position.copy(position);

        const debugMesh = new THREE.Mesh(
            new THREE.SphereGeometry(1, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35 }),
        );
        debugMesh.scale.setScalar(radius);
        debugMesh.position.copy(position);

        const body = new DynamicSphereBody({
            radius,
            density,
            restitution,
            gravity,
            position,
            velocity,
            angularVelocity: desc.angularVelocity,
            linearDamping,
            angularDamping,
            friction,
            mesh,
            debugMesh,
        });
        const col = this.ctrl.collisionWorld.add({
            motion: "dynamic",
            shape: { kind: "sphere", radius },
            mask: DYNAMIC_MASK,
            userData: body,
        });
        body.colliderId = col.id;
        this.list.push(body);
        this.contactCaches.set(body, new ContactCache());
        if (this.debugVisible) this.ctrl.scene.add(debugMesh);
        return body;
    }

    /** 添加动态盒。 */
    addBox(desc: DynamicColliderDesc): DynamicBoxBody {
        if (desc.shape.kind !== "box") {
            throw new Error("[DynamicBodySystem] addBox 要求 shape.kind 为 \"box\"。");
        }
        const mesh = desc.mesh;
        if (!mesh) {
            throw new Error("[DynamicBodySystem] addBox 必须提供 mesh。");
        }

        const half = desc.shape.halfExtents.clone();
        half.x = Math.max(1e-4, half.x);
        half.y = Math.max(1e-4, half.y);
        half.z = Math.max(1e-4, half.z);
        const position = (desc.shape.position ?? new THREE.Vector3()).clone();
        const velocity = (desc.velocity ?? new THREE.Vector3()).clone();
        const density = desc.density ?? DYNAMIC_BODY_DEFAULTS.density;
        const restitution = desc.restitution ?? DYNAMIC_BODY_DEFAULTS.restitution;
        const friction = desc.friction ?? DYNAMIC_BODY_DEFAULTS.friction;
        const linearDamping = desc.linearDamping ?? DYNAMIC_BODY_DEFAULTS.linearDamping;
        const angularDamping = desc.angularDamping ?? DYNAMIC_BODY_DEFAULTS.angularDamping;
        const gravity = desc.gravity ?? this.ctrl.gravity;

        mesh.scale.set(half.x * 2, half.y * 2, half.z * 2);
        mesh.position.copy(position);
        if (desc.shape.quaternion) mesh.quaternion.copy(desc.shape.quaternion);

        const debugMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35 }),
        );
        debugMesh.scale.copy(mesh.scale);
        debugMesh.position.copy(position);
        if (desc.shape.quaternion) debugMesh.quaternion.copy(desc.shape.quaternion);

        const body = new DynamicBoxBody({
            halfExtents: half,
            density,
            restitution,
            gravity,
            position,
            quaternion: desc.shape.quaternion,
            velocity,
            angularVelocity: desc.angularVelocity,
            linearDamping,
            angularDamping,
            friction,
            mesh,
            debugMesh,
        });
        const col = this.ctrl.collisionWorld.add({
            motion: "dynamic",
            shape: { kind: "box", halfExtents: half.clone() },
            mask: DYNAMIC_MASK,
            userData: body,
        });
        body.colliderId = col.id;
        this.list.push(body);
        this.contactCaches.set(body, new ContactCache());
        if (this.debugVisible) this.ctrl.scene.add(debugMesh);
        return body;
    }

    /** 移除动态刚体。 */
    remove(body: DynamicBody): void {
        const idx = this.list.indexOf(body);
        if (idx === -1) return;
        this.list.splice(idx, 1);
        this.contactCaches.delete(body);
        if (this.ctrl.activeDynamicBody === body) this.ctrl.activeDynamicBody = null;
        this.ctrl.collisionWorld.remove(body.colliderId);
        this.ctrl.scene.remove(body.debugMesh);
        body.debugMesh.geometry.dispose();
        (body.debugMesh.material as THREE.Material).dispose();
    }

    /** 按 CollisionWorld id 查找动态刚体。 */
    findByColliderId(id: number): DynamicBody | undefined {
        return this.list.find(b => b.colliderId === id);
    }

    /** 清除全部动态刚体。 */
    clear(): void {
        while (this.list.length) this.remove(this.list[this.list.length - 1]);
    }

    /** 从指定世界坐标向下查询最高的动态表面。 */
    raycastGround(
        origin: THREE.Vector3,
        minNormalY = SUPPORT_Y,
        excludeKinds?: readonly DynamicBodyKind[],
    ): DynamicGroundHit | null {
        let bestY = -Infinity;
        let bestBody: DynamicBody | null = null;

        for (const body of this.list) {
            if (excludeKinds?.includes(body.kind)) continue;
            let hit = false;
            if (isBoxBody(body)) hit = this.raycastBoxGround(origin, body, minNormalY);
            else if (isSphereBody(body)) hit = this.raycastSphereGround(origin, body, minNormalY);
            if (!hit || this.groundPoint.y <= bestY) continue;
            bestY = this.groundPoint.y;
            bestBody = body;
            this.groundHit.point.copy(this.groundPoint);
            this.groundHit.normal.copy(this.groundNormal);
        }

        if (!bestBody) return null;
        this.groundHit.body = bestBody;
        bestBody.getVelocityAtPoint(this.groundHit.point, this.groundHit.velocity);
        return this.groundHit;
    }

    /** 用带半径的竖直传感区查询最近的动态支撑面。 */
    probeGroundVolume(
        sensorStart: THREE.Vector3,
        down: THREE.Vector3,
        maxDistance: number,
        sensorRadius: number,
        minNormalY = SUPPORT_Y,
    ): DynamicGroundHit | null {
        if (maxDistance <= 0 || sensorRadius <= 0 || down.lengthSq() === 0) return null;

        // 所有动态形状写入同一个查询状态。
        resetGroundProbeQuery(
            this.groundVolumeQuery,
            sensorStart,
            down,
            maxDistance,
            sensorRadius,
            minNormalY,
        );
        this.groundProbeSegment.start.copy(this.groundVolumeQuery.start);
        this.groundProbeSegment.end.copy(this.groundVolumeQuery.start)
            .addScaledVector(this.groundVolumeQuery.down, this.groundVolumeQuery.maxDistance);

        let bestBody: DynamicBody | null = null;
        for (const body of this.list) {
            // 各形状只负责生成表面候选点；共用筛选器负责决定是否更新最近命中。
            const improved = isBoxBody(body)
                ? this.probeBoxGroundVolume(body)
                : isSphereBody(body)
                    ? this.probeSphereGroundVolume(body)
                    : false;
            if (improved) bestBody = body;
        }

        if (!bestBody) return null;
        this.groundHit.point.copy(this.groundVolumeQuery.hit.point);
        this.groundHit.normal.copy(this.groundVolumeQuery.hit.normal);
        this.groundHit.body = bestBody;
        bestBody.getVelocityAtPoint(this.groundHit.point, this.groundHit.velocity);
        return this.groundHit;
    }

    /** 圆柱传感区与动态 OBB 的表面三角形查询。 */
    private probeBoxGroundVolume(body: DynamicBoxBody): boolean {
        const half = body.halfExtents;
        // 碰撞盒只保存半尺寸和位姿；先把 8 个局部角点转换到世界空间。
        for (let i = 0; i < this.groundProbeBoxVertices.length; i++) {
            this.groundProbeBoxVertices[i]
                .set(
                    (i & 1) === 0 ? -half.x : half.x,
                    (i & 2) === 0 ? -half.y : half.y,
                    (i & 4) === 0 ? -half.z : half.z,
                )
                .applyQuaternion(body.quaternion)
                .add(body.position);
        }

        let improved = false;
        for (let i = 0; i < BOX_TRIANGLES.length; i += 3) {
            // 将 OBB 的 6 个面拆成 12 个三角形，与 BVH 网格复用相同的候选点语义。
            this.groundProbeTriangle.set(
                this.groundProbeBoxVertices[BOX_TRIANGLES[i]],
                this.groundProbeBoxVertices[BOX_TRIANGLES[i + 1]],
                this.groundProbeBoxVertices[BOX_TRIANGLES[i + 2]],
            );
            if (tryGroundProbeTriangle(
                this.groundVolumeQuery,
                this.groundProbeSegment,
                this.groundProbeTriangle,
                this.groundProbeTrianglePoint,
                this.groundProbeSegmentPoint,
                this.groundNormal,
            )) improved = true;
        }
        return improved;
    }

    /** 圆柱传感区与动态球的解析查询。 */
    private probeSphereGroundVolume(body: DynamicSphereBody): boolean {
        const query = this.groundVolumeQuery;
        this.groundProbeSphereDelta.subVectors(body.position, query.start);
        const centerDistance = this.groundProbeSphereDelta.dot(query.down);
        this.groundProbeSphereHorizontal.copy(this.groundProbeSphereDelta)
            .addScaledVector(query.down, -centerDistance);

        // 在探测圆柱的圆形截面内，选择横向最靠近球心的位置。
        const horizontalDistance = this.groundProbeSphereHorizontal.length();
        const surfaceOffset = Math.max(0, horizontalDistance - query.radius);
        if (surfaceOffset > body.radius) return false;

        const upwardExtent = Math.sqrt(Math.max(0, body.radius * body.radius - surfaceOffset * surfaceOffset));
        this.groundPoint.copy(body.position);
        if (horizontalDistance > 1e-8) {
            this.groundPoint.addScaledVector(
                this.groundProbeSphereHorizontal,
                -surfaceOffset / horizontalDistance,
            );
        }
        this.groundPoint.addScaledVector(query.down, -upwardExtent);
        this.groundNormal.subVectors(this.groundPoint, body.position).normalize();

        // 球只负责解析求出点和法线，其余有效性检查仍交给共用筛选器。
        return tryGroundProbeCandidate(query, this.groundPoint, this.groundNormal);
    }

    /** 向下射线与动态 OBB 求交。 */
    private raycastBoxGround(origin: THREE.Vector3, body: DynamicBoxBody, minNormalY: number): boolean {
        this.groundInvQuat.copy(body.quaternion).invert();
        this.groundOriginLocal.copy(origin).sub(body.position).applyQuaternion(this.groundInvQuat);
        this.groundDirectionLocal.set(0, -1, 0).applyQuaternion(this.groundInvQuat).normalize();
        this.groundRay.set(this.groundOriginLocal, this.groundDirectionLocal);
        this.groundBox.min.copy(body.halfExtents).multiplyScalar(-1);
        this.groundBox.max.copy(body.halfExtents);
        if (!this.groundRay.intersectBox(this.groundBox, this.groundPointLocal)) return false;

        const dx = Math.abs(Math.abs(this.groundPointLocal.x) - body.halfExtents.x);
        const dy = Math.abs(Math.abs(this.groundPointLocal.y) - body.halfExtents.y);
        const dz = Math.abs(Math.abs(this.groundPointLocal.z) - body.halfExtents.z);
        if (dx <= dy && dx <= dz) {
            this.groundNormalLocal.set(Math.sign(this.groundPointLocal.x || 1), 0, 0);
        } else if (dy <= dz) {
            this.groundNormalLocal.set(0, Math.sign(this.groundPointLocal.y || 1), 0);
        } else {
            this.groundNormalLocal.set(0, 0, Math.sign(this.groundPointLocal.z || 1));
        }

        this.groundNormal.copy(this.groundNormalLocal).applyQuaternion(body.quaternion).normalize();
        if (this.groundNormal.y < minNormalY) return false;
        this.groundPoint.copy(this.groundPointLocal).applyQuaternion(body.quaternion).add(body.position);
        return this.groundPoint.y <= origin.y;
    }

    /** 向下射线与动态球求交。 */
    private raycastSphereGround(origin: THREE.Vector3, body: DynamicSphereBody, minNormalY: number): boolean {
        this.groundRay.set(origin, this.groundDirectionLocal.set(0, -1, 0));
        this.groundSphere.center.copy(body.position);
        this.groundSphere.radius = body.radius;
        if (!this.groundRay.intersectSphere(this.groundSphere, this.groundPoint)) return false;
        this.groundNormal.subVectors(this.groundPoint, body.position).normalize();
        return this.groundNormal.y >= minNormalY && this.groundPoint.y <= origin.y;
    }

    /** 推进全部动态刚体：子步求解 → 平台带走 → 休眠判定 → 同步视觉。 */
    step(delta: number): void {
        if (!this.list.length) return;
        this.skipVehicleMeshes.length = 0;
        for (const v of this.ctrl.vehicle.list) {
            if (v.meshColliderId != null) this.skipVehicleMeshes.push(v.meshColliderId);
        }
        const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(delta / TARGET_SUB_DT)));
        const sub = delta / substeps;
        for (let i = 0; i < substeps; i++) this.stepSub(sub);
        for (const body of this.list) this.applyKinematicCarry(body);
        for (const body of this.list) this.updateSleep(body, delta);
        for (const body of this.list) {
            body.mesh.position.copy(body.position);
            body.mesh.quaternion.copy(body.quaternion);
            if (this.debugVisible) this.syncDebugMesh(body);
        }
    }

    /** 将动态刚体当前形状与位姿写入调试 mesh。 */
    private syncDebugMesh(body: DynamicBody): void {
        body.debugMesh.position.copy(body.position);
        body.debugMesh.quaternion.copy(body.quaternion);
        if (isSphereBody(body)) body.debugMesh.scale.setScalar(body.radius);
        else if (isBoxBody(body)) {
            body.debugMesh.scale.set(
                body.halfExtents.x * 2,
                body.halfExtents.y * 2,
                body.halfExtents.z * 2,
            );
        }
    }

    /** 单次子步：重力积分 → 按形状窄相 → 阻尼与限速。 */
    private stepSub(dt: number): void {
        for (const body of this.list) {
            if (body.sleeping) {
                // 休眠体仍检测车辆接触，命中则唤醒并解算
                this.collideSleepingBodyWithVehicles(body);
                continue;
            }
            const col = this.ctrl.collisionWorld.get(body.colliderId);
            if (!col) continue;

            body.velocity.y += body.gravity * dt;
            body.integrate(dt);
            body.contactMesh = null;

            if (isSphereBody(body)) {
                this.collideSphereMeshes(body, dt);
                this.collideSphereBoxes(body);
                this.collideSphereVehicleWheels(body);
                this.resolveBodyVsKinematicCapsule(body); // 胶囊=运动学：只推刚体
            } else if (isBoxBody(body)) {
                this.collideBoxMeshes(body, dt);
                this.collideBoxVehicleBoxes(body);
                this.collideBoxVehicleWheels(body);
                this.resolveBodyVsKinematicCapsule(body);
            }
            body.applyDamping(dt);
            this.clampSpeed(body);
        }
        this.rebuildDynamicBroadphase();
        this.collideSpherePairs();
        this.collideBoxPairs();
        for (const body of this.list) {
            if (!body.sleeping) this.clampSpeed(body);
        }
    }

    /** 休眠刚体与车辆底盘 / 车轮球接触检测。 */
    private collideSleepingBodyWithVehicles(body: DynamicBody): void {
        if (isBoxBody(body)) {
            this.collideBoxVehicleBoxes(body);
            this.collideBoxVehicleWheels(body);
        } else if (isSphereBody(body)) {
            this.collideSphereVehicleBoxes(body);
            this.collideSphereVehicleWheels(body);
        }
    }

    /** 按速度阈值累计 / 清除休眠计时。 */
    private updateSleep(body: DynamicBody, dt: number): void {
        if (!body.canSleep) {
            if (body.sleeping) body.wakeUp();
            return;
        }
        if (body.sleeping) return;

        const linSq = body.velocity.lengthSq();
        const angSq = body.angularVelocity.lengthSq();
        const linMax = SLEEP_LINEAR * SLEEP_LINEAR;
        const angMax = SLEEP_ANGULAR * SLEEP_ANGULAR;
        const wakeLin = linMax * SLEEP_WAKE_FACTOR * SLEEP_WAKE_FACTOR;
        const wakeAng = angMax * SLEEP_WAKE_FACTOR * SLEEP_WAKE_FACTOR;

        if (linSq > wakeLin || angSq > wakeAng) {
            body.sleepTimer = 0;
            return;
        }
        if (linSq <= linMax && angSq <= angMax) {
            body.sleepTimer += dt;
            if (body.sleepTimer >= SLEEP_TIME) body.putToSleep();
        }
    }

    /** 双方都休眠则跳过；一方休眠时按需唤醒后再解算。 */
    private shouldSolveDynamicPair(a: DynamicBody, b: DynamicBody): boolean {
        if (a.sleeping && b.sleeping) return false;
        if (a.sleeping || b.sleeping) {
            const awake = a.sleeping ? b : a;
            const sleeper = a.sleeping ? a : b;
            if (awake.isRestingCandidate(SLEEP_LINEAR, SLEEP_ANGULAR)) return false;
            sleeper.wakeUp();
            return true;
        }
        return true;
    }

    /**
     * 球 vs 静态/平台网格：收集接触 → 过深则硬推 → 否则冲量求解 + 位置修正。
     * 跳过车辆外观 mesh，改由底盘盒处理。
     */
    private collideSphereMeshes(body: DynamicSphereBody, dt: number): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const meshes = this.ctrl.collisionWorld.queryMeshes(worldCol, { skipIds: this.skipVehicleMeshes });

        let rawCount = 0;
        let deepest = 0;
        let deepestMesh: THREE.Mesh | null = null;
        for (const mesh of meshes) {
            const before = rawCount;
            rawCount = collectSphereVsMeshContacts(
                body.position, body.radius, mesh, this.temps, this.raw, rawCount, MAX_RAW,
            );
            for (let i = before; i < rawCount; i++) {
                if (this.raw[i].penetration > deepest) {
                    deepest = this.raw[i].penetration;
                    deepestMesh = mesh;
                }
            }
        }
        if (rawCount === 0) return;
        body.contactMesh = deepestMesh;

        // 卡进网格过深时先钳制推出，避免冲量爆炸
        const maxPush = body.radius * MAX_PUSH_RATIO;
        if (deepest > maxPush) {
            let nx = 0, ny = 0, nz = 0, w = 0;
            for (let i = 0; i < rawCount; i++) {
                const p = Math.max(this.raw[i].penetration, 0);
                nx += this.raw[i].normal.x * p;
                ny += this.raw[i].normal.y * p;
                nz += this.raw[i].normal.z * p;
                w += p;
            }
            if (w > 1e-8) {
                this.temps.normal.set(nx / w, ny / w, nz / w);
                if (this.temps.normal.lengthSq() > 1e-8) {
                    this.temps.normal.normalize();
                    body.position.addScaledVector(
                        this.temps.normal,
                        Math.min(deepest, maxPush, this.maxPositionCorrection(body, dt)),
                    );
                }
            }
            return;
        }

        this.solveMeshManifolds(body, rawCount, dt);
        this.applySphereSupportRolling(body);
    }

    /** 盒 vs 静态/平台网格：复用 VehicleCollision 收集接触后冲量求解。 */
    private collideBoxMeshes(body: DynamicBoxBody, dt: number): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const meshes = this.ctrl.collisionWorld.queryMeshes(worldCol, { skipIds: this.skipVehicleMeshes });
        if (!meshes.length) return;

        this.manifolds.length = 0;
        let deepest = 0;
        let deepestMesh: THREE.Mesh | null = null;
        for (const mesh of meshes) {
            const found = this.boxMeshCollision.detect(body, mesh);
            if (!found.length) continue;
            let meshDeep = 0;
            for (const m of found) {
                this.manifolds.push(m);
                for (const p of m.contacts) {
                    if (p.penetration > meshDeep) meshDeep = p.penetration;
                }
            }
            if (meshDeep > deepest) {
                deepest = meshDeep;
                deepestMesh = mesh;
            }
        }
        if (!this.manifolds.length) return;
        body.contactMesh = deepestMesh;

        const maxPush = body.characteristicExtent() * MAX_PUSH_RATIO;
        if (deepest > maxPush) {
            let nx = 0, ny = 0, nz = 0, w = 0;
            for (const m of this.manifolds) {
                for (const p of m.contacts) {
                    const pen = Math.max(p.penetration, 0);
                    nx += m.normal.x * pen;
                    ny += m.normal.y * pen;
                    nz += m.normal.z * pen;
                    w += pen;
                }
            }
            if (w > 1e-8) {
                this.temps.normal.set(nx / w, ny / w, nz / w);
                if (this.temps.normal.lengthSq() > 1e-8) {
                    this.temps.normal.normalize();
                    body.position.addScaledVector(
                        this.temps.normal,
                        Math.min(deepest, maxPush, this.maxPositionCorrection(body, dt)),
                    );
                }
            }
            return;
        }

        const cache = this.contactCaches.get(body);
        cache?.match(this.manifolds);
        this.contactSolver.solveVelocity(body, this.manifolds, dt);
        cache?.save(this.manifolds);
        this.correctMeshPenetration(body, this.manifolds, dt);
    }

    /** 球网格接触：归约 → 冲量 → 位置修正。 */
    private solveMeshManifolds(body: DynamicBody, rawCount: number, dt: number): void {
        this.manifolds.length = 0;
        reduceContacts(this.raw, rawCount, body, this.manifolds);
        const cache = this.contactCaches.get(body);
        cache?.match(this.manifolds);
        this.contactSolver.solveVelocity(body, this.manifolds, dt);
        cache?.save(this.manifolds);
        this.correctMeshPenetration(body, this.manifolds, dt);
    }

    /** 每个流形只按最深接触修正一次位置。 */
    private correctMeshPenetration(body: DynamicBody, manifolds: ContactManifold[], dt: number): void {
        const skin = contactSkinForExtent(body.characteristicExtent());
        const maxCorrection = this.maxPositionCorrection(body, dt);
        for (const manifold of manifolds) {
            let deepest = 0;
            for (const point of manifold.contacts) {
                if (point.penetration > deepest) deepest = point.penetration;
            }
            const correction = Math.min((deepest - skin) * POS_CORRECT, maxCorrection);
            if (correction > 0) body.position.addScaledVector(manifold.normal, correction);
        }
    }

    /** 按特征尺寸限制单子步的最大位置修正。 */
    private maxPositionCorrection(body: DynamicBody, dt: number): number {
        return body.characteristicExtent() * MAX_DEPENETRATION_EXTENTS * dt;
    }

    /**
     * 在支撑面上将角速度拉向无滑滚动：ω → n × v_tang / R。
     * 补强摩擦迭代不足时的滚动手感。
     */
    private applySphereSupportRolling(body: DynamicSphereBody): void {
        let bestY = SUPPORT_Y;
        let support: ContactManifold | null = null;
        for (const m of this.manifolds) {
            if (m.normal.y > bestY) {
                bestY = m.normal.y;
                support = m;
            }
        }
        if (!support) return;

        const n = support.normal;
        this.temps.offset.copy(body.velocity).addScaledVector(n, -body.velocity.dot(n)); // v_tang
        if (this.temps.offset.lengthSq() < 1e-10) return;
        this.rollTarget.copy(n).cross(this.temps.offset).multiplyScalar(1 / Math.max(body.radius, 1e-6));
        body.angularVelocity.lerp(this.rollTarget, ROLL_BLEND);
    }

    /** 球 vs 车辆底盘 / 动态盒 OBB。 */
    private collideSphereBoxes(body: DynamicSphereBody): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const boxes = this.ctrl.collisionWorld.query(worldCol, { kinds: ["box"] });
        for (const box of boxes) {
            const vehicle = box.userData as VehicleInstance | undefined;
            const chassis = vehicle?.chassisBody;
            if (chassis) {
                this.resolveSphereVsObbBody(body, chassis);
                continue;
            }
            const other = box.userData;
            if (isBoxBody(other as DynamicBody) && other !== body) {
                this.resolveSphereVsObbBody(body, other as DynamicBoxBody);
            }
        }
    }

    /** 球 vs 车辆底盘（休眠体专用，不测其它动态盒）。 */
    private collideSphereVehicleBoxes(body: DynamicSphereBody): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const boxes = this.ctrl.collisionWorld.query(worldCol, { kinds: ["box"] });
        for (const box of boxes) {
            const vehicle = box.userData as VehicleInstance | undefined;
            const chassis = vehicle?.chassisBody;
            if (!chassis) continue;
            if (this.resolveSphereVsObbBody(body, chassis)) body.wakeUp();
        }
    }

    /** 球与单个 OBB 刚体：推出球并双方在接触点施冲量；有接触返回 true。 */
    private resolveSphereVsObbBody(
        body: DynamicSphereBody,
        other: {
            position: THREE.Vector3; quaternion: THREE.Quaternion; halfExtents: THREE.Vector3;
            getVelocityAtPoint(p: THREE.Vector3, o: THREE.Vector3): THREE.Vector3;
            applyImpulseAtPoint(i: THREE.Vector3, p: THREE.Vector3): void
        },
    ): boolean {
        if (!collideSphereVsObb(
            body.position, body.radius,
            other.position, other.quaternion, other.halfExtents,
            this.temps,
        )) return false;

        body.getVelocityAtPoint(this.temps.contact, this.bodyVel);
        other.getVelocityAtPoint(this.temps.contact, this.temps.boxVel);
        this.temps.offset.copy(this.bodyVel).sub(this.temps.boxVel);
        const vn = this.temps.offset.dot(this.temps.normal);
        if (vn >= 0) return true;
        const deltaVn = -vn * (1 + body.restitution);
        this.temps.impulse.copy(this.temps.normal).multiplyScalar(deltaVn * body.mass);
        body.applyImpulseAtPoint(this.temps.impulse, this.temps.contact);
        this.temps.impulse.multiplyScalar(-1);
        other.applyImpulseAtPoint(this.temps.impulse, this.temps.contact);
        return true;
    }

    /** 动态盒 vs 车辆底盘 OBB；有接触时唤醒休眠盒。 */
    private collideBoxVehicleBoxes(body: DynamicBoxBody): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const boxes = this.ctrl.collisionWorld.query(worldCol, { kinds: ["box"] });
        for (const box of boxes) {
            if (box.id === body.colliderId) continue;
            const vehicle = box.userData as VehicleInstance | undefined;
            const chassis = vehicle?.chassisBody;
            if (!chassis) continue;
            if (resolveObbObb(body, chassis, this.obbTemps)) body.wakeUp();
        }
    }

    /** 动态球 vs 车轮运动学球。 */
    private collideSphereVehicleWheels(body: DynamicSphereBody): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const spheres = this.ctrl.collisionWorld.query(worldCol, {
            kinds: ["sphere"],
            motion: ["kinematic", "static"],
        });
        for (const col of spheres) {
            if (col.shape.kind !== "sphere") continue;
            const wheel = this.asVehicleWheel(col.userData);
            if (!wheel) continue;
            if (this.resolveSphereVsVehicleWheel(
                body, wheel.vehicle, wheel.wheelIndex, col.shape.radius,
            )) {
                body.wakeUp();
            }
        }
    }

    /** 动态盒 vs 车轮运动学球。 */
    private collideBoxVehicleWheels(body: DynamicBoxBody): void {
        const worldCol = this.ctrl.collisionWorld.get(body.colliderId);
        if (!worldCol) return;
        const spheres = this.ctrl.collisionWorld.query(worldCol, {
            kinds: ["sphere"],
            motion: ["kinematic", "static"],
        });
        for (const col of spheres) {
            if (col.shape.kind !== "sphere") continue;
            const wheel = this.asVehicleWheel(col.userData);
            if (!wheel) continue;
            if (this.resolveBoxVsVehicleWheel(
                body, wheel.vehicle, wheel.wheelIndex, col.shape.radius,
            )) {
                body.wakeUp();
            }
        }
    }

    /** 识别车轮球 userData。 */
    private asVehicleWheel(userData: unknown): VehicleWheelColliderUserData | null {
        if (!userData || typeof userData !== "object") return null;
        const data = userData as VehicleWheelColliderUserData;
        if (!data.vehicle?.chassisBody || typeof data.wheelIndex !== "number") return null;
        return data;
    }

    /**
     * 由底盘位姿 + 悬挂长度推算轮心。
     * 成功时写入 wheelCenter，返回实际使用的半径。
     */
    private getWheelCenterWS(
        vehicle: VehicleInstance,
        wheelIndex: number,
        registeredRadius: number,
    ): number | null {
        const chassis = vehicle.chassisBody;
        const wheel = vehicle.vehicleController.wheelAt(wheelIndex);
        if (!wheel) return null;
        this.wheelCenter.copy(wheel.connectionPoint).applyQuaternion(chassis.quaternion).add(chassis.position);
        this.wheelDir.copy(wheel.direction).applyQuaternion(chassis.quaternion);
        const dirLen = this.wheelDir.length();
        if (dirLen > 1e-8) this.wheelCenter.addScaledVector(this.wheelDir, wheel.suspensionLength / dirLen);
        return Math.max(1e-4, registeredRadius > 0 ? registeredRadius : wheel.radius);
    }

    /**
     * 动态球 vs 单轮：只推开球，冲量回写底盘。
     * 法线由轮心指向球。
     */
    private resolveSphereVsVehicleWheel(
        body: DynamicSphereBody,
        vehicle: VehicleInstance,
        wheelIndex: number,
        registeredRadius: number,
    ): boolean {
        const chassis = vehicle.chassisBody;
        const radius = this.getWheelCenterWS(vehicle, wheelIndex, registeredRadius);
        if (radius == null) return false;

        this.temps.offset.subVectors(body.position, this.wheelCenter);
        const dist = this.temps.offset.length();
        const minDist = body.radius + radius;
        if (dist >= minDist) return false;
        if (dist > 1e-8) this.temps.normal.copy(this.temps.offset).multiplyScalar(1 / dist);
        else this.temps.normal.set(0, 1, 0);

        const depth = minDist - dist;
        body.position.addScaledVector(this.temps.normal, depth);
        this.temps.contact.copy(this.wheelCenter).addScaledVector(this.temps.normal, radius);

        body.getVelocityAtPoint(this.temps.contact, this.bodyVel);
        chassis.getVelocityAtPoint(this.temps.contact, this.temps.boxVel);
        this.temps.offset.copy(this.bodyVel).sub(this.temps.boxVel);
        const vn = this.temps.offset.dot(this.temps.normal);
        if (vn >= 0) return true;
        const deltaVn = -vn * (1 + body.restitution);
        this.temps.impulse.copy(this.temps.normal).multiplyScalar(deltaVn * body.mass);
        body.applyImpulseAtPoint(this.temps.impulse, this.temps.contact);
        this.temps.impulse.multiplyScalar(-1);
        chassis.applyImpulseAtPoint(this.temps.impulse, this.temps.contact);
        return true;
    }

    /**
     * 动态盒 vs 单轮：用球-OBB 测重叠，将本应推开轮球的位移反加到盒上，冲量回写底盘。
     * collideSphereVsObb 的法线由盒指向轮。
     */
    private resolveBoxVsVehicleWheel(
        body: DynamicBoxBody,
        vehicle: VehicleInstance,
        wheelIndex: number,
        registeredRadius: number,
    ): boolean {
        const chassis = vehicle.chassisBody;
        const radius = this.getWheelCenterWS(vehicle, wheelIndex, registeredRadius);
        if (radius == null) return false;

        this.wheelPosBefore.copy(this.wheelCenter);
        if (!collideSphereVsObb(
            this.wheelCenter, radius,
            body.position, body.quaternion, body.halfExtents,
            this.temps,
        )) {
            this.wheelCenter.copy(this.wheelPosBefore);
            return false;
        }

        // 轮球被推出的位移改为推开动态盒
        this.temps.offset.subVectors(this.wheelCenter, this.wheelPosBefore);
        body.position.sub(this.temps.offset);
        this.wheelCenter.copy(this.wheelPosBefore);

        body.getVelocityAtPoint(this.temps.contact, this.bodyVel);
        chassis.getVelocityAtPoint(this.temps.contact, this.temps.boxVel);
        // 将轮视为「球」、盒视为 OBB：相对速度 = 轮速 - 盒速
        this.temps.offset.copy(this.temps.boxVel).sub(this.bodyVel);
        const vn = this.temps.offset.dot(this.temps.normal);
        if (vn >= 0) return true;
        const deltaVn = -vn * (1 + body.restitution);
        this.temps.impulse.copy(this.temps.normal).multiplyScalar(deltaVn * body.mass);
        // 法线由盒→轮：冲量加到底盘（轮侧），反向加到盒
        chassis.applyImpulseAtPoint(this.temps.impulse, this.temps.contact);
        this.temps.impulse.multiplyScalar(-1);
        body.applyImpulseAtPoint(this.temps.impulse, this.temps.contact);
        return true;
    }

    /** 球与球两两求解（宽相位筛对后窄相）。 */
    private collideSpherePairs(): void {
        for (const [i, j] of this.iterDynamicBroadphasePairs()) {
            const a = this.list[i];
            const b = this.list[j];
            if (!isSphereBody(a) || !isSphereBody(b)) continue;
            if (!this.shouldSolveDynamicPair(a, b)) continue;
            resolveSphereSphere(a, b, this.temps, 0.5 * (a.restitution + b.restitution));
        }
    }

    /** 盒与盒两两 OBB 求解（宽相位筛对后窄相）。 */
    private collideBoxPairs(): void {
        for (const [i, j] of this.iterDynamicBroadphasePairs()) {
            const a = this.list[i];
            const b = this.list[j];
            if (!isBoxBody(a) || !isBoxBody(b)) continue;
            if (!this.shouldSolveDynamicPair(a, b)) continue;
            resolveObbObb(a, b, this.obbTemps);
        }
    }

    /** 重建 XZ 网格宽相位；单元尺寸随最大特征体自适应。 */
    private rebuildDynamicBroadphase(): void {
        const n = this.list.length;
        this.broadphaseGrid.clear();
        if (n === 0) return;

        while (this.bodyAabbMin.length < n) {
            this.bodyAabbMin.push(new THREE.Vector3());
            this.bodyAabbMax.push(new THREE.Vector3());
        }

        let maxExtent = 0.5;
        for (let i = 0; i < n; i++) {
            maxExtent = Math.max(maxExtent, this.list[i].characteristicExtent());
            this.setBodyAabb(this.list[i], this.bodyAabbMin[i], this.bodyAabbMax[i]);
        }
        this.broadphaseCellSize = Math.max(1, maxExtent * BROADPHASE_CELL_SCALE);
        const invCell = 1 / this.broadphaseCellSize;

        for (let i = 0; i < n; i++) {
            const min = this.bodyAabbMin[i];
            const max = this.bodyAabbMax[i];
            const ix0 = Math.floor(min.x * invCell);
            const ix1 = Math.floor(max.x * invCell);
            const iz0 = Math.floor(min.z * invCell);
            const iz1 = Math.floor(max.z * invCell);
            for (let ix = ix0; ix <= ix1; ix++) {
                for (let iz = iz0; iz <= iz1; iz++) {
                    const key = `${ix},${iz}`;
                    let bucket = this.broadphaseGrid.get(key);
                    if (!bucket) {
                        bucket = [];
                        this.broadphaseGrid.set(key, bucket);
                    }
                    bucket.push(i);
                }
            }
        }
    }

    /** 遍历宽相位候选对（同格 + 相邻格，AABB 重叠，i < j 去重）。 */
    private *iterDynamicBroadphasePairs(): Generator<[number, number]> {
        const n = this.list.length;
        if (n < 2) return;
        this.broadphasePairSeen.clear();

        for (const [key, bucketA] of this.broadphaseGrid) {
            const comma = key.indexOf(",");
            const ix = Number(key.slice(0, comma));
            const iz = Number(key.slice(comma + 1));
            for (let dz = 0; dz <= 1; dz++) {
                for (let dx = 0; dx <= 1; dx++) {
                    const bucketB = this.broadphaseGrid.get(`${ix + dx},${iz + dz}`);
                    if (!bucketB) continue;
                    for (const i of bucketA) {
                        for (const j of bucketB) {
                            if (i >= j) continue;
                            const pairKey = i * n + j;
                            if (this.broadphasePairSeen.has(pairKey)) continue;
                            this.broadphasePairSeen.add(pairKey);
                            if (!this.bodyAabbOverlap(i, j)) continue;
                            yield [i, j];
                        }
                    }
                }
            }
        }
    }

    /** 写入刚体世界 AABB；盒体将 OBB 三轴投影后取包络（宽相位粗测用，偏保守）。 */
    private setBodyAabb(body: DynamicBody, min: THREE.Vector3, max: THREE.Vector3): void {
        if (isSphereBody(body)) {
            const r = body.radius;
            min.set(body.position.x - r, body.position.y - r, body.position.z - r);
            max.set(body.position.x + r, body.position.y + r, body.position.z + r);
            return;
        }
        if (isBoxBody(body)) {
            const hx = body.halfExtents.x;
            const hy = body.halfExtents.y;
            const hz = body.halfExtents.z;
            this.broadphaseAxisX.set(hx, 0, 0).applyQuaternion(body.quaternion);
            this.broadphaseAxisY.set(0, hy, 0).applyQuaternion(body.quaternion);
            this.broadphaseAxisZ.set(0, 0, hz).applyQuaternion(body.quaternion);
            const ex = Math.abs(this.broadphaseAxisX.x)
                + Math.abs(this.broadphaseAxisY.x)
                + Math.abs(this.broadphaseAxisZ.x);
            const ey = Math.abs(this.broadphaseAxisX.y)
                + Math.abs(this.broadphaseAxisY.y)
                + Math.abs(this.broadphaseAxisZ.y);
            const ez = Math.abs(this.broadphaseAxisX.z)
                + Math.abs(this.broadphaseAxisY.z)
                + Math.abs(this.broadphaseAxisZ.z);
            min.set(body.position.x - ex, body.position.y - ey, body.position.z - ez);
            max.set(body.position.x + ex, body.position.y + ey, body.position.z + ez);
        }
    }

    /** 宽相位候选对 AABB 三轴重叠检测；未通过则跳过窄相。 */
    private bodyAabbOverlap(i: number, j: number): boolean {
        const aMin = this.bodyAabbMin[i];
        const aMax = this.bodyAabbMax[i];
        const bMin = this.bodyAabbMin[j];
        const bMax = this.bodyAabbMax[j];
        return (
            aMin.x <= bMax.x && aMax.x >= bMin.x
            && aMin.y <= bMax.y && aMax.y >= bMin.y
            && aMin.z <= bMax.z && aMax.z >= bMin.z
        );
    }

    /**
     * 人物分步移动时与动态体接触。
     * 胶囊只做位置推出；对刚体施水平单向冲量（不回推人物速度）。
     */
    collideWithCapsule(): void {
        if (this.ctrl.controllerMode === 1 || this.ctrl.skipCapsuleCollision) return;
        const cap = this.ctrl.playerCapsule;
        const info = cap?.capsuleInfo;
        if (!cap || !info) return;

        const maxSep = info.radius * CHAR_SEP_MAX_RADIUS;
        const playerVel = this.ctrl.playerVelocity;
        const charMass = this.characterPushMass();

        for (const body of this.list) {
            const hit = this.queryCapsuleBodyOverlap(cap, info, body);
            if (!hit || hit.depth <= 0) continue;

            // 步行法线压到水平，避免竖直分量把人弹飞
            this.temps.normal.copy(hit.normal);
            if (!this.ctrl.isFlying) {
                this.temps.normal.y = 0;
                if (this.temps.normal.lengthSq() < 1e-8) {
                    this.temps.normal.set(
                        body.position.x - cap.position.x,
                        0,
                        body.position.z - cap.position.z,
                    );
                    if (this.temps.normal.lengthSq() < 1e-8) this.temps.normal.set(1, 0, 0);
                }
                this.temps.normal.normalize();
            }

            const sep = Math.min(hit.depth, maxSep);
            cap.position.addScaledVector(this.temps.normal, -sep);
            cap.updateMatrixWorld();

            body.getVelocityAtPoint(hit.contact, this.bodyVel);
            this.temps.offset.set(playerVel.x - this.bodyVel.x, 0, playerVel.z - this.bodyVel.z);
            const deltaVel = this.temps.offset.dot(this.temps.normal);
            if (deltaVel <= 0) continue;

            const massRatio = (body.mass * charMass) / (body.mass + charMass);
            this.temps.impulse.copy(this.temps.normal).multiplyScalar(deltaVel * massRatio);
            this.temps.impulse.y = 0;
            body.applyImpulseAtPoint(this.temps.impulse, hit.contact);
        }
    }

    /** 查询胶囊与单个动态体的重叠；normal 由胶囊指向刚体。 */
    private queryCapsuleBodyOverlap(
        cap: THREE.Object3D,
        info: { segment: THREE.Line3; radius: number; dynamicsSegment?: THREE.Line3 },
        body: DynamicBody,
    ): { depth: number; normal: THREE.Vector3; contact: THREE.Vector3 } | null {
        if (isSphereBody(body)) {
            const depth = capsuleSphereOverlap(cap, info, body.position, body.radius, this.capsuleTemps);
            if (depth <= 0) return null;
            this.contactPoint.copy(this.capsuleTemps.closestSeg).addScaledVector(
                this.capsuleTemps.closestTri, info.radius,
            );
            return {
                depth,
                normal: this.capsuleTemps.closestTri,
                contact: this.contactPoint,
            };
        }
        if (isBoxBody(body)) {
            const depth = capsuleObbOverlap(
                cap, info, body.position, body.quaternion, body.halfExtents, this.capsuleTemps,
            );
            if (depth <= 0) return null;
            this.contactPoint.copy(this.capsuleTemps.closestSeg).addScaledVector(
                this.capsuleTemps.closestTri, info.radius,
            );
            return {
                depth,
                normal: this.capsuleTemps.closestTri,
                contact: this.contactPoint,
            };
        }
        return null;
    }

    /**
     * 物理子步：胶囊视为运动学障碍（无限质量），只推出刚体并去掉侵入法向速度。
     */
    private resolveBodyVsKinematicCapsule(body: DynamicBody): void {
        const cap = this.ctrl.playerCapsule;
        const info = cap?.capsuleInfo;
        if (!cap || !info || this.ctrl.controllerMode === 1) return;

        const hit = this.queryCapsuleBodyOverlap(cap, info, body);
        if (!hit || hit.depth <= 0) return;

        // 法线：胶囊→刚体；推出刚体。步行压低竖直分量，避免箱子被顶飞。
        this.temps.normal.copy(hit.normal);
        if (!this.ctrl.isFlying && Math.abs(this.temps.normal.y) > 0.35) {
            this.temps.normal.y *= 0.15;
            if (this.temps.normal.lengthSq() > 1e-8) this.temps.normal.normalize();
            else {
                this.temps.normal.set(
                    body.position.x - cap.position.x,
                    0,
                    body.position.z - cap.position.z,
                );
                if (this.temps.normal.lengthSq() < 1e-8) return;
                this.temps.normal.normalize();
            }
        }

        const sep = Math.min(hit.depth, info.radius * CHAR_SEP_MAX_RADIUS);
        body.position.addScaledVector(this.temps.normal, sep * KIN_CAPSULE_BAUMGARTE);

        body.getVelocityAtPoint(hit.contact, this.bodyVel);
        const vn = this.bodyVel.dot(this.temps.normal);
        if (vn < 0) {
            this.temps.impulse.copy(this.temps.normal).multiplyScalar(-vn * body.mass);
            body.applyImpulseAtPoint(this.temps.impulse, hit.contact);
        }
    }

    /** 限制线速度 / 角速度，避免异常弹出。 */
    private clampSpeed(body: DynamicBody): void {
        const extent = body.characteristicExtent();
        const maxSpeed = Math.max(Math.abs(body.gravity) * MAX_SPEED_GRAVITY, extent * 80);
        const speed = body.velocity.length();
        if (speed > maxSpeed) body.velocity.multiplyScalar(maxSpeed / speed);
        const maxAng = maxSpeed / Math.max(extent, 1e-4);
        const ang = body.angularVelocity.length();
        if (ang > maxAng) body.angularVelocity.multiplyScalar(maxAng / ang);
    }

    /** 刚体停在运动学网格上时按平台 prev→current 矩阵带走；位移过大则回退。 */
    private applyKinematicCarry(body: DynamicBody): void {
        if (body.sleeping || !body.contactMesh) return;
        const entry = this.ctrl.getKinematicColliderEntries().find(e => e.mesh === body.contactMesh);
        if (!entry) return;
        this.carryPrevInv.copy(entry.prevWorldMatrix).invert();
        this.temps.before.copy(body.position);
        body.position.applyMatrix4(this.carryPrevInv).applyMatrix4(entry.source.matrixWorld);
        const maxCarry = body.characteristicExtent() * 8;
        if (body.position.distanceToSquared(this.temps.before) > maxCarry * maxCarry) {
            body.position.copy(this.temps.before);
        }
    }
}
