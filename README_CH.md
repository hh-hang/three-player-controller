# three-player-controller

轻量的第三人称 / 第一人称玩家控制器，开箱即用，基于 three.js 和 three-mesh-bvh 实现人物胶囊体碰撞、BVH 碰撞检测、人物动画、第一/三人称切换与相机避障。此仓库包含库源码、example 演示。

# 安装

npm install three-player-controller

# 示例

[Player Controller](https://hh-hang.github.io/three-player-controller/)

### 控制

![控制演示](https://github.com/hh-hang/three-player-controller/blob/master/example/public/gif/1.gif)

### 第三人称相机避障

![第三人称相机避障](https://github.com/hh-hang/three-player-controller/blob/master/example/public/gif/2.gif)

# 使用

```js
import * as THREE from "three";
import { playerController } from "three-player-controller";

// 初始化玩家控制器
player.init({
  scene, // three.js 场景
  camera, // three.js 相机
  controls, // three.js 控制器
  playerModel: {
    url: "./glb/person.glb", // 模型路径
    scale: 0.001, // 模型缩放
    idleAnim: "Idle_2", // 默认 Idle 动画名字
    walkAnim: "Walking_11", // 默认 Walk 动画名字
    runAnim: "Running_9", // 默认 Run 动画名字
    jumpAnim: "Jump_3", // 默认 Jump 动画名字
  },
  initPos: pos, // 初始位置
});

// 渲染循环调用
player.update();
```

# 感谢

[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)

[three](https://github.com/mrdoob/three.js)
