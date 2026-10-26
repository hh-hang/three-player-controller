import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Vector3 } from "three";
import { RouteFollower } from "../dist/route.mjs";
import { createPlayer, setupBrowser, addFloor, addMesh, box, advance, near, assertFinitePlayer } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

async function createRoute(t, options = {}) {
    const context = await createPlayer(t, options);
    addFloor(context.player);
    await advance(context.player, 0.5);
    const route = new RouteFollower();
    context.player.use(route);
    return { ...context, route };
}

test("关闭键盘输入后仍可到达目标且只通知一次结束", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([2, 0, 0], { onEnd: event => {
        assert.equal(route.state, "idle");
        assert.equal(route.currentIndex, -1);
        assert.equal(player.input.getAutomaticMove(), null);
        events.push(event);
    } });
    await advance(player, 3);
    assert.deepEqual(events.map(event => event.reason), ["completed"]);
    near(player.playerCapsule.position.x, 2, 0.075);
    near(player.playerCapsule.position.z, 0);
    assert.equal(player.bindKeyboardEvents, false);
    assert.equal(player.manageCamera, false);
    near(player.playerVelocity.length(), 0);
    route.cancel();
    assert.equal(events.length, 1);
});

test("路线按顺序经过转角且方向不受相机朝向影响", async t => {
    const { player, route, camera } = await createRoute(t);
    player.setThirdMouseMode(4);
    camera.rotation.y = Math.PI / 3;
    route.follow([[2, 0, 0], [2, 0, 2], [0, 0, 2]]);
    const visited = new Set();
    await advance(player, 6, 60, () => {
        visited.add(route.currentIndex);
        if (route.currentIndex === 1) assert.ok(player.playerCapsule.position.x > 1.8);
        if (route.currentIndex === 2) assert.ok(player.playerCapsule.position.z > 1.8);
        assertFinitePlayer(player);
    });
    assert.ok([0, 1, 2].every(index => visited.has(index)));
    assert.equal(route.state, "idle");
    near(player.playerCapsule.position.x, 0, 0.075);
    near(player.playerCapsule.position.z, 2, 0.075);
});

test("漫游中实时切换跑步和行走时保留进度且同步实际速度与动画", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.follow([[0.3, 0, 0], [15, 0, 0]], { onEnd: event => events.push(event) });
    await advance(player, 0.5);
    assert.equal(route.currentIndex, 1);
    near(Math.hypot(player.playerVelocity.x, player.playerVelocity.z), player.playerSpeed);
    assert.equal(player.getCurrentPlayerAnimationName(), "walk");

    route.setRun(true);
    await advance(player, 0.8);
    assert.equal(route.state, "moving");
    assert.equal(route.currentIndex, 1);
    near(Math.hypot(player.playerVelocity.x, player.playerVelocity.z), player.playerRunSpeed);
    assert.equal(player.getCurrentPlayerAnimationName(), "run");

    route.setRun(false);
    await advance(player, 0.8);
    assert.equal(route.state, "moving");
    assert.equal(route.currentIndex, 1);
    near(Math.hypot(player.playerVelocity.x, player.playerVelocity.z), player.playerSpeed);
    assert.equal(player.getCurrentPlayerAnimationName(), "walk");
    assert.equal(events.length, 0);
    await advance(player, 10);
    assert.deepEqual(events.map(event => event.reason), ["completed"]);
    assert.equal(events[0].waypointCount, 2);
    assert.equal(events[0].waypointIndex, 1);
    near(player.playerCapsule.position.x, 15, 0.075);
});

test("暂停时切换跑步状态不会恢复移动且继续后使用新速度", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.follow([[0.3, 0, 0], [15, 0, 0]], { onEnd: event => events.push(event.reason) });
    await advance(player, 0.5);
    route.pause();
    await advance(player, 0.5);
    const stopped = player.playerCapsule.position.clone();
    route.setRun(true);
    await advance(player, 1);
    assert.equal(route.state, "paused");
    assert.equal(route.currentIndex, 1);
    near(player.playerCapsule.position.distanceTo(stopped), 0);
    assert.equal(events.length, 0);

    route.resume();
    await advance(player, 0.8);
    near(Math.hypot(player.playerVelocity.x, player.playerVelocity.z), player.playerRunSpeed);
    assert.equal(player.getCurrentPlayerAnimationName(), "run");
    assert.equal(route.currentIndex, 1);
    assert.equal(events.length, 0);
    route.cancel();
    assert.deepEqual(events, ["cancelled"]);
});

test("暂停保留目标和进度且暂停时间不计入受阻超时", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([4, 0, 0], { blockedTimeout: 0.2, onEnd: event => events.push(event) });
    await advance(player, 0.3);
    route.pause();
    await advance(player, 2);
    const stopped = player.playerCapsule.position.clone();
    await advance(player, 1);
    near(player.playerCapsule.position.distanceTo(stopped), 0);
    assert.equal(route.currentIndex, 0);
    assert.equal(route.state, "paused");
    assert.equal(events.length, 0);
    // 模拟应用在暂停期间改变位置，恢复时应重新朝向原目标。
    player.playerCapsule.position.z = 2;
    route.resume();
    await advance(player, 4);
    assert.deepEqual(events.map(event => event.reason), ["completed"]);
    near(player.playerCapsule.position.distanceTo(new Vector3(4, player.getCapsuleGroundHeight(), 0)), 0, 0.075);
});

test("暂停期间仍受重力影响并继续随运动平台移动", async t => {
    const { player } = await createPlayer(t);
    const platform = box([10, 0.2, 10], [0, -0.1, 0]);
    addMesh(player, platform, "kinematic");
    await advance(player, 0.5);
    const route = new RouteFollower();
    player.use(route);
    route.moveTo([3, 0, 0]);
    route.pause();
    const start = player.playerCapsule.position.clone();
    await advance(player, 1, 60, () => { platform.position.x += 0.01; platform.updateMatrixWorld(true); });
    near(player.playerCapsule.position.x - start.x, 0.6, 1e-4);
    assert.equal(route.state, "paused");
    player.clearColliders();
    await advance(player, 0.2);
    assert.ok(player.playerCapsule.position.y < start.y - 0.1);
    assert.equal(route.state, "paused");
});

test("取消清理路线且不会吞掉随后传入的手动移动", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([4, 0, 0], { onEnd: event => events.push(event) });
    await advance(player, 0.2);
    player.setInput({ moveY: 1 });
    const start = player.playerCapsule.position.clone();
    await advance(player, 0.5);
    assert.deepEqual(events.map(event => event.reason), ["cancelled"]);
    near(player.playerCapsule.position.x, start.x);
    assert.ok(player.playerCapsule.position.z < start.z - 0.5);
    route.cancel();
    assert.equal(events.length, 1);
});

test("内置键盘仅在绑定时打断路线而转动视角不打断", async t => {
    const { player, route } = await createRoute(t);
    const pressW = () => {
        const event = new Event("keydown");
        Object.defineProperties(event, { code: { value: "KeyW" }, key: { value: "w" } });
        window.dispatchEvent(event);
    };
    route.moveTo([4, 0, 0]);
    pressW();
    player.setInput({ lookDeltaX: 5, lookDeltaY: 2 });
    await advance(player, 0.2);
    assert.equal(route.state, "moving");
    player.setBindKeyboardEvents(true);
    pressW();
    assert.equal(route.state, "idle");
    assert.equal(player.input.fwd, true);
});

test("跳跃和飞行输入可以打断暂停中的路线", async t => {
    const { player, route } = await createRoute(t);
    route.moveTo([4, 0, 0]);
    route.pause();
    player.setInput({ jump: true });
    assert.equal(route.state, "idle");
    assert.ok(player.playerVelocity.y > 0);
    await advance(player, 1);
    route.moveTo([4, 0, 0]);
    player.setInput({ toggleFly: true });
    assert.equal(route.state, "idle");
    assert.equal(player.isFlying, true);
});

test("墙壁阻挡后以受阻原因结束且不穿墙", async t => {
    const { player, route } = await createRoute(t);
    addMesh(player, box([0.2, 5, 10], [1, 2.5, 0]));
    const events = [];
    route.moveTo([3, 0, 0], { blockedTimeout: 0.3, onEnd: event => events.push(event) });
    await advance(player, 2);
    assert.deepEqual(events.map(event => event.reason), ["blocked"]);
    assert.ok(player.playerCapsule.position.x <= 0.601);
    assert.equal(player.input.getAutomaticMove(), null);
});

test("相同水平位置但不同楼层不能视为到达", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([0, 3, 0], { blockedTimeout: 0.2, onEnd: event => events.push(event) });
    await advance(player, 0.5);
    assert.deepEqual(events.map(event => event.reason), ["blocked"]);
    near(player.playerCapsule.position.y, player.getCapsuleGroundHeight());
});

test("关闭受阻超时后保留无法到达的路线直到取消", async t => {
    const { player, route } = await createRoute(t);
    route.moveTo([0, 3, 0], { blockedTimeout: 0 });
    await advance(player, 3);
    assert.equal(route.state, "moving");
    route.cancel();
    assert.equal(route.state, "idle");
});

test("循环路线跨越多圈且重复目标点不会阻塞更新", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.follow([[0, 0, 0], [0, 0, 0], [1, 0, 0]], { loop: true, onEnd: event => events.push(event) });
    let returns = 0;
    let previous = -1;
    await advance(player, 5, 60, () => {
        if (route.currentIndex === 0 && previous === 2) returns++;
        previous = route.currentIndex;
        assertFinitePlayer(player);
    });
    assert.ok(returns >= 2);
    assert.equal(events.length, 0);
    route.follow([[0, 0, 0], [0, 0, 0]], { loop: true });
    player.playerCapsule.position.x = 0;
    await advance(player, 0.5);
    assert.equal(route.state, "moving");
    assertFinitePlayer(player);
});

for (const run of [false, true]) {
    test(`连续更改${run ? "跑步" : "行走"}目标时保留速度和动画播放进度`, async t => {
        const { player, route } = await createRoute(t);
        const ended = [];
        const changes = [];
        const options = { run, onEnd: event => {
            assert.equal(route.state, "idle");
            assert.equal(player.input.getAutomaticMove(), null);
            ended.push(event.reason);
        } };
        route.moveTo([10, 0, 0], options);
        await advance(player, 0.5);
        const action = player.animation.state;
        player.onAnimationChange = name => changes.push(name);
        for (let index = 0; index < 10; index++) {
            const time = action.time;
            const velocity = player.playerVelocity.clone();
            route.moveTo([10 + index * 0.1, 0, 0], options);
            assert.equal(player.animation.state, action);
            near(action.time, time);
            near(player.playerVelocity.distanceTo(velocity), 0);
            assert.equal(route.state, "moving");
            await player.update(1 / 60);
            near(action.time, time + 1 / 60);
            assert.equal(player.getCurrentPlayerAnimationName(), run ? "run" : "walk");
        }
        assert.deepEqual(changes, []);
        assert.deepEqual(ended, Array(10).fill("cancelled"));
        route.cancel();
        assert.equal(player.getCurrentPlayerAnimationName(), "idle");
        near(player.playerVelocity.length(), 0);
    });
}

test("替换路线切换行走和跑步时直接过渡且不插入待机动画", async t => {
    const { player, route } = await createRoute(t);
    route.moveTo([10, 0, 0]);
    await advance(player, 0.5);
    const changes = [];
    player.onAnimationChange = name => changes.push(name);
    route.moveTo([12, 0, 0], { run: true });
    await player.update(1 / 60);
    assert.equal(player.getCurrentPlayerAnimationName(), "run");
    route.moveTo([14, 0, 0], { run: false });
    await player.update(1 / 60);
    assert.equal(player.getCurrentPlayerAnimationName(), "walk");
    assert.deepEqual(changes, ["running", "walking"]);
});

test("路线替换被结束回调中的卸载中止时清理移动和动画", async t => {
    const { player, route } = await createRoute(t);
    route.moveTo([10, 0, 0], { onEnd: () => player.unuse(route) });
    await advance(player, 0.5);
    route.moveTo([12, 0, 0]);
    assert.equal(route.state, "idle");
    assert.equal(player.input.getAutomaticMove(), null);
    assert.equal(player.getCurrentPlayerAnimationName(), "idle");
    near(player.playerVelocity.length(), 0);
});

test("路线替换的结束回调抛出异常时仍停止移动且不重复通知", async t => {
    const { player, route } = await createRoute(t);
    let ended = 0;
    route.moveTo([10, 0, 0], { onEnd: () => {
        ended++;
        throw new Error("路线结束回调执行失败。");
    } });
    await advance(player, 0.5);
    assert.throws(() => route.moveTo([12, 0, 0]), /路线结束回调执行失败/);
    assert.equal(route.state, "idle");
    assert.equal(player.input.getAutomaticMove(), null);
    assert.equal(player.getCurrentPlayerAnimationName(), "idle");
    near(player.playerVelocity.length(), 0);
    route.cancel();
    assert.equal(ended, 1);
});

test("新目标已经在脚下时正常完成且不残留前一条路线的速度", async t => {
    const { player, route } = await createRoute(t);
    route.moveTo([10, 0, 0]);
    await advance(player, 0.5);
    const position = player.playerCapsule.position.clone();
    const events = [];
    route.moveTo([position.x, 0, position.z], { onEnd: event => events.push(event.reason) });
    await player.update(1 / 60);
    assert.deepEqual(events, ["completed"]);
    near(player.playerCapsule.position.distanceTo(position), 0);
    near(player.playerVelocity.length(), 0);
    assert.equal(player.getCurrentPlayerAnimationName(), "idle");
});

test("替换路线取消旧路线且结束回调可以安全启动新路线", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([3, 0, 0], { onEnd: event => {
        events.push(event.reason);
        route.moveTo([0, 0, 2], { onEnd: event => events.push(event.reason) });
    } });
    await advance(player, 0.2);
    // 旧路线结束回调中的新路线优先，外层替换不应再次覆盖它。
    route.moveTo([9, 0, 0]);
    await advance(player, 3);
    assert.deepEqual(events, ["cancelled", "completed"]);
    near(player.playerCapsule.position.z, 2, 0.075);
    near(player.playerCapsule.position.x, 0, 0.075);
});

test("完成回调启动下一条路线时保留新移动指令", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([1, 0, 0], { onEnd: event => {
        events.push(event.reason);
        route.moveTo([1, 0, 1], { onEnd: event => events.push(event.reason) });
    } });
    await advance(player, 3);
    assert.deepEqual(events, ["completed", "completed"]);
    near(player.playerCapsule.position.z, 1, 0.075);
});

test("复制传入的目标且无效参数不会破坏正在执行的路线", async t => {
    const { player, route } = await createRoute(t);
    const target = new Vector3(2, 0, 0);
    route.moveTo(target);
    target.x = 100;
    assert.throws(() => route.follow([]));
    assert.throws(() => route.moveTo([NaN, 0, 0]));
    assert.throws(() => route.moveTo([2, 0, 0], { arrivalRadius: 0 }));
    assert.throws(() => route.moveTo([2, 0, 0], { blockedTimeout: -1 }));
    await advance(player, 3);
    near(player.playerCapsule.position.x, 2, 0.075);
});

test("卸载和销毁清理移动且销毁回调不能重新绑定输入", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([5, 0, 0], { onEnd: event => events.push(event.reason) });
    await advance(player, 0.2);
    player.unuse(route);
    const position = player.playerCapsule.position.clone();
    await advance(player, 0.3);
    near(player.playerCapsule.position.distanceTo(position), 0);
    assert.deepEqual(events, ["cancelled"]);
    assert.throws(() => route.moveTo([1, 0, 0]));
    player.use(route);
    route.moveTo([5, 0, 0], { onEnd: () => player.setBindKeyboardEvents(true) });
    player.destroy();
    assert.equal(route.state, "idle");
    assert.equal(player.bindKeyboardEvents, false);
    assert.equal(player.input.getAutomaticMove(), null);
    assert.throws(() => route.moveTo([1, 0, 0]));
});

test("销毁时路线回调抛错仍释放全部资源并保留原始异常", async t => {
    const { player, route, scene } = await createRoute(t);
    const capsule = player.playerCapsule;
    const failure = new Error("路线结束回调执行失败。");
    const calls = [];
    player.use({
        name: "cleanup-check",
        /** 记录卸载，确认前一个插件的异常不影响后续插件。 */
        onDetach() { calls.push("detached"); throw new Error("后续插件卸载失败。"); },
        /** 记录资源释放，确认卸载异常后仍继续清理。 */
        dispose() { calls.push("disposed"); throw new Error("后续插件释放失败。"); },
    });
    let ended = 0;
    route.moveTo([5, 0, 0], { onEnd() {
        ended++;
        throw failure;
    } });
    await advance(player, 0.2);
    const disposeRoute = t.mock.method(route, "dispose");
    assert.throws(() => player.destroy(), error => error === failure);
    assert.equal(ended, 1);
    assert.equal(disposeRoute.mock.callCount(), 1);
    assert.deepEqual(calls, ["detached", "disposed"]);
    assert.equal(route.state, "idle");
    assert.equal(player.input.getAutomaticMove(), null);
    assert.equal(player.playerCapsule === null, true);
    assert.equal(player.playerModel === null, true);
    assert.equal(scene.children.includes(capsule), false);
    assert.equal(player.getPlugins().length, 0);
    assert.deepEqual(player.getColliderMeshes(), []);
    assert.doesNotThrow(() => player.destroy());
    assert.equal(ended, 1);
});

test("跨玩家挂载失败不登记插件或中断任一玩家原有路线", async t => {
    const { player: first, route } = await createRoute(t);
    const { player: second, route: original } = await createRoute(t);
    route.moveTo([5, 0, 0]);
    original.moveTo([0, 0, 5]);
    await advance(first, 0.2);
    await advance(second, 0.2);
    assert.throws(() => second.use(route), /已挂载到其他玩家/);
    assert.equal(second.getPlugins().length, 1);
    assert.equal(second.getPlugins()[0] === original, true);
    assert.equal(original.state, "moving");
    assert.equal(second.input.getAutomaticMove().owner, original);
    second.destroy();
    assert.equal(route.state, "moving");
    assert.equal(first.input.getAutomaticMove().owner, route);
    await advance(first, 3);
    assert.equal(route.state, "idle");
    near(first.playerCapsule.position.x, 5, 0.075);
});

test("已销毁路线挂载失败后仍保留原插件且有效替换正常结束旧路线", async t => {
    const { player, route } = await createRoute(t);
    const ended = [];
    route.moveTo([5, 0, 0], { onEnd: event => ended.push(event.reason) });
    const disposed = new RouteFollower();
    disposed.dispose();
    assert.throws(() => player.use(disposed), /已销毁/);
    assert.equal(player.getPlugins().length, 1);
    assert.equal(player.getPlugins()[0] === route, true);
    assert.equal(route.state, "moving");
    assert.deepEqual(ended, []);
    const replacement = new RouteFollower();
    player.use(replacement);
    assert.equal(player.getPlugins().length, 1);
    assert.equal(player.getPlugins()[0] === replacement, true);
    assert.deepEqual(ended, ["cancelled"]);
    replacement.moveTo([0, 0, 2]);
    await advance(player, 3);
    assert.equal(replacement.state, "idle");
    near(player.playerCapsule.position.z, 2, 0.075);
});

for (const fps of [30, 120]) {
    test(`${fps} FPS 下高速短路线不越过终点且使用跑步动画`, async t => {
        const { player, route } = await createRoute(t);
        route.moveTo([0.4, 0, 0], { run: true });
        await player.update(1 / fps);
        assert.equal(player.getCurrentPlayerAnimationName(), "run");
        await advance(player, 1, fps, () => assert.ok(player.playerCapsule.position.x <= 0.401));
        assert.equal(route.state, "idle");
        near(player.playerCapsule.position.x, 0.4, 0.075);
    });
}

test("路线期间切换键盘绑定不清除路线指令且结束后保留外部冲刺输入", async t => {
    const { player, route } = await createRoute(t);
    player.setInput({ shift: true });
    route.moveTo([2, 0, 0]);
    await advance(player, 0.1);
    assert.equal(player.input.shift, false);
    player.setBindKeyboardEvents(true);
    player.setBindKeyboardEvents(false);
    assert.equal(route.state, "moving");
    await advance(player, 3);
    assert.equal(route.state, "idle");
    // 关闭键盘绑定只清除键盘状态，外部冲刺状态应在路线结束后恢复。
    assert.equal(player.input.shift, true);
    route.moveTo([3, 0, 0]);
    await advance(player, 2);
    assert.equal(player.input.shift, true);
});

test("减速参数为零时仍能移动到目标且到达后停止", async t => {
    const { player, route } = await createRoute(t);
    player.playerDeceleration = 0;
    route.moveTo([1, 0, 0]);
    await advance(player, 2);
    assert.equal(route.state, "idle");
    near(player.playerCapsule.position.x, 1, 0.075);
    near(player.playerVelocity.length(), 0);
});

test("小比例角色使用世界坐标且默认到达容差随胶囊尺寸确定", async t => {
    const { player, route } = await createRoute(t, { scale: 0.001 });
    const events = [];
    route.moveTo([0.2, 0, 0], { onEnd: event => events.push(event.reason) });
    await advance(player, 3);
    assert.deepEqual(events, ["completed"]);
    near(player.playerCapsule.position.x, 0.2, 0.0075);
    near(player.playerCapsule.position.y, player.getCapsuleGroundHeight());
});

test("结束时的动画回调再次取消路线也只通知一次", async t => {
    const { player, route } = await createRoute(t);
    const events = [];
    route.moveTo([1, 0, 0], { onEnd: event => events.push(event.reason) });
    player.onAnimationChange = name => { if (name === "idle") route.cancel(); };
    await advance(player, 2);
    assert.deepEqual(events, ["completed"]);
});

for (const target of [[0, 0, 0], [0.1, 0, 0]]) {
    test(`结束回调销毁角色时安全终止当前更新：目标 ${target[0]}`, async t => {
        const { player, route } = await createRoute(t);
        route.moveTo(target, { onEnd: () => player.destroy() });
        await advance(player, 1, 10);
        assert.equal(player.playerCapsule, null);
        assert.equal(route.state, "idle");
    });
}
