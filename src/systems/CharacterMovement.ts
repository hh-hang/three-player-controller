import * as THREE from "three";
import type { playerController } from "../PlayerController";
import type { KinematicColliderEntry } from "../types";
import { CHARACTER_QUERY_MASK } from "../collision/groups";
import type { DynamicBody } from "../collision/DynamicBody";
import type { DynamicGroundHit } from "./DynamicBodySystem";
import type { PlayerDebug } from "./PlayerDebug";
import {
    applyCapsuleCollision,
    createGroundProbeTemps,
    probeMeshGround,
} from "../utils/capsuleCollision";

/** 体积地面传感区半径相对玩家胶囊半径的比例。 */
const GROUND_SENSOR_RADIUS_RATIO = 0.4;
/** 可作为支撑面的最小向上法线分量。 */
const GROUND_SUPPORT_NORMAL_Y = 0.5;

/**
 * 人物胶囊移动：地面射线、分步推出、重力 snap、平台携带。
 * 不走刚体冲量核（位置推出式 CharacterController）。
 */
export class CharacterMovement {
    private dynamicSupportBody: DynamicBody | null = null;
    private dynamicSupportPrevPosition = new THREE.Vector3();
    private dynamicSupportPrevQuaternion = new THREE.Quaternion();
    private dynamicSupportInvQuaternion = new THREE.Quaternion();
    private dynamicSupportLocal = new THREE.Vector3();
    private dynamicSupportBefore = new THREE.Vector3();
    private dynamicSupportDelta = new THREE.Vector3();
    private groundProbeTemps = createGroundProbeTemps();
    private groundProbeStart = new THREE.Vector3();
    private groundProbeDown = new THREE.Vector3();
    private groundProbeOffset = new THREE.Vector3();
    private shapeGroundPoint = new THREE.Vector3();
    private shapeGroundNormal = new THREE.Vector3();
    private rayGroundNormal = new THREE.Vector3();
    private rayGroundNormalMatrix = new THREE.Matrix3();

    constructor(
        private readonly ctrl: playerController,
        private readonly debug: PlayerDebug,
    ) { }

    /** 步行 / 飞行一帧：输入速度 → 落地 → 分步碰撞 → 朝向与相机。 */
    update(delta: number): void {
        const c = this.ctrl;
        // 载具模式只跑动画，移动由车辆系统负责
        if (c.controllerMode === 1) {
            c.clearGroundSupport();
            this.debug.clearGroundProbe();
            c.runAnimationPass(delta);
            return;
        }
        // 先携带到平台当前位姿，再探测地面和推出。
        if (c.activeKinematicCollider && c.playerIsOnGround && !c.isFlying) {
            c.playerCapsule.position.add(c.activeKinematicCollider.deltaPos);
            if (c.activeKinematicCollider.deltaRotY !== 0) {
                c.playerCapsule.rotateY(c.activeKinematicCollider.deltaRotY);
            }
        }
        // —— 输入与目标速度 ——
        c.camera.getWorldDirection(c.camDir);
        const angle = 2 * Math.PI - (Math.atan2(c.camDir.z, c.camDir.x) + Math.PI / 2);

        const moveAxes = c.input.getMoveAxes();
        const automaticMove = c.input.getAutomaticMove();
        c.moveDir.copy(c.DIR_RGT).multiplyScalar(moveAxes.x).addScaledVector(c.DIR_FWD, moveAxes.y);
        if (automaticMove && !c.isFlying) c.moveDir.copy(automaticMove.direction);
        if (c.isFlying) {
            if (c.input.fwd || moveAxes.isAnalog) c.moveDir.copy(c.camDir);
            if (c.input.space) c.moveDir.y += 1;
            c.curPlayerSpeed = c.input.shift ? c.playerFlySpeed * 2 : c.playerFlySpeed;
        } else {
            c.curPlayerSpeed = c.input.shift ? c.playerRunSpeed : c.playerSpeed;
        }

        c.moveDir.normalize();
        if (automaticMove && !c.isFlying) c.curPlayerSpeed *= automaticMove.speedScale;
        // 步行：相对相机水平朝向；飞行且镜头前进时已用 camDir，不再绕 Y 转
        if (!automaticMove && (!c.isFlying || (!moveAxes.isAnalog && !c.input.fwd))) {
            c.moveDir.applyAxisAngle(c.upVector, angle);
        }

        // 水平速度向目标加速 / 无输入时减速
        const accelStep = c.playerAcceleration * c.decelBase * delta;
        const decelStep = c.playerDeceleration * c.decelBase * delta;
        const targetX = c.moveDir.x * c.curPlayerSpeed;
        const targetZ = c.moveDir.z * c.curPlayerSpeed;
        const diffX = targetX - c.playerVelocity.x;
        const diffZ = targetZ - c.playerVelocity.z;
        const hasXZInput = c.moveDir.x !== 0 || c.moveDir.z !== 0;
        const xzDiffLen = Math.hypot(diffX, diffZ);
        if (xzDiffLen > 0) {
            const xzApplied = Math.min(xzDiffLen, hasXZInput ? accelStep : decelStep);
            c.playerVelocity.x += (diffX / xzDiffLen) * xzApplied;
            c.playerVelocity.z += (diffZ / xzDiffLen) * xzApplied;
        }
        if (c.isFlying) {
            const targetY = c.moveDir.y * c.curPlayerSpeed;
            const diffY = targetY - c.playerVelocity.y;
            c.playerVelocity.y += Math.sign(diffY) * Math.min(Math.abs(diffY), c.moveDir.y !== 0 ? accelStep : decelStep);
        }

        // —— 脚下射线：静态 / 运动学网格 / 动态体，取最高命中 ——
        c.playerCapsule.updateMatrixWorld(true);
        c.groundRaycaster.ray.origin.copy(c.playerCapsule.position);
        let bestHit: THREE.Intersection | undefined;
        let hitEntry: KinematicColliderEntry | null = null;
        for (const col of c.collisionWorld.query({ mask: CHARACTER_QUERY_MASK })) {
            if (col.shape.kind !== "mesh") continue;
            const hits = c.groundRaycaster.intersectObject(col.shape.mesh, false);
            if (hits.length > 0 && (!bestHit || hits[0].point.y > bestHit.point.y)) {
                bestHit = hits[0];
                hitEntry = col.motion === "kinematic" ? col.userData as KinematicColliderEntry : null;
            }
        }
        let dynamicHit = c.dynamics.raycastGround(c.playerCapsule.position);
        if (dynamicHit && bestHit && dynamicHit.point.y <= bestHit.point.y) dynamicHit = null;
        if (dynamicHit) {
            bestHit = undefined;
            hitEntry = null;
        }
        // 射线阶段已经在网格与动态体之间选出最高命中，体积探测只作为失效时的补充。
        let groundPoint: THREE.Vector3 | undefined = dynamicHit?.point ?? bestHit?.point;
        let usedShapeGround = false;

        if (c.enableGroundVolumeProbe) {
            // 中心射线没有近距离支撑时，用带宽度的体积探测覆盖细缝两侧。
            const rayGroundDistance = groundPoint
                ? c.playerCapsule.position.y - groundPoint.y
                : Infinity;
            const groundCapsuleInfo = c.playerCapsule.capsuleInfo;

            // 从胶囊下端球心开始向下探测。
            this.groundProbeStart.copy(groundCapsuleInfo.segment.end)
                .applyMatrix4(c.playerCapsule.matrixWorld);
            this.groundProbeDown.copy(c.upVector).negate();

            const lowerCenterOffset = this.groundProbeOffset
                .subVectors(c.playerCapsule.position, this.groundProbeStart)
                .dot(c.upVector);
            const maxProbeDistance = Math.max(0, c.maxH - lowerCenterOffset);
            const sensorRadius = groundCapsuleInfo.radius * GROUND_SENSOR_RADIUS_RATIO;

            // 近距离中心射线仍是快速路径；只有射线错过或命中过远时才执行体积查询。
            const useShapeProbe = rayGroundDistance > c.maxH;
            if (useShapeProbe) {
                let shapeDistance = Infinity;
                let shapeEntry: KinematicColliderEntry | null = null;
                let shapeDynamicHit: DynamicGroundHit | null = null;

                // 静态、运动学及已登记的动态网格都通过 BVH 生成候选支撑面，保留最近命中。
                for (const col of c.collisionWorld.query({ mask: CHARACTER_QUERY_MASK })) {
                    if (col.shape.kind !== "mesh") continue;
                    const hit = probeMeshGround(
                        this.groundProbeStart,
                        this.groundProbeDown,
                        maxProbeDistance,
                        sensorRadius,
                        GROUND_SUPPORT_NORMAL_Y,
                        col.shape.mesh,
                        this.groundProbeTemps,
                    );
                    if (!hit || hit.distance >= shapeDistance) continue;
                    shapeDistance = hit.distance;
                    this.shapeGroundPoint.copy(hit.point);
                    this.shapeGroundNormal.copy(hit.normal);

                    // 保存运动学平台归属。
                    shapeEntry = col.motion === "kinematic"
                        ? col.userData as KinematicColliderEntry
                        : null;
                    shapeDynamicHit = null;
                }

                // 动态球和动态盒使用解析形状查询，再与网格结果竞争最近支撑面。
                const dynamicVolumeHit = c.dynamics.probeGroundVolume(
                    this.groundProbeStart,
                    this.groundProbeDown,
                    maxProbeDistance,
                    sensorRadius,
                    GROUND_SUPPORT_NORMAL_Y,
                );
                if (dynamicVolumeHit) {
                    const dynamicDistance = this.groundProbeOffset
                        .subVectors(dynamicVolumeHit.point, this.groundProbeStart)
                        .dot(this.groundProbeDown);
                    if (dynamicDistance < shapeDistance) {
                        shapeDistance = dynamicDistance;
                        this.shapeGroundPoint.copy(dynamicVolumeHit.point);
                        this.shapeGroundNormal.copy(dynamicVolumeHit.normal);
                        shapeEntry = null;

                        // 保存动态刚体归属。
                        shapeDynamicHit = dynamicVolumeHit;
                    }
                }

                if (Number.isFinite(shapeDistance)) {
                    // 用体积探测结果替换失效射线，同时保持原有贴地、坡度和平台逻辑的输入格式。
                    groundPoint = this.shapeGroundPoint;
                    bestHit = undefined;
                    dynamicHit = shapeDynamicHit;
                    hitEntry = shapeEntry;
                    usedShapeGround = true;
                }
            }

            // 调试圆柱挂在 capsule 下，传局部尺寸，由父级 scale 变换到世界尺度。
            const capsuleScale = c.playerCapsule.scale;
            const sy = capsuleScale.y || 1;
            const sxz = Math.max(1e-6, Math.min(capsuleScale.x || 1, capsuleScale.z || 1));
            this.debug.updateGroundSensor(
                this.groundProbeStart,
                this.groundProbeDown,
                maxProbeDistance / sy,
                sensorRadius / sxz,
                useShapeProbe,
                usedShapeGround,
            );
        } else {
            // 关闭体积探测时隐藏传感区调试体。
            this.debug.updateGroundSensor(
                this.groundProbeStart,
                this.groundProbeDown,
                0,
                0,
                false,
                false,
            );
        }
        this.debug.updateGroundProbe(
            c.groundRaycaster.ray.origin,
            groundPoint ?? null,
            c.maxH,
            c.groundRaycaster.near,
        );
        // —— 重力 / 贴地 snap（飞行跳过） ——
        if (!c.isFlying) {
            if (groundPoint) {
                const snapY = groundPoint.y + c.snapH;
                const dist = c.playerCapsule.position.y - groundPoint.y;
                if (dist > c.maxH) {
                    c.applyGravity(delta); // 离地过远当坠落
                } else if (c.playerVelocity.y <= 0) {
                    if (c.playerIsOnGround) {
                        c.snapToGround(
                            snapY,
                            usedShapeGround
                                ? this.shapeGroundNormal.y >= c.minFloorNormalY
                                : dynamicHit
                                    ? dynamicHit.normal.y >= c.minFloorNormalY
                                    : c.isFlatFloor(bestHit!),
                            delta,
                        );
                    } else {
                        // 下落中：本帧会落到地面则贴地，否则继续重力
                        const predictedY = c.playerCapsule.position.y + c.playerVelocity.y * delta;
                        if (predictedY <= snapY) c.snapToGround(snapY);
                        else c.applyGravity(delta);
                    }
                } else {
                    c.applyGravity(delta); // 上升（跳跃）
                }
            } else {
                c.applyGravity(delta);
            }
            c.playerCapsule.position.y += c.playerVelocity.y * delta;
        }

        c.activeDynamicBody = c.playerIsOnGround ? dynamicHit?.body ?? null : null;
        c.activeKinematicCollider = c.playerIsOnGround && !c.activeDynamicBody ? hitEntry : null;
        this.setDynamicSupport(c.activeDynamicBody);

        // —— 水平（飞行则含竖直）分步移动 + 胶囊推出 ——
        const capsuleInfo = c.playerCapsule.capsuleInfo;
        const xzSpeed = Math.hypot(c.playerVelocity.x, c.playerVelocity.z);
        const requestedDist = c.isFlying ? c.playerVelocity.length() * delta : xzSpeed * delta;
        const totalDist = automaticMove && !c.isFlying
            ? Math.min(requestedDist, automaticMove.maxDistance)
            : requestedDist;
        c.xzDir.set(c.playerVelocity.x, c.isFlying ? c.playerVelocity.y : 0, c.playerVelocity.z).normalize();
        const maxStep = capsuleInfo.radius * 0.8;
        const steps = Math.min(Math.max(1, Math.ceil(totalDist / maxStep)), c.maxMoveSteps);
        const stepDist = totalDist / steps;
        const blockedEpsSq = (maxStep * 0.05) ** 2;
        for (let i = 0; i < steps; i++) {
            c.moveStepOrigin.copy(c.playerCapsule.position);
            c.playerCapsule.position.addScaledVector(c.xzDir, stepDist);
            c.playerCapsule.updateMatrixWorld();

            if (!c.skipCapsuleCollision) {
                const kinMeshes = c.getKinematicColliderEntries();
                for (const mesh of c.getColliderMeshes()) {
                    c.playerCapsule.updateMatrixWorld();
                    const isKin = kinMeshes.some(e => e.mesh === mesh);
                    // 飞行用接到脚底的段；步行用悬空段便于上台阶
                    applyCapsuleCollision(
                        c.playerCapsule,
                        capsuleInfo,
                        mesh,
                        isKin ? c.kinematicTemps : c.staticTemps,
                        undefined,
                        c.isFlying,
                    );
                }
                c.dynamics.collideWithCapsule();

                // 本步几乎没走出去：卡住则提前结束剩余子步
                if (c.playerCapsule.position.distanceToSquared(c.moveStepOrigin) < blockedEpsSq) {
                    break;
                }
            }
        }

        // 在 IK 执行前缓存本帧最终接地结果。
        this.updateGroundSupport(groundPoint, bestHit, dynamicHit, usedShapeGround);

        // 移动结束后刷新调试体，使地面射线/体积传感区与胶囊同步。
        c.playerCapsule.updateMatrixWorld(true);
        this.debug.refreshTransforms();

        // —— 角色朝向（第三人称 / 飞行） ——
        if (automaticMove || !c.isFirstPerson) {
            const camDirFlat = c.camDir.clone().setY(0).normalize().negate();
            const moveDirFlat = c.moveDir.clone().normalize().negate();

            if (!c.isFlying) {
                if (automaticMove && moveDirFlat.lengthSq() > 0) {
                    c.targetMat.lookAt(c.playerCapsule.position, c.playerCapsule.position.clone().add(moveDirFlat), c.playerCapsule.up);
                    c.playerCapsule.quaternion.slerp(c.targetQuat.setFromRotationMatrix(c.targetMat), Math.min(1, c.rotationSpeed * delta));
                } else if (c.cam.mouseMode === 4 || c.cam.mouseMode === 5) {
                    c.targetMat.lookAt(c.playerCapsule.position, c.playerCapsule.position.clone().add(camDirFlat), c.playerCapsule.up);
                    c.playerCapsule.quaternion.copy(c.targetQuat.setFromRotationMatrix(c.targetMat));
                } else if (c.cam.mouseMode === 0 || c.cam.mouseMode === 2) {
                    const lookTarget = c.playerCapsule.position.clone().add(moveDirFlat.lengthSq() > 0 ? moveDirFlat : camDirFlat);
                    c.targetMat.lookAt(c.playerCapsule.position, lookTarget, c.playerCapsule.up);
                    c.playerCapsule.quaternion.slerp(c.targetQuat.setFromRotationMatrix(c.targetMat), Math.min(1, c.rotationSpeed * delta));
                } else if (moveDirFlat.lengthSq() > 0) {
                    c.targetMat.lookAt(c.playerCapsule.position, c.playerCapsule.position.clone().add(moveDirFlat), c.playerCapsule.up);
                    c.playerCapsule.quaternion.slerp(c.targetQuat.setFromRotationMatrix(c.targetMat), Math.min(1, c.rotationSpeed * delta));
                }
            } else {
                const lookTarget = c.playerCapsule.position.clone().add(c.input.fwd ? moveDirFlat : camDirFlat);
                c.targetMat.lookAt(c.playerCapsule.position, lookTarget, c.playerCapsule.up);
                c.playerCapsule.quaternion.slerp(c.targetQuat.setFromRotationMatrix(c.targetMat), Math.min(1, c.rotationSpeed * delta));
            }
        }

        // —— 第三人称相机跟随 ——
        if (c.manageCamera && !c.isFirstPerson) {
            const lookTarget = c.cam.springTarget(c.cam.getLookAtPoint(), delta);
            c.camera.position.sub(c.controls.target);
            c.camera.position.add(lookTarget);
            c.controls.target.copy(lookTarget);
            c.cam.updatePlayerDirection(delta);
            c.controls.update();
            c.cam.applyFlySprintMaxDist();
            c.cam.updateWithRaycast(c.controls.target);
        }

        // 靠近车辆时显示上车按钮
        if (c.isShowMobileControls && c.vehicle.list.length) {
            let near = false;
            for (const veh of c.vehicle.list) {
                if (c.vehicle.isInBoardingRange(veh, c.playerCapsule.position)) {
                    near = true;
                    break;
                }
            }
            if (near !== c.isNearVehicle) {
                c.isNearVehicle = near;
                c.mobileControls?.syncVehicleBtn(near);
            }
        }

        c.animation.setAnimationByPressed();
        c.runAnimationPass(delta);
    }

    /** 将射线或体积探测最终采用的支撑点统一转换成世界空间结果。 */
    private updateGroundSupport(
        point: THREE.Vector3 | undefined,
        meshHit: THREE.Intersection | undefined,
        dynamicHit: DynamicGroundHit | null,
        usedShapeGround: boolean,
    ): void {
        const c = this.ctrl;
        if (c.isFlying || !c.playerIsOnGround || !point) {
            c.clearGroundSupport();
            return;
        }

        if (usedShapeGround) {
            // 体积探测已经返回世界空间法线。
            this.rayGroundNormal.copy(this.shapeGroundNormal);
        } else if (dynamicHit) {
            this.rayGroundNormal.copy(dynamicHit.normal);
        } else if (meshHit?.face) {
            // 射线命中网格法线转换到世界空间。
            this.rayGroundNormal.copy(meshHit.face.normal)
                .applyMatrix3(this.rayGroundNormalMatrix.getNormalMatrix(meshHit.object.matrixWorld))
                .normalize();
        } else {
            this.rayGroundNormal.copy(c.upVector);
        }

        c.setGroundSupport(point, this.rayGroundNormal);
    }

    /** 切换当前动态支撑体并记录位姿。 */
    private setDynamicSupport(body: DynamicBody | null): void {
        if (this.dynamicSupportBody === body) return;
        this.dynamicSupportBody = body;
        if (!body) return;
        this.dynamicSupportPrevPosition.copy(body.position);
        this.dynamicSupportPrevQuaternion.copy(body.quaternion);
    }

    /** 动态支撑体推进后按前后位姿带走人物。 */
    applyDynamicSupportCarry(): void {
        const c = this.ctrl;
        const body = c.activeDynamicBody;
        if (body !== this.dynamicSupportBody) this.setDynamicSupport(body);
        if (!body) return;
        if (!c.dynamics.list.includes(body)) {
            c.activeDynamicBody = null;
            this.setDynamicSupport(null);
            return;
        }
        if (c.controllerMode === 1 || c.isFlying || !c.playerIsOnGround) {
            this.dynamicSupportPrevPosition.copy(body.position);
            this.dynamicSupportPrevQuaternion.copy(body.quaternion);
            return;
        }

        this.dynamicSupportBefore.copy(c.playerCapsule.position);
        this.dynamicSupportInvQuaternion.copy(this.dynamicSupportPrevQuaternion).invert();
        this.dynamicSupportLocal.subVectors(
            c.playerCapsule.position,
            this.dynamicSupportPrevPosition,
        ).applyQuaternion(this.dynamicSupportInvQuaternion);
        c.playerCapsule.position.copy(this.dynamicSupportLocal)
            .applyQuaternion(body.quaternion)
            .add(body.position);
        c.playerCapsule.updateMatrixWorld();

        this.dynamicSupportDelta.subVectors(c.playerCapsule.position, this.dynamicSupportBefore);
        if (c.manageCamera && !c.isFirstPerson && this.dynamicSupportDelta.lengthSq() > 0) {
            c.camera.position.add(this.dynamicSupportDelta);
            c.controls.target.add(this.dynamicSupportDelta);
        }
        this.dynamicSupportPrevPosition.copy(body.position);
        this.dynamicSupportPrevQuaternion.copy(body.quaternion);
    }
}
