import { BufferGeometry, Line, LineBasicMaterial, Matrix3, Raycaster, Vector2, Vector3 } from "three";
import { RouteFollower } from "../src/route";

/** 创建路线演示 */
export function createRouteDemo({ player, scene, camera, canvas, folder, onMouseModeChange }) {
    const route = new RouteFollower();
    player.use(route);
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const normalMatrix = new Matrix3();
    const line = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0xffc857, depthTest: true }));
    line.renderOrder = 10;
    line.visible = false;
    scene.add(line);
    let previousMouseMode = null;
    let pointerStart = null;
    const params = {
        clickToMove: true,
        run: false,
        loop: false,
        lastEnd: "--",
        /** 获取当前路线状态，供面板只读显示。 */
        get state() { return route.state; },
        /** 获取当前目标序号，空闲时显示占位符。 */
        get waypoint() { return route.currentIndex < 0 ? "--" : String(route.currentIndex + 1); },
        /** 按面板设置启动预设路线。 */
        start() {
            startRoute([[6.5, 0, 0.5], [8.5, 0, 0.5], [8.5, 0, 2.5], [6.5, 0, 2.5]], params.loop);
        },
        /** 暂停路线移动，保留当前目标和进度。 */
        pause() { route.pause(); },
        /** 从当前位置继续路线移动。 */
        resume() { route.resume(); },
        /** 取消当前路线并触发结束通知。 */
        cancel() { route.cancel(); },
    };

    /** 启动指定路线并更新路线显示。 */
    function startRoute(points, loop = false) {
        if (player.isFlying || player.controllerMode !== 0) {
            params.lastEnd = "Walking mode required";
            return;
        }
        try {
            route.follow(points, {
                run: params.run, loop,
                /** 路线结束后更新结束原因并隐藏路线。 */
                onEnd(event) {
                    params.lastEnd = event.reason;
                    line.visible = false;
                },
            });
            params.lastEnd = "--";
        } catch (error) {
            params.lastEnd = error.message;
            return;
        }
        const foot = player.playerCapsule.getWorldPosition(new Vector3());
        foot.y -= player.getCapsuleGroundHeight();
        const vertices = [foot, ...points.map(point => new Vector3(...point))];
        if (loop) vertices.push(new Vector3(...points[0]));
        vertices.forEach(point => { point.y += 0.025; });
        line.geometry.dispose();
        line.geometry = new BufferGeometry().setFromPoints(vertices);
        line.visible = true;
    }

    // 点击移动开启时切换到非锁定鼠标模式，关闭时恢复原模式。
    folder.add(params, "clickToMove").name("Click to Move").listen().onChange(enabled => {
        if (enabled && player.isFirstPerson) {
            params.clickToMove = false;
            params.lastEnd = "Third person required";
            return;
        }
        if (enabled) {
            previousMouseMode = player.cam.mouseMode;
            player.setThirdMouseMode(3);
        } else if (previousMouseMode !== null) {
            player.setThirdMouseMode(previousMouseMode);
            previousMouseMode = null;
        }
        onMouseModeChange(player.cam.mouseMode);
    }).domElement.title = "Click a walkable surface; drag to rotate the view. Uses mouse mode 3 while enabled.";
    // 漫游中实时切换行走和跑步，暂停时保留选择供恢复后使用。
    folder.add(params, "run").name("Run").onChange(value => route.setRun(value));
    folder.add(params, "loop").name("Loop Demo Route");
    folder.add(params, "start").name("Start Demo Route");
    folder.add(params, "pause").name("Pause");
    folder.add(params, "resume").name("Resume");
    folder.add(params, "cancel").name("Cancel");
    folder.add(params, "state").name("State").listen().disable();
    folder.add(params, "waypoint").name("Waypoint").listen().disable();
    folder.add(params, "lastEnd").name("Last End").listen().disable();
    folder.close();

    /** 记录主指针按下位置，用于区分点击和拖拽。 */
    function onPointerDown(event) {
        if (event.button !== 0 || !params.clickToMove || document.pointerLockElement) return;
        pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    }

    /** 确认有效点击后拾取可行走表面，并启动单点移动。 */
    function onPointerUp(event) {
        const start = pointerStart;
        pointerStart = null;
        if (!start || event.pointerId !== start.id || !params.clickToMove || player.isFirstPerson ||
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(player.getColliderMeshes(), false)[0];
        if (!hit?.face) return;
        normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        if (hit.face.normal.clone().applyNormalMatrix(normalMatrix).y < 0.55) return;
        startRoute([hit.point.toArray()]);
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    /** 指针操作取消时清除按下记录，避免误触发点击移动。 */
    function onPointerCancel() { pointerStart = null; }

    return {
        /** 移除点击事件、卸载路线插件并释放路线显示资源。 */
        dispose() {
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", onPointerCancel);
            player.unuse(route);
            route.dispose();
            scene.remove(line);
            line.geometry.dispose();
            line.material.dispose();
        },
    };
}
