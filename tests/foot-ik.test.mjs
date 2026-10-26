import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Vector3 } from "three";
import { FootIK } from "../dist/foot-ik.mjs";
import { createPlayer, setupBrowser, makeModel, box, addMesh, addFloor, advance, near, bonePose, assertBonePose } from "./helpers/controller-fixture.mjs";

beforeEach(setupBrowser);

async function prepareIK(t) {
    const fixture = await createPlayer(t);
    addFloor(fixture.player);
    addMesh(fixture.player, box([0.28, 0.2, 0.8], [-0.18, 0.05, 0]));
    await advance(fixture.player, 1);
    fixture.model.updateWorldMatrix(true, true);
    const raw = bonePose(fixture.model);
    const footIK = new FootIK({ skeleton: fixture.skeleton, soleSkinThickness: 0 });
    fixture.player.use(footIK);
    t.after(() => footIK.dispose());
    return { ...fixture, footIK, raw };
}

function animate(player, frames = 60) {
    for (let frame = 0; frame < frames; frame++) player.runAnimationPass(1 / 60);
}

test("FootIK 将一只脚抬到真实台阶上且另一只脚保持贴地", async t => {
    const { player, footIK, skeleton } = await prepareIK(t);
    animate(player);
    assert.ok(footIK.getFootIKWeight("left") > 0.9);
    const left = skeleton.legs.left.foot.getWorldPosition(new Vector3());
    const right = skeleton.legs.right.foot.getWorldPosition(new Vector3());
    near(left.y, 0.15, 0.015, "raised foot contact");
    near(right.y, 0, 0.015, "floor foot contact");
});

test("反复执行 IK 后收敛且骨骼修正不累积", async t => {
    const { player, model } = await prepareIK(t);
    animate(player, 120);
    const settled = bonePose(model);
    animate(player, 300);
    assertBonePose(settled, 1e-5);
});

test("动画更新前的钩子恢复原始动画姿态", async t => {
    const { player, footIK, raw } = await prepareIK(t);
    animate(player);
    footIK.onBeforeAnimationUpdate(1 / 60);
    assertBonePose(raw);
});

for (const [operation, operationName] of [["disable", "停用"], ["detach", "卸载"], ["dispose", "销毁"]]) {
    test(`${operationName}后立即恢复骨骼且后续动画更新不再应用 IK`, async t => {
        const { player, footIK, raw } = await prepareIK(t);
        animate(player);
        assert.ok(footIK.getFootIKWeight("left") > 0.9, "exercise an active correction before releasing it");
        if (operation === "disable") footIK.setEnabled(false);
        if (operation === "detach") player.unuse(footIK);
        if (operation === "dispose") footIK.dispose();
        assertBonePose(raw);
        animate(player);
        assertBonePose(raw);
        near(footIK.getPelvisOffset(), 0);
    });
}

test("离地后释放 IK 且落地后可重新应用", async t => {
    const { player, footIK, raw } = await prepareIK(t);
    animate(player);
    player.setOnGround(false);
    player.runAnimationPass(1 / 60);
    assertBonePose(raw);
    near(footIK.getFootIKWeight("left"), 0);
    near(footIK.getPelvisOffset(), 0);
    // 通过物理更新重新建立地面支撑。
    await advance(player, 0.5);
    animate(player);
    assert.equal(player.playerIsOnGround, true);
    assert.ok(footIK.getFootIKWeight("left") > 0.9);
});

test("切换模型时恢复旧骨骼并重新绑定新骨骼", async t => {
    const { player, footIK, raw } = await prepareIK(t);
    animate(player);
    const replacement = makeModel();
    // 按骨骼名绑定，切换模型后使用新骨骼。
    const names = {
        hips: "hips", legs: Object.fromEntries(["left", "right"].map(side => [side, {
            upper: side + "Upper", lower: side + "Lower", foot: side + "Foot", toe: side + "Toe",
        }])),
    };
    player.unuse(footIK);
    footIK.dispose();
    const rebound = new FootIK({ skeleton: names, soleSkinThickness: 0 });
    player.use(rebound);
    t.after(() => rebound.dispose());
    animate(player);
    await player.switchPlayerModel({ ...player.playerModelConfig, model: replacement.model, animations: replacement.animations });
    assertBonePose(raw);
    await advance(player, 0.5);
    animate(player);
    assert.ok(rebound.getFootIKWeight("left") > 0.9);
    near(replacement.skeleton.legs.left.foot.getWorldPosition(new Vector3()).y, 0.15, 0.015);
    assertBonePose(raw);
});

test("重新启用 IK 时使用当前姿态且不保留旧修正", async t => {
    const { player, footIK, raw } = await prepareIK(t);
    animate(player);
    footIK.setEnabled(false);
    assertBonePose(raw);
    player.playerCapsule.position.x = 2; // 双脚移到同一平地。
    await advance(player, 0.5);
    footIK.setEnabled(true);
    animate(player, 120);
    near(player.playerModel.getObjectByName("leftFoot").getWorldPosition(new Vector3()).y, 0, 0.015);
    near(player.playerModel.getObjectByName("rightFoot").getWorldPosition(new Vector3()).y, 0, 0.015);
});
