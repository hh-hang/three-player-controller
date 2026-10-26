import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Group, PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RouteFollower } from "../dist/route.mjs";
import { createPlayer, setupBrowser, addFloor, addMesh, box, advance, near } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

/** 使用真实轨道控制器计算视角，无需连接浏览器事件。 */
async function createHeadingPlayer(t, options = {}) {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.01, 1000);
    const controls = new OrbitControls(camera);
    const context = await createPlayer(t, { manageCamera: true, bindLookEvents: false, ...options, camera, controls });
    addFloor(context.player);
    await advance(context.player, 0.5);
    setOrbit(context.player);
    return { ...context, camera, controls };
}

/** 设置相机相对目标的水平角度和高度。 */
function setOrbit(player, angle = 0) {
    const { camera, controls } = player;
    controls.target.copy(player.cam.getLookAtPoint());
    camera.position.copy(controls.target).add(new Vector3(Math.sin(angle) * 4, 2, Math.cos(angle) * 4));
    controls.update();
}

/** 获取相机相对目标的水平角度。 */
function orbitAngle(player) {
    const offset = player.camera.position.clone().sub(player.controls.target);
    return Math.atan2(offset.x, offset.z);
}

/** 计算跨越正负 π 时的最短角度差。 */
function angleDifference(target, current) {
    return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

/** 沿世界 X 正方向移动，保持人物朝向不受相机转动影响。 */
function startStraightRoute(player) {
    player.playerCapsule.rotation.y = Math.PI / 2;
    const route = new RouteFollower();
    player.use(route);
    route.moveTo([10, 0, 0]);
    return route;
}

/** 加载带四个车轮的几何模型，使用真实车辆实例和底盘速度。 */
async function createCameraVehicle(player, options = {}) {
    const model = new Group();
    model.add(box([2, 1, 4], [0, 1, 0]));
    const wheelsNames = [];
    for (const [index, position] of [[-1, 0.4, -1.3], [1, 0.4, -1.3], [-1, 0.4, 1.3], [1, 0.4, 1.3]].entries()) {
        const wheel = box([0.4, 0.5, 0.5], position);
        wheel.name = `wheel_${index}`;
        wheelsNames.push(wheel.name);
        model.add(wheel);
    }
    const vehicle = await player.loadVehicleModel({
        model, wheelsNames, scale: 0.2, modelRotation: 0,
        position: new Vector3(), driverSeatPosition: new Vector3(), ...options,
    });
    assert.ok(vehicle);
    return vehicle;
}

/** 切换到车辆相机并设置稳定的行驶方向，隔离悬挂对转向测试的影响。 */
function startVehicleCamera(player, vehicle) {
    player.vehicle.active = vehicle;
    player.controllerMode = 1;
    player.setInput({ moveY: 1 });
    vehicle.chassisBody.setLinvel({ x: 3, y: 0, z: 0 });
    setOrbit(player);
}

test("朝向跟随默认关闭且运行时开关和停步观察正常工作", async t => {
    const { player } = await createHeadingPlayer(t);
    assert.equal(player.cam.followPlayerDirection, false);
    const route = startStraightRoute(player);
    await advance(player, 0.5);
    near(orbitAngle(player), 0);
    player.setFollowPlayerDirection(true);
    await advance(player, 0.5);
    const angle = orbitAngle(player);
    near(Math.abs(angleDifference(-Math.PI / 2, angle)), Math.PI / 2 * Math.exp(-3 * 0.5));
    player.setFollowPlayerDirection(false);
    await advance(player, 0.25);
    near(orbitAngle(player), angle);
    route.pause();
    player.setFollowPlayerDirection(true);
    await advance(player, 0.5);
    near(orbitAngle(player), angle);
});

for (const fps of [30, 60, 120]) {
    test(`${fps} FPS 下朝向跟随按相同时间收敛且不改变仰角`, async t => {
        const { player, camera, controls } = await createHeadingPlayer(t, {
            followPlayerDirection: true, playerDirectionFollowSpeed: 4,
        });
        startStraightRoute(player);
        await advance(player, 1, fps);
        near(Math.abs(angleDifference(-Math.PI / 2, orbitAngle(player))), Math.PI / 2 * Math.exp(-4));
        const offset = camera.position.clone().sub(controls.target);
        near(Math.atan2(offset.y, Math.hypot(offset.x, offset.z)), Math.atan2(2, 4));
        const direction = camera.getWorldDirection(new Vector3());
        near(direction.dot(offset.normalize().negate()), 1);
    });
}

test("跟随速度可配置且零速度、无效参数不会破坏相机状态", async t => {
    const { player, camera } = await createHeadingPlayer(t, {
        followPlayerDirection: true, playerDirectionFollowSpeed: 0,
    });
    player.playerCapsule.rotation.y = Math.PI / 2;
    player.setInput({ moveX: 1 });
    const before = camera.position.clone();
    player.cam.updatePlayerDirection(0.5);
    near(camera.position.distanceTo(before), 0);
    player.setPlayerDirectionFollowSpeed(1);
    player.cam.updatePlayerDirection(0.5);
    const slowError = Math.abs(angleDifference(-Math.PI / 2, orbitAngle(player)));
    setOrbit(player);
    player.setPlayerDirectionFollowSpeed(8);
    player.cam.updatePlayerDirection(0.5);
    const fastError = Math.abs(angleDifference(-Math.PI / 2, orbitAngle(player)));
    assert.ok(fastError < slowError);
    for (const speed of [-1, NaN, Infinity]) assert.throws(() => player.setPlayerDirectionFollowSpeed(speed), RangeError);
    assert.equal(player.cam.playerDirectionFollowSpeed, 8);
});

test("跨越正负 π 时沿最短方向转动且保留水平距离和高度", async t => {
    const { player, camera, controls } = await createHeadingPlayer(t, { followPlayerDirection: true });
    player.playerCapsule.rotation.y = 0.05;
    player.setInput({ moveX: 1 });
    setOrbit(player, Math.PI - 0.05);
    const before = camera.position.clone().sub(controls.target);
    player.cam.updatePlayerDirection(0.2);
    const after = camera.position.clone().sub(controls.target);
    near(Math.hypot(after.x, after.z), Math.hypot(before.x, before.z));
    near(after.y, before.y);
    near(Math.abs(angleDifference(-Math.PI + 0.05, orbitAngle(player))), 0.1 * Math.exp(-3 * 0.2));
});

test("外部相机、第一人称和载具模式不应用人物朝向跟随", async t => {
    for (const mode of ["external", "first-person", "vehicle"]) {
        const { player, camera } = await createHeadingPlayer(t, { followPlayerDirection: true });
        player.setInput({ moveX: 1 });
        if (mode === "external") player.setManageCamera(false);
        if (mode === "first-person") player.changeView();
        if (mode === "vehicle") player.controllerMode = 1;
        const before = camera.position.clone();
        player.cam.updatePlayerDirection(0.5);
        near(camera.position.distanceTo(before), 0);
    }
});

test("朝向跟随后仍对转向路径上的墙壁执行相机避障", async t => {
    const { player, camera, controls } = await createHeadingPlayer(t, {
        followPlayerDirection: true, playerDirectionFollowSpeed: 8,
    });
    addMesh(player, box([0.2, 8, 20], [-1.5, 4, 0]));
    startStraightRoute(player);
    await advance(player, 0.6);
    assert.ok(camera.position.distanceTo(controls.target) < player.cam.maxDist * 0.95);
    assert.ok(camera.position.x > -1.65);
});

test("车辆加载默认和指定的跟随速度且运行时修改只影响指定车辆", async t => {
    const { player } = await createHeadingPlayer(t);
    const first = await createCameraVehicle(player);
    const second = await createCameraVehicle(player, { vehicleDirectionFollowSpeed: 4 });
    near(first.vehicleDirectionFollowSpeed, 3);
    near(second.vehicleDirectionFollowSpeed, 4);
    player.setVehicleDirectionFollowSpeed(first, 2);
    near(first.vehicleDirectionFollowSpeed, 2);
    near(second.vehicleDirectionFollowSpeed, 4);
    player.setFollowVehicleDirection(first, false);
    assert.equal(first.followVehicleDirection, false);
    assert.equal(second.followVehicleDirection, true);
    near(first.vehicleDirectionFollowSpeed, 2);
    player.setFollowVehicleDirection(first, true);
    assert.equal(first.followVehicleDirection, true);
    near(first.vehicleDirectionFollowSpeed, 2);
    for (const speed of [-1, NaN, Infinity]) assert.throws(() => player.setVehicleDirectionFollowSpeed(first, speed), RangeError);
    near(first.vehicleDirectionFollowSpeed, 2);
});

for (const fps of [30, 60, 120]) {
    test(`${fps} FPS 下车辆和人物的朝向跟随采用相同速度与收敛规则`, async t => {
        const { player, camera, controls } = await createHeadingPlayer(t);
        const vehicle = await createCameraVehicle(player, { vehicleDirectionFollowSpeed: 4 });
        startVehicleCamera(player, vehicle);
        for (let frame = 0; frame < fps; frame++) player.cam.updateThirdPersonVehicle(1 / fps);
        near(Math.abs(angleDifference(-Math.PI / 2, orbitAngle(player))), Math.PI / 2 * Math.exp(-4));
        const offset = camera.position.clone().sub(controls.target);
        near(Math.atan2(offset.y, Math.hypot(offset.x, offset.z)), Math.atan2(2, 4));
        near(camera.getWorldDirection(new Vector3()).dot(offset.normalize().negate()), 1);
    });
}

test("车辆跟随的开关、零速度和松开行驶输入分别保留观察角度", async t => {
    const { player } = await createHeadingPlayer(t);
    const vehicle = await createCameraVehicle(player, { vehicleDirectionFollowSpeed: 0 });
    startVehicleCamera(player, vehicle);
    player.cam.updateThirdPersonVehicle(0.5);
    near(orbitAngle(player), 0);
    assert.equal(vehicle.followVehicleDirection, true);
    player.setVehicleDirectionFollowSpeed(vehicle, 3);
    player.cam.updateThirdPersonVehicle(0.5);
    const followedAngle = orbitAngle(player);
    assert.ok(Math.abs(followedAngle) > 0.5);
    player.setFollowVehicleDirection(vehicle, false);
    player.cam.updateThirdPersonVehicle(0.5);
    near(orbitAngle(player), followedAngle);
    player.setFollowVehicleDirection(vehicle, true);
    player.cam.updateThirdPersonVehicle(0.5);
    const resumedAngle = orbitAngle(player);
    assert.ok(Math.abs(resumedAngle) > Math.abs(followedAngle));
    player.setInput({ moveY: 0 });
    player.cam.updateThirdPersonVehicle(0.5);
    near(orbitAngle(player), resumedAngle);
});

test("车辆倒车时跟随实际行驶方向且第一人称和外部相机保持独立", async t => {
    const { player, camera } = await createHeadingPlayer(t);
    const vehicle = await createCameraVehicle(player, { vehicleDirectionFollowSpeed: 3 });
    startVehicleCamera(player, vehicle);
    player.setInput({ moveY: -1 });
    vehicle.chassisBody.setLinvel({ x: -3, y: 0, z: 0 });
    player.cam.updateThirdPersonVehicle(0.5);
    near(Math.abs(angleDifference(Math.PI / 2, orbitAngle(player))), Math.PI / 2 * Math.exp(-1.5));
    player.isFirstPerson = true;
    const before = camera.position.clone();
    player.cam.updateThirdPersonVehicle(0.5);
    near(camera.position.distanceTo(before), 0);
    player.isFirstPerson = false;
    player.setManageCamera(false);
    const released = camera.position.clone();
    player.cam.updateThirdPersonVehicle(0.5);
    near(camera.position.distanceTo(released), 0);
});

test("车辆先跟随方向再执行避障，转向当帧即可检测墙壁", async t => {
    const { player, camera, controls } = await createHeadingPlayer(t);
    const vehicle = await createCameraVehicle(player, { vehicleDirectionFollowSpeed: 100 });
    startVehicleCamera(player, vehicle);
    addMesh(player, box([0.2, 8, 20], [-1.5, 4, 0]));
    player.cam.updateThirdPersonVehicle(0.1);
    assert.ok(camera.position.distanceTo(controls.target) < 4);
});
