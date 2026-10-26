import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { MeshBVH } from "three-mesh-bvh";
import { createPlayer, setupBrowser, box, addFloor, advance } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

test("移除已就绪地板后不再命中且角色开始下落", async t => {
    const { player } = await createPlayer(t);
    const floor = addFloor(player);
    await advance(player, 1);
    assert.equal(player.playerIsOnGround, true);
    player.removeCollider(floor);
    assert.equal(player.collisionWorld.get(floor.id), undefined);
    assert.deepEqual(player.getColliderMeshes(), []);
    await advance(player, 0.5);
    assert.equal(player.playerIsOnGround, false);
    assert.equal(player.getGroundSupport(), null);
    assert.ok(player.playerVelocity.y < 0);
});

for (const [motion, motionName] of [["static", "静态"], ["kinematic", "运动学"]]) {
    for (const [outcome, outcomeName] of [
        ["ready", "完成后参与碰撞"],
        ["removed", "移除后丢弃过期结果"],
        ["failed-after-removal", "移除后构建失败不恢复碰撞体"],
        ["destroyed", "销毁后丢弃过期结果"],
    ]) {
        test(`${motionName}碰撞体异步构建 BVH：${outcomeName}`, async t => {
            const { player } = await createPlayer(t);
            let complete, fail, geometry;
            // 控制 Worker 完成时机，使用实际几何构建 BVH。
            t.mock.method(player.getBvhWorkerPool(), "generate", source => {
                geometry = source;
                return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
            });
            const handle = player.addCollider({ motion, shape: { kind: "mesh", source: box([4, 0.2, 4], [0, -0.1, 0]) }, useWorker: true });
            assert.deepEqual(player.getColliderMeshes(), [], "pending geometry must not participate in collision");
            assert.equal(player.collisionWorld.get(handle.id).ready, false);
            if (outcome === "removed" || outcome === "failed-after-removal") player.removeCollider(handle);
            if (outcome === "destroyed") player.destroy();
            if (outcome === "failed-after-removal") fail(new Error("模拟 Worker 构建失败。"));
            else complete(new MeshBVH(geometry));
            await new Promise(resolve => setImmediate(resolve));
            if (outcome === "ready") {
                assert.equal(player.collisionWorld.get(handle.id).ready, true);
                assert.ok(player.getColliderMeshes().includes(handle.collisionMesh));
                await advance(player, 1);
                assert.equal(player.playerIsOnGround, true);
            } else {
                assert.equal(player.collisionWorld.get(handle.id), undefined);
                assert.equal(geometry.boundsTree, undefined, "stale completion must not attach a BVH to released geometry");
                assert.deepEqual(player.getColliderMeshes(), []);
            }
        });
    }
}
