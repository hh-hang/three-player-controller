import type { Vector3 } from "three";

/** 校验人物和车辆共用的朝向跟随速度，允许 0 暂停跟随。 */
export function assertDirectionFollowSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0) throw new RangeError("朝向跟随速度必须是有限的非负数。");
}

/** 按时间阻尼沿最短角度转到指定方向后方，保留镜头高度和水平距离。 */
export function dampCameraHeading(
    position: Vector3,
    target: Vector3,
    forwardX: number,
    forwardZ: number,
    speed: number,
    delta: number,
): void {
    if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(delta) || delta <= 0) return;
    if (!Number.isFinite(forwardX) || !Number.isFinite(forwardZ) || forwardX * forwardX + forwardZ * forwardZ < 1e-8) return;
    const offsetX = position.x - target.x;
    const offsetZ = position.z - target.z;
    const radius = Math.hypot(offsetX, offsetZ);
    if (radius < 1e-8) return;

    const targetAngle = Math.atan2(-forwardX, -forwardZ);
    const currentAngle = Math.atan2(offsetX, offsetZ);
    const difference = Math.atan2(Math.sin(targetAngle - currentAngle), Math.cos(targetAngle - currentAngle));
    // 指数阻尼按时间收敛，跨越正负 π 时仍沿最短方向转动。
    const angle = currentAngle + difference * (1 - Math.exp(-speed * delta));
    position.x = target.x + Math.sin(angle) * radius;
    position.z = target.z + Math.cos(angle) * radius;
}
