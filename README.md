中文 | [English](README_En.md)

# three-player-controller

[![NPM Package][npm]][npm-url]
[![Github][github]][github-url]
[![CesiumJS](https://img.shields.io/badge/CesiumJS-player_controller-blue)](https://github.com/hh-hang/cesium-player-controller)

基于 three.js 的轻量级第一 / 第三人称玩家控制器。提供角色胶囊体碰撞、动画、相机避障、移动平台、动态刚体、车辆控制和 Foot IK，并使用 `three-mesh-bvh` 加速复杂场景中的碰撞查询。

## 功能

- 第一 / 第三人称切换
- 行走、奔跑、跳跃、飞行
- 角色胶囊体碰撞与地面检测
- 相机避障、过肩视角、弹簧相机
- 静态 / 运动学 / 动态碰撞体
- 动态球体、盒体及刚体碰撞
- BVH Worker 异步构建
- 3D Tiles 流式碰撞体构建
- 内置车辆物理、悬挂、转向、抓地和手刹
- Foot IK 插件
- 自定义动画与 Locomotion Set
- 移动端虚拟摇杆与按钮
- 自定义键位与外部输入

# 示例

[![在线示例](https://github.com/hh-hang/three-player-controller/blob/master/example/public/img/readme/preview.png)](https://hh-hang.github.io/three-player-controller/index.html)

- [Showcase](https://hh-hang.github.io/three-player-controller/showcase.html)
- [Foot IK](https://hh-hang.github.io/three-player-controller/footIK.html)
- [FPS Game](https://hh-hang.github.io/three-player-controller/shooting/shooting.html)
- [glTF Scene](https://hh-hang.github.io/three-player-controller/glTF.html)
- [3DTiles Scene](https://hh-hang.github.io/three-player-controller/3dtilesScene.html)
- [3DGS Scene](https://hh-hang.github.io/three-player-controller/3dgs.html)

# 安装

```bash
npm install three-player-controller three-mesh-bvh
```

# 本地运行

```bash
git clone https://github.com/hh-hang/three-player-controller.git
cd three-player-controller
npm install
npm run dev
```

浏览器访问 `http://localhost:5173/three-player-controller/`。

# 快速开始

```ts
import * as THREE from "three";                                                
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";       
import { playerController } from "three-player-controller"; 

const scene = new THREE.Scene();                                           

const camera = new THREE.PerspectiveCamera(
    60,                                                                      
    window.innerWidth / window.innerHeight,                                   
    0.1,                                                                  
    1000,
);

const renderer = new THREE.WebGLRenderer();                                    
renderer.setSize(window.innerWidth, window.innerHeight);                       
document.body.appendChild(renderer.domElement);                                

const controls = new OrbitControls(camera, renderer.domElement);        

// 加载人物模型
const loader = new GLTFLoader();                                              
const playerGltf = await loader.loadAsync("./glb/player.glb");

// 创建玩家控制器
const player = new playerController();     

// 人物控制初始化
await player.init({
    scene,                                  // three.js 场景实例
    camera,                                 // three.js 相机实例
    controls,                               // 外部相机控制器

    // 人物模型、动画与移动参数
    playerModelConfig: {                                                       
        model: playerGltf.scene,            // 外部加载后的模型根节点
        animations: playerGltf.animations,  // 动画片段
        scale: 0.001,                       // 模型缩放
        idleAnim: "idle",                   // 静止动画名
        walkAnim: "walk",                   // 行走动画名
        runAnim: "run",                     // 跑步动画名
        jumpAnim: "jump",                   // 跳跃动画名；或传 ["起跳", "循环", "落地"] 分三段播放
    },

    // 人物初始出生点
    initPos: new THREE.Vector3(0, 0, 0),                                       

    // 初始化时注册的碰撞体
    colliders: [                                                               
        {
            motion: "static",               // 静态碰撞体
            shape: {                        // 碰撞形状配置
                kind: "mesh",               // 使用 Mesh 作为碰撞形状
                source: scene,              // 从该对象收集几何并自动构建 BVH
            },
        },
    ],
});

function animate() {
    requestAnimationFrame(animate);                                            
    player.update();                                                          
    renderer.render(scene, camera);                                          
}

animate();                                                                  
```

> `player.update()` 内部已经接管传入的相机控制器。渲染循环中不要再次调用 `controls.update()`，否则可能与内部相机逻辑冲突。

### 完整参数示例

#### `init()`

```ts
await player.init({
    // 必填
    scene,    // three.js 场景实例
    camera,   // three.js 相机实例
    controls, // 外部相机控制器，通常为 OrbitControls

    playerModelConfig: {                              // 人物模型、动画与移动参数
        model: playerGltf.scene,                      // 外部加载后的模型根节点
        animations: playerGltf.animations,            // 动画片段
        scale: 0.001,                                  // 模型缩放
        idleAnim: "idle",                              // 静止动画名
        walkAnim: "walk",                              // 行走动画名
        runAnim: "run",                                // 跑步动画名
        jumpAnim: "jump",                              // 跳跃动画名；或传 ["起跳", "循环", "落地"] 分三段播放

        // 方向 / 飞行动画（可选，不填则复用对应默认动画）
        leftWalkAnim: "leftWalk",                      // 左移动画，默认复用 walkAnim
        rightWalkAnim: "rightWalk",                    // 右移动画，默认复用 walkAnim
        backwardAnim: "walkBack",                      // 后退动画，默认复用 walkAnim
        flyAnim: "fly",                                // 飞行动画，默认复用 idleAnim
        flyIdleAnim: "flyIdle",                        // 飞行待机动画，默认复用 idleAnim
        flyHoverForwardAnim: "flyFwd",                 // 飞行前进悬停动画，默认复用 flyAnim
        flyHoverBackAnim: "flyBack",                   // 飞行后退悬停动画，默认复用 flyIdleAnim
        flyHoverLeftAnim: "flyLeft",                   // 飞行左移悬停动画，默认复用 flyIdleAnim
        flyHoverRightAnim: "flyRight",                 // 飞行右移悬停动画，默认复用 flyIdleAnim
        flyHoverUpAnim: "flyUp",                       // 飞行上升悬停动画，默认复用 flyIdleAnim
        flyHoverDownAnim: "flyDown",                   // 飞行下降悬停动画，默认复用 flyIdleAnim
        drivingAnim: "driving",                        // 驾驶循环动画，默认复用 idleAnim

        // 物理参数（可选）
        gravity: -2400,                                // 重力基准值，会按 scale 缩放，默认 -2400
        jumpHeight: 600,                               // 跳跃高度基准值，会按 scale 缩放，默认 600
        speed: 200,                                    // 移动速度基准值，会按 scale 缩放，默认 200
        runSpeed: 600,                                 // 跑步速度基准值，会按 scale 缩放，默认 600
        flySpeed: 2100,                                // 飞行速度基准值，会按 scale 缩放，默认 2100
        acceleration: 30,                              // XZ 加速响应速度，默认 30
        deceleration: 30,                              // XZ 减速响应速度，默认 30

        // 模型参数（可选）
        rotateY: 0,                                    // 人物初始朝向（弧度），默认 0
        headBoneName: "Head",                          // 头部骨骼名，用于第一人称相机挂载
        firstPersonCameraOffset: [0, 40, 30],          // 第一人称相机局部偏移
        capsuleRadiusRatio: 1,                         // 胶囊体半径倍率，默认 1
    },

    // 场景与碰撞（可选）
    initPos: new THREE.Vector3(0, 0, 0),                // 初始出生点，默认 (0, 0, 0)
    colliders: [                                        // 初始化时批量创建的碰撞体；不传则可在 init() 后调用 addCollider()
        {
            motion: "static",                           // 碰撞体运动类型：static / kinematic / dynamic
            shape: {                                    // 碰撞形状配置
                kind: "mesh",                           // Mesh 碰撞形状
                source: world,                          // 碰撞来源，可传 THREE.Object3D 或 THREE.Object3D[]
            },
            useWorker: false,                            // 是否使用 Worker 异步构建 BVH
        },
    ],

    // 相机（可选）
    minCamDistance: 100,                                // 第三人称最小镜头距离，默认 100
    maxCamDistance: 440,                                // 第三人称最大镜头距离，默认 440
    camLookAtHeightRatio: 0.8,                          // 相机看向点高度比例，0=底部，1=顶部，默认 0.8
    thirdMouseMode: 1,                                  // 第三人称鼠标控制模式 0-5，默认 1
    enableZoom: false,                                  // 是否允许滚轮缩放，默认 false
    enableOverShoulderView: false,                      // 是否启用过肩视角，默认 false
    camOverShoulderOffsetRatio: 0.2,                    // 过肩视角横向偏移比例，默认 0.2
    isFirstPerson: false,                               // 初始是否进入第一人称，默认 false
    enableSpringCamera: false,                          // 是否启用弹簧相机，默认 false
    springCameraTime: 0.05,                             // 弹簧相机平滑时间（秒），默认 0.05

    // 其他（可选）
    mouseSensitivity: 5,                                // 鼠标灵敏度，默认 5
    timeScale: 1,                                       // 时间缩放系数，<1 慢动作，>1 快进，默认 1

    keyMap: {                                           // 自定义键位；可传单键、数组多绑或 null 禁用
        forward: ["KeyW", "ArrowUp"],                   // 前进
        backward: ["KeyS", "ArrowDown"],                // 后退
        left: ["KeyA", "ArrowLeft"],                    // 左移
        right: ["KeyD", "ArrowRight"],                  // 右移
        sprint: ["ShiftLeft", "ShiftRight"],            // 冲刺；开车时为手刹
        jump: ["Space"],                                // 跳跃；开车时为刹车
        toggleView: ["KeyV"],                           // 切换第一 / 第三人称
        toggleFly: ["KeyF"],                            // 切换飞行模式
        toggleVehicle: ["KeyE"],                        // 上 / 下车
    },

    isShowMobileControls: true,                         // 移动端是否显示虚拟控制 UI，默认 true
    mobileControls: {                                   // 移动端按钮显隐、图标与布局配置
        joystick: true,                                 // 是否显示虚拟摇杆，默认 true
        jump: {                                         // 跳跃 / 刹车按钮；传 false 可隐藏
            icon: "/icons/custom-jump.svg",             // 跳跃状态自定义图片 URL
            brakeIcon: "/icons/custom-brake.svg",       // 车辆模式下刹车状态自定义图片 URL
            right: 24,                                  // 距离右侧位置（px）
            bottom: 32,                                 // 距离底部位置（px）
            size: 64,                                   // 按钮直径（px），默认 56
        },
        fly: true,                                      // 飞行按钮；true 使用默认样式，false 隐藏
        view: true,                                     // 视角切换按钮；true 使用默认样式，false 隐藏
        vehicle: true,                                  // 上 / 下车按钮；true 使用默认样式，false 隐藏
    },
});
```


# 碰撞系统

使用统一的 `CollisionWorld` 和 `addCollider()` API。

碰撞体由两个核心属性描述：

```ts
{
    motion: "static" | "kinematic" | "dynamic",
    shape: {
        kind: "mesh" | "box" | "sphere",
        // ...
    }
}
```

## 静态 Mesh

适用于地形、建筑、墙体和不会移动的场景模型。

```ts
const handle = player.addCollider({
    motion: "static",
    shape: {
        kind: "mesh",
        source: world,
    },
    useWorker: true,
});
```

## 运动学 Mesh

适用于电梯、移动平台、旋转平台、车辆外观或其它由业务代码控制变换的物体。

```ts
const platformCollider = player.addCollider({
    motion: "kinematic",
    shape: {
        kind: "mesh",
        source: platform,
    },
    follow: platform,
    useWorker: true,
});
```

碰撞体会在每帧跟随 `follow.matrixWorld`，运行时如果只需要调整已经烘焙的运动学碰撞几何，可以避免重建 BVH。

## 动态刚体

动态 `box` 和 `sphere` 会自动创建内置刚体，由 `DynamicBodySystem` 进行重力、阻尼、接触、冲量和休眠计算。

### 动态盒体

```ts
const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
);
scene.add(box);

player.addCollider({
    motion: "dynamic",
    shape: {
        kind: "box",
        halfExtents: new THREE.Vector3(0.5, 0.5, 0.5),
        position: new THREE.Vector3(0, 5, 0),
    },
    mesh: box,
});
```

### 动态球体

```ts
const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.5),
    new THREE.MeshStandardMaterial(),
);
scene.add(sphere);

player.addCollider({
    motion: "dynamic",
    shape: {
        kind: "sphere",
        radius: 0.5,
        position: new THREE.Vector3(0, 5, 0),
    },
    mesh: sphere,
});
```

动态刚体支持与静态 Mesh、运动学 Mesh、人物、车辆以及其它动态刚体发生碰撞。

## 移除与清理

```ts
const handle = player.addCollider({
    motion: "static",
    shape: { kind: "mesh", source: object },
});

player.removeCollider(handle);

// 只清除静态碰撞体
player.clearColliders({ motion: "static" });

// 清除全部碰撞体
player.clearColliders();
```

## 碰撞分组

```ts
import { CollisionGroup } from "three-player-controller";
```

| 分组 | 说明 |
| --- | --- |
| `CollisionGroup.DEFAULT` | 默认场景碰撞。 |
| `CollisionGroup.CHARACTER` | 玩家角色碰撞组。 |   
| `CollisionGroup.VEHICLE` | 车辆碰撞组。 |
| `CollisionGroup.DEBRIS` | 动态杂物、可推动物体等碰撞组。 |
| `CollisionGroup.ALL` | 所有碰撞组的组合，表示允许与全部分组发生碰撞。 |

默认情况下无需设置，会根据 `motion` 自动使用对应的碰撞组和掩码；也可以通过 `groups` 和 `mask` 自定义碰撞过滤：

```ts
player.addCollider({
    motion: "dynamic",
    shape: {
        kind: "sphere",
        radius: 0.5,
        position: new THREE.Vector3(),
    },
    groups: CollisionGroup.DEBRIS,
    mask: CollisionGroup.DEFAULT | CollisionGroup.VEHICLE,
});
```

# 3D Tiles 流式碰撞

对于 3D Tiles，不建议把整个 Tileset 一次性合并成一个碰撞体。

`example/3dtilesScene.js` 使用流式策略：

1. 监听瓦片加载、卸载和可见性变化。
2. 只跟踪当前已加载瓦片。
3. 只为人物附近且可见的瓦片创建碰撞体。
4. 使用 `useWorker: true` 异步构建 BVH。
5. 瓦片隐藏、卸载或距离过远时立即 `removeCollider()`。
6. 使用进入 / 退出双半径，避免边界附近频繁创建和销毁。

核心形式：

```ts
const handle = player.addCollider({
    motion: "kinematic",
    useWorker: true,
    shape: {
        kind: "mesh",
        source: tileScene,
    },
    follow: tileScene,
});

// 瓦片卸载 / 不可见 / 距离过远时移除碰撞体
player.removeCollider(handle);
```

示例同时演示了地球级大坐标场景中的局部坐标系和 rebase：人物距离局部原点过远时更新局部坐标系，并同步角色、相机和速度，避免大坐标浮点精度问题。

完整实现见 [`example/3dtilesScene.js`](https://github.com/hh-hang/three-player-controller/blob/master/example/3dtilesScene.js)。

# 车辆

```ts
const vehicleGltf = await loader.loadAsync("./glb/vehicle.glb"); // 外部加载车辆模型

const vehicle = await player.loadVehicleModel({
    // 必填
    model: vehicleGltf.scene,                             // 外部加载后的车辆模型根节点
    position: new THREE.Vector3(0, 0, 0),                 // 车辆初始世界坐标
    wheelsNames: [                                       // 车轮节点名，顺序：左前、右前、左后、右后
        "Wheel_LF",                                      // 左前轮节点名
        "Wheel_RF",                                      // 右前轮节点名
        "Wheel_LR",                                      // 左后轮节点名
        "Wheel_RR",                                      // 右后轮节点名
    ],
    driverSeatPosition: new THREE.Vector3(-0.6, 0.7, 0.4), // 驾驶位胶囊中心，使用底盘局部坐标

    // 模型 / 驾驶（可选）
    scale: 0.1,                                          // 车辆模型缩放，默认 1
    driverSeatRotation: 0,                               // 驾驶位相对底盘局部的水平旋转（弧度），默认 0
    modelRotation: -Math.PI / 2,                         // 车辆模型绕 Y 轴旋转（弧度），默认 -π/2
    followVehicleDirection: true,                        // 驾驶时镜头是否跟随车辆朝向，默认 true

    // 调试（可选）
    debug: {                                             // 车辆物理调试显示配置
        showPhysicsBox: false,                           // 是否显示底盘物理碰撞盒，默认 false
        showWheelRays: false,                            // 是否显示车轮悬挂射线，默认 false
        showWheelTravel: false,                          // 是否显示车轮 Y 向活动范围，默认 false
        showWheelSpheres: false,                         // 是否显示车轮动态碰撞球，默认 false
    },

    // 底盘（可选）
    chassis: {                                           // 底盘碰撞盒与阻尼参数
        density: 1,                                      // 底盘密度，质量根据碰撞盒体积与密度计算，默认 1
        linearDamping: 0.05,                             // 线阻尼，默认 0.05
        angularDamping: 0.5,                             // 角阻尼，默认 0.5
        clearance: 0.15,                                 // 底盘盒底相对轮胎触地点高度，不传时自动计算
        sizeScale: {                                     // 相对自动 AABB 的底盘碰撞盒尺寸倍率
            x: 1,                                        // X 轴尺寸倍率，默认 1
            y: 1,                                        // Y 轴尺寸倍率，默认 1
            z: 1,                                        // Z 轴尺寸倍率，默认 1
        },
    },

    // 悬挂 / 轮胎（可选）
    suspension: {                                        // 悬挂与轮胎参数
        restLength: 0.3,                                 // 悬挂静止长度，不传时自动计算
        maxTravel: 0.35,                                 // 悬挂最大行程，默认 0.35
        stiffness: 18,                                   // 悬挂刚度，默认 18
        compression: 2.1,                                // 悬挂压缩阻尼，默认 2.1
        relaxation: 2.5,                                 // 悬挂回弹阻尼，默认 2.5
        maxForce: 6000,                                  // 单轮最大悬挂力，默认 6000
        frictionSlip: 8,                                 // 轮胎纵向抓地，默认 8
        sideFrictionStiffness: 1,                        // 轮胎侧向摩擦刚度，默认 1
        rollInfluence: 0.12,                             // 侧向力对车身侧倾的影响，默认 0.12
    },

    // 转向（可选）
    steering: {                                          // 转向参数
        maxSteerAngle: Math.PI / 5,                      // 最大转向角（弧度），默认 π/5
        steerTime: 0.45,                                 // 从中位打到满舵所需时间（秒），默认 0.45
        steerReturnTimeSlow: 0.55,                       // 低速回正时间（秒），默认 0.55
        steerReturnTimeFast: 0.4,                        // 高速回正时间（秒），默认 0.4
        highSpeedSteerScale: 0.3,                        // 最高车速时最大转向比例，默认 0.3
    },

    // 抓地 / 手刹（可选）
    grip: {                                              // 过弯抓地与手刹参数
        maxG: 1.2,                                       // 最大侧向加速度（g），默认 1.2
        sideFrictionIdle: 1,                             // 直线行驶时侧向摩擦，默认 1
        sideFrictionFrontMin: 0.55,                      // 高负载下前轮侧向摩擦下限，默认 0.55
        sideFrictionRearMin: 0.45,                       // 高负载下后轮侧向摩擦下限，默认 0.45
        handbrakeRearFriction: 0.35,                     // 手刹时后轮侧向摩擦，默认 0.35
        handbrakeRearDriveScale: 0.65,                   // 手刹时后轮驱动力比例，默认 0.65
        handbrakeReleaseTime: 0.15,                      // 松开手刹后的恢复时间（秒），默认 0.15
        wheelbaseRatio: 0.55,                            // 轴距相对车长比例，默认 0.55
    },

    // 动力（可选）
    power: {                                             // 车辆动力参数
        maxSpeed: 100,                                   // 最高速度基准值（km/h），会按 scale 缩放，默认 100
        acceleration: 5,                                 // 加速度基准值（m/s²），会按 scale 缩放，默认 5
        deceleration: 5,                                 // 制动减速度基准值（m/s²），会按 scale 缩放，默认 5
    },
});
```

运行时：

```ts
player.resetVehicle();                                  // 翻正当前驾驶车辆，并清零线速度和角速度
player.setVehicleScale(vehicle, 0.12);                  // 动态修改车辆整体缩放
player.setVehicleClearance(vehicle, 0.15);              // 调整底盘碰撞盒离地间隙
player.setVehicleChassisSizeScale(vehicle, {            // 调整底盘碰撞盒相对自动 AABB 的尺寸倍率
    x: 1,                                               // X 轴尺寸倍率
    y: 0.9,                                             // Y 轴尺寸倍率
    z: 1,                                               // Z 轴尺寸倍率
});
player.setVehiclePhysicsDebug(true);                    // 显示 / 隐藏车辆底盘物理碰撞盒
```

# Foot IK 插件

```ts
import { FootIK } from "three-player-controller/foot-ik";

const footIK = new FootIK({
    // 手动指定人物骨骼映射；不传时会尝试自动匹配常见骨骼名
    skeleton: {                                         
        hips: "mixamorigHips",                          // 髋部 / 骨盆骨骼名

        // 左右腿骨骼配置
        legs: {                                         
            left: {                                     
                upper: "mixamorigLeftUpLeg",            // 左大腿骨骼
                lower: "mixamorigLeftLeg",              // 左小腿骨骼
                foot: "mixamorigLeftFoot",              // 左脚骨骼
                toe: "mixamorigLeftToeBase",            // 左脚趾骨骼
            },
            right: {                                   
                upper: "mixamorigRightUpLeg",           // 右大腿骨骼
                lower: "mixamorigRightLeg",             // 右小腿骨骼
                foot: "mixamorigRightFoot",             // 右脚骨骼
                toe: "mixamorigRightToeBase",           // 右脚趾骨骼
            },
        },
    },

    soleSkinThickness: 3,                               // 脚骨到鞋底的蒙皮厚度补偿
    plantedHeightSpeed: 200,                            // 支撑脚贴地追随速度（单位/秒）；Infinity 为立刻贴地
    penetrationLiftSpeed: 200,                          // 摆动脚陷入上抬速度（单位/秒）；Infinity 为立刻抬起
    predictivePlacement: true,                          // 启用预测落脚；默认 false，关闭时沿用反应式贴地
    straightPoleEnabled: true,                          // 移动时膝盖朝角色前方；默认 false，关闭则保留动画 pole
});

player.use(footIK);                                     // 将 Foot IK 插件注册到玩家控制器
```

运行时：

```ts
footIK.setEnabled(false);                 // 启用 / 禁用 Foot IK
footIK.setDebugEnabled(true);             // 显示 / 隐藏 Foot IK 调试辅助
player.unuse(footIK);                     // 从玩家控制器中卸载 Foot IK 插件
footIK.dispose();                         // 释放 Foot IK 创建的调试对象和相关资源
```

`player.destroy()` 会自动销毁已注册插件。

完整示例见 [`example/footIK.js`](https://github.com/hh-hang/three-player-controller/blob/master/example/footIK.js)。

# API

## 生命周期与核心

| 方法 | 说明 |
| --- | --- |
| `init(opts, callback?)` | 初始化控制器。 |
| `update(dt?)` | 每帧更新人物、碰撞、动态刚体、车辆、相机和动画。 |
| `destroy()` | 销毁控制器并释放资源。 |
| `reset(pos?)` | 将角色重置到指定位置或初始位置。 |
| `switchPlayerModel(options)` | 使用 `PlayerModelOptions` 运行时切换角色模型。 |
| `use(plugin)` | 注册插件。 |
| `unuse(plugin)` | 卸载插件。 |
| `getPlugins()` | 获取当前插件列表副本。 |

## 碰撞

| 方法 | 说明 |
| --- | --- |
| `addCollider(desc)` | 添加静态 / 运动学 / 动态碰撞体，返回 `ColliderHandle`。 |
| `removeCollider(handle)` | 按句柄或 id 移除碰撞体。 |
| `clearColliders(filter?)` | 清除碰撞体，可按 `motion` 过滤。 |
| `getColliderMeshes(options?)` | 获取当前人物查询使用的 Mesh 碰撞体。 |
| `isStaticColliderUsable()` | 是否存在已经完成 BVH 构建的静态 Mesh。 |
| `getActiveKinematicCollider()` | 获取当前角色站立的运动学碰撞体。 |
| `getActiveDynamicBody()` | 获取当前角色站立的动态刚体。 |
| `getDynamicBodies()` | 获取全部动态刚体。 |
| `removeDynamicBody(body)` | 移除动态刚体。 |
| `clearDynamicBodies()` | 清除全部动态刚体。 |
| `raycastDynamicGround(...)` | 向下查询动态刚体表面。 |

## 状态

| 方法 | 返回内容 |
| --- | --- |
| `getPosition()` | 当前角色位置。 |
| `getVelocity()` | 当前角色速度。 |
| `getIsFirstPerson()` | 是否第一人称。 |
| `getIsFlying()` | 是否飞行。 |
| `getIsOnGround()` | 是否在地面。 |
| `getGroundSupport()` | 当前最终地面支撑点和世界空间法线。 |
| `getCurrentDelta()` | 当前帧实际使用的时间步长。 |
| `getControllerMode()` | `0` 人物，`1` 车辆。 |
| `getPlayerModel()` | 当前人物模型。 |
| `getPlayerCapsule()` | 玩家胶囊体。 |
| `getActiveVehicle()` | 当前驾驶车辆。 |
| `getAllVehicles()` | 所有已加载车辆。 |
| `getCurrentPlayerAnimationName()` | 当前动画片段名。 |
| `getCurrentLocomotionSet()` | 当前 Locomotion Set。 |
| `getCenterScreenRaycastHit()` | 屏幕中心射线结果。 |

## 运行时控制

| 方法 | 说明 |
| --- | --- |
| `setInput(input)` | 注入外部输入。 |
| `setKeyMap(map?)` | 自定义或恢复默认键位。 |
| `setMouseSensitivity(v)` | 设置鼠标灵敏度。 |
| `setPlayerScale(v)` | 动态修改人物缩放。 |
| `setPlayerSpeed(v)` | 设置行走速度。 |
| `setPlayerRunSpeed(v)` | 设置跑步速度。 |
| `setPlayerFlySpeed(v)` | 设置飞行速度。 |
| `setJumpHeight(v)` | 设置跳跃高度。 |
| `setGravity(v)` | 设置重力。 |
| `setMinCamDistance(v)` | 设置第三人称最小镜头距离。 |
| `setMaxCamDistance(v)` | 设置第三人称最大镜头距离。 |
| `setCamLookAtHeightRatio(v)` | 设置相机看向点高度比例。 |
| `setCamOverShoulderOffsetRatio(v)` | 设置过肩横向偏移比例。 |
| `setThirdMouseMode(v)` | 设置第三人称鼠标模式。 |
| `setEnableZoom(v)` | 开关滚轮缩放。 |
| `setOverShoulderView(v)` | 开关过肩视角。 |
| `setEnableToward(v)` | 开关鼠标驱动朝向。 |
| `setSkipCapsuleCollision(v)` | 临时跳过人物胶囊碰撞。 |
| `changeView()` | 切换第一 / 第三人称。 |
| `setFirstPersonCamera(v?)` | 直接进入第一人称。 |

## 调试

```ts
player.setColliderDebug(true);                       // 显示 / 隐藏静态与运动学 Mesh 碰撞线框
player.setPlayerCapsuleDebug(true);                  // 显示 / 隐藏玩家胶囊体线框
player.setDynamicBodyDebug(true);                    // 显示 / 隐藏动态刚体碰撞线框
player.setVehiclePhysicsDebug(true);                 // 显示 / 隐藏车辆底盘物理碰撞盒
```

## 动画

| 方法 | 说明 |
| --- | --- |
| `playPlayerAnimationByName(name, fade?)` | 按动画片段名直接播放角色动画。 |
| `registerAnimation(key, clipName, opts?)` | 注册自定义动画片段。 |
| `playAnimation(key, opts?)` | 播放已注册的自定义动画。 |
| `registerLocomotionSet(setName, map)` | 注册一套移动动画集合，用于替换内置移动动画。 |
| `switchLocomotionSet(setName, fade?)` | 切换到指定的移动动画集合。 |

### `registerAnimation`

```ts
player.registerAnimation(key, clipName, {
    loop?: boolean,              // 是否循环播放，默认 true
    timeScale?: number,          // 动画播放放缩，默认 1
    duration?: number,           // 动画播放时长，默认 0
    clampWhenFinished?: boolean, // 是否在播放结束后将动画时间重置为 0，默认 false
    onFinished?: () => void,     // 动画播放结束后触发
});
```

`duration` 与 `timeScale` 同时设置时，`duration` 优先生效。

### `playAnimation`

```ts
player.playAnimation(key, {
    fade?: number,          // 过渡时长（秒），默认 0.18
    force?: boolean,        // 为 true 时强制从头重播，即使当前已在播放该动画
    returnToPrev?: boolean, // 仅对 LoopOnce 动画生效，播放结束后自动恢复上一个动画状态
});
```

### `registerLocomotionSet`

支持的 key：`idle` | `walking` | `walking_backward` | `running` | `jumping` | `flyidle` | `flying`，填写的 key 会替换对应内置动画，未填的保持原有动画。

```ts
player.registerLocomotionSet("combat", {
    idle: "CombatIdle",
    walking: "CombatWalk",
    walking_backward: "CombatBack",
    running: "CombatRun",
    jumping: "CombatJump",
    flyidle: "CombatFlyIdle",
    flying: "CombatFly",
});
```

# 默认键位

| 动作 | 默认键 | 功能 |
| --- | --- | --- |
| 前进 | `W` / `ArrowUp` | 前进 |
| 后退 | `S` / `ArrowDown` | 后退 |
| 左移 | `A` / `ArrowLeft` | 左移 |
| 右移 | `D` / `ArrowRight` | 右移 |
| 冲刺 | `Shift` | 人物冲刺；车辆手刹 |
| 跳跃 | `Space` | 跳跃；飞行上升；车辆刹车 |
| 切换视角 | `V` | 第一 / 第三人称 |
| 飞行 | `F` | 开关飞行 |
| 上 / 下车 | `E` | 车辆交互 |
| 视角 | 鼠标 | 控制视角 |

# 自定义键位

通过 `keyMap` 可以把上表的任意动作改绑到其它按键，或禁用某个动作。键名使用 [`KeyboardEvent.code`](https://developer.mozilla.org/zh-CN/docs/Web/API/KeyboardEvent/code)（如 `"KeyE"`、`"ArrowUp"`、`"Space"`，注意是 `"KeyE"` 而非 `"e"`）。

每个动作三种取值：

- **不填** → 使用默认键
- **字符串 / 字符串数组** → 替换为指定按键（数组可绑定多个键）
- **`null`** → 禁用该动作（任何键都不会触发）

初始化时配置：

```ts
await player.init({
    // ...
    keyMap: {
        forward: "KeyE",          // 改为按 E 前进（替换默认 W / ↑）
        jump: null,               // 禁用跳跃
        left: ["KeyA", "KeyJ"],   // 同时绑定 A 和 J
        // 其余动作未填，保持默认键
    },
});
```

运行时切换键位方案：

```ts
player.setKeyMap({ forward: "KeyI", backward: "KeyK" }); // 应用新键位
player.setKeyMap();                                      // 恢复全部默认
```

# 外部输入

```ts
player.setInput({
    moveX: number,        // 水平移动轴，范围 -1～1，正数向右
    moveY: number,        // 纵向移动轴，范围 -1～1，正数向前
    lookDeltaX: number,   // 视角水平增量，通常来自 mousemove 的 movementX
    lookDeltaY: number,   // 视角垂直增量，通常来自 mousemove 的 movementY
    jump: boolean,        // 跳跃，持续状态（true=按下，false=松开）；飞行时控制上升；开车时为刹车
    shift: boolean,       // 人物冲刺，开车时为手刹，持续状态（true=按下，false=松开）
    toggleView: boolean,  // 触发式，传 true 切换第一/第三人称视角
    toggleFly: boolean,   // 触发式，传 true 切换飞行模式
    toggleVehicle: boolean, // 触发式，传 true 上车 / 下车
});
```

# 事件

```ts
player.onAnimationChange = (name, action) => {};   // 角色当前动画切换时触发
player.onBeforeViewChange = (isFirstPerson) => {}; // 第一 / 第三人称切换前触发
player.onViewChange = (isFirstPerson) => {};       // 第一 / 第三人称切换后触发
player.onGroundChange = (onGround) => {};          // 落地状态变化时触发
player.onVehicleEnter = (vehicle) => {};           // 上车完成后触发
player.onVehicleExit = (vehicle) => {};            // 下车完成后触发
player.onTowardChange = (dx, dy, speed) => {};     // 朝向 / 视角输入更新时触发
```

# 主要配置

## `PlayerControllerOptions`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `scene` | `THREE.Scene` | 是 | — | three.js 场景实例。 |
| `camera` | `THREE.PerspectiveCamera` | 是 | — | three.js 相机实例。 |
| `controls` | `any` | 是 | — | 外部相机控制器，通常为 `OrbitControls`。 |
| `playerModelConfig` | `PlayerModelOptions` | 是 | — | 角色模型与参数配置。 |
| `initPos` | `THREE.Vector3` | 否 | `(0, 0, 0)` | 初始出生点。 |
| `colliders` | `ColliderDesc[]` | 否 | — | 初始化时批量注册碰撞体。 |
| `mouseSensitivity` | `number` | 否 | `5` | 鼠标灵敏度。 |
| `minCamDistance` | `number` | 否 | `100` | 第三人称最小镜头距离。 |
| `maxCamDistance` | `number` | 否 | `440` | 第三人称最大镜头距离。 |
| `isShowMobileControls` | `boolean` | 否 | `true` | 是否在移动端显示虚拟控制 UI。 |
| `mobileControls` | `MobileControlsOptions` | 否 | 全部显示 | 移动端按钮显隐、图标与布局配置。 |
| `thirdMouseMode` | `0 \| 1 \| 2 \| 3 \| 4 \| 5` | 否 | `1` | 第三人称视角下的鼠标控制模式（0:隐藏鼠标，控制朝向及视角；1:隐藏鼠标，仅控制视角；2:显示鼠标，拖拽控制朝向及视角；3:显示鼠标，拖拽仅控制视角；4:显示鼠标，拖拽控制视角且人物朝向跟随相机水平方向；5:隐藏鼠标，控制视角且人物朝向跟随相机水平方向） |
| `enableZoom` | `boolean` | 否 | `false` | 是否允许滚轮缩放。 |
| `enableOverShoulderView` | `boolean` | 否 | `false` | 是否启用过肩视角。 |
| `camOverShoulderOffsetRatio` | `number` | 否 | `0.2` | 第三人称相机过肩视角横向偏移比例。 |
| `isFirstPerson` | `boolean` | 否 | `false` | 初始化时是否直接进入第一人称。 |
| `enableSpringCamera` | `boolean` | 否 | `false` | 是否启用弹簧相机（目标点以弹簧阻尼跟随角色）。 |
| `springCameraTime` | `number` | 否 | `0.05` | 弹簧平滑时间（秒），越小跟随越紧。 |
| `camLookAtHeightRatio` | `number` | 否 | `0.8` | 第三人称相机看向点高度比例（0=胶囊底部，1=顶部）。 |
| `timeScale` | `number` | 否 | `1` | 时间缩放系数，<1 慢动作，>1 快进。 |
| `keyMap` | `KeyMap` | 否 | 默认键位 | 自定义键位映射，详见[自定义键位](#自定义键位)。 |

## `PlayerModelOptions`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | `THREE.Object3D` | 二选一 | — | 已加载的人物模型根节点。与 `url` 互斥。 |
| `animations` | `THREE.AnimationClip[]` | 与 `model` 同用 | — | 人物动画片段。与 `model` 一起传入。 |
| `url` | `string` | 二选一 | — | 人物模型路径（GLB/GLTF）。 |
| `scale` | `number` | 是 | — | 人物模型缩放。 |
| `idleAnim` | `string` | 是 | — | Idle 动画名。 |
| `walkAnim` | `string` | 是 | — | Walk 动画名。 |
| `runAnim` | `string` | 是 | — | Run 动画名。 |
| `jumpAnim` | `string \| [string, string, string]` | 是 | — | 跳跃动画名。传字符串播放单一动画；传三元素数组 `[起跳, 循环, 落地]` 分三阶段播放，落地后自动衔接移动动画。 |
| `leftWalkAnim` | `string` | 否 | `walkAnim` | 左移动画名，不填则复用 `walkAnim`。 |
| `rightWalkAnim` | `string` | 否 | `walkAnim` | 右移动画名，不填则复用 `walkAnim`。 |
| `backwardAnim` | `string` | 否 | `walkAnim` | 后退动画名，不填则复用 `walkAnim`。 |
| `flyAnim` | `string` | 否 | `idleAnim` | 飞行动画名，不填则复用 `idleAnim`。 |
| `flyIdleAnim` | `string` | 否 | `idleAnim` | 飞行待机动画名，不填则复用 `idleAnim`。 |
| `flyHoverForwardAnim` | `string` | 否 | `flyAnim` | 飞行前进时的悬停动画名，不填则复用 `flyAnim`。 |
| `flyHoverBackAnim` | `string` | 否 | `flyIdleAnim` | 飞行后退时的悬停动画名，不填则复用 `flyIdleAnim`。 |
| `flyHoverLeftAnim` | `string` | 否 | `flyIdleAnim` | 飞行左移时的悬停动画名，不填则复用 `flyIdleAnim`。 |
| `flyHoverRightAnim` | `string` | 否 | `flyIdleAnim` | 飞行右移时的悬停动画名，不填则复用 `flyIdleAnim`。 |
| `flyHoverUpAnim` | `string` | 否 | `flyIdleAnim` | 飞行上升时的悬停动画名，不填则复用 `flyIdleAnim`。 |
| `flyHoverDownAnim` | `string` | 否 | `flyIdleAnim` | 飞行下降时的悬停动画名，不填则复用 `flyIdleAnim`。 |
| `drivingAnim` | `string` | 否 | `idleAnim` | 驾驶循环动画名，不填则复用 `idleAnim`。 |
| `gravity` | `number` | 否 | `-2400` | 重力基准值（按 `scale` 缩放）。 |
| `jumpHeight` | `number` | 否 | `600` | 跳跃高度基准值（按 `scale` 缩放）。 |
| `speed` | `number` | 否 | `200` | 移动速度基准值（按 `scale` 缩放）。 |
| `runSpeed` | `number` | 否 | `600` | 跑步速度基准值（按 `scale` 缩放）。 |
| `flySpeed` | `number` | 否 | `2100` | 飞行速度基准值（按 `scale` 缩放）。 |
| `rotateY` | `number` | 否 | `0` | 人物初始朝向（弧度），用于改变模型初始化面朝方向。 |
| `headBoneName` | `string` | 否 | — | 头部骨骼或节点名称，用于第一人称相机挂载。 |
| `firstPersonCameraOffset` | `[number, number, number]` | 否 | 有内置默认值 | 第一人称相机局部偏移；有 `headBoneName` 则相对头骨骼，否则相对胶囊体。 |
| `capsuleRadiusRatio` | `number` | 否 | `1` | 胶囊体半径倍率，用于微调碰撞宽度。 |
| `acceleration` | `number` | 否 | `30` | XZ 方向加速响应速度，值越大加速越快。 |
| `deceleration` | `number` | 否 | `30` | XZ 方向减速响应速度，值越大停止越快。 |

### `MobileControlsOptions`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `joystick` | `boolean` | 否 | `true` | 是否显示支持 360° 连续方向的摇杆。 |
| `jump` | `boolean \| JumpButtonOptions` | 否 | `true` | 跳跃/刹车按钮；`false` 隐藏，对象可自定义图片和布局。 |
| `fly` | `boolean \| MobileButtonOptions` | 否 | `true` | 飞行按钮；`false` 隐藏，对象可自定义图片和布局。 |
| `view` | `boolean \| MobileButtonOptions` | 否 | `true` | 视角切换按钮；`false` 隐藏，对象可自定义图片和布局。 |
| `vehicle` | `boolean \| MobileButtonOptions` | 否 | `true` | 上下车按钮；`false` 隐藏，对象可自定义图片和布局。 |

### `MobileButtonOptions` / `JumpButtonOptions`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `left` / `right` | `number` | 否 | 内置位置 | 按钮距离左侧或右侧的位置（px）。设置 `left` 且未设置 `right` 时会清除默认右侧定位。 |
| `top` / `bottom` | `number` | 否 | 内置位置 | 按钮距离顶部或底部的位置（px）。设置 `top` 且未设置 `bottom` 时会清除默认底部定位。 |
| `size` | `number` | 否 | `56` | 圆形按钮直径（px）。 |
| `icon` | `string` | 否 | 英文标签 | 自定义图片 URL。 |
| `brakeIcon` | `string` | 否 | `BRAKE` 标签 | 仅用于 `JumpButtonOptions`，设置车辆模式下的刹车图片 URL。 |


## `ColliderDesc`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `motion` | `"static" \| "kinematic" \| "dynamic"` | — | 碰撞体运动类型。 |
| `shape` | `ColliderShape` | — | 碰撞形状配置，支持 `mesh`、`box`、`sphere`。 |
| `groups` | `number` | 根据 `motion` 自动设置 | 当前碰撞体所属碰撞组。 |
| `mask` | `number` | 根据 `motion` 自动设置 | 当前碰撞体允许发生碰撞的分组掩码。 |
| `useWorker` | `boolean` | `false` | `mesh + source` 时是否使用 Worker 异步构建 BVH。 |
| `userData` | `unknown` | — | 自定义业务数据。 |
| `follow` | `THREE.Object3D` | — | `kinematic` 碰撞体跟随的场景对象。 |
| `density` | `number` | `1` | `dynamic` 刚体密度，用于计算质量。 |
| `restitution` | `number` | `0.2` | `dynamic` 刚体弹性系数。 |
| `friction` | `number` | `0.6` | `dynamic` 刚体摩擦系数。 |
| `linearDamping` | `number` | `0.4` | `dynamic` 刚体线阻尼。 |
| `angularDamping` | `number` | `0.6` | `dynamic` 刚体角阻尼。 |
| `gravity` | `number` | 内部默认值 | `dynamic` 刚体重力。 |
| `velocity` | `THREE.Vector3` | `(0,0,0)` | `dynamic` 刚体初始线速度。 |
| `angularVelocity` | `THREE.Vector3` | `(0,0,0)` | `dynamic` 刚体初始角速度。 |
| `mesh` | `THREE.Mesh` | — | `dynamic box / sphere` 创建内置刚体时必须提供的可视化 Mesh。 |
| `simulate` | `boolean` | `true` | 是否由内置动态刚体系统进行模拟。 |

### `ColliderShape`

#### Mesh

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `"mesh"` | Mesh 碰撞形状。 |
| `source` | `THREE.Object3D \| THREE.Object3D[]` | 从对象中收集几何、合并碰撞网格并构建 BVH。 |
| `mesh` | `THREE.Mesh` | 直接注册已经准备好的碰撞 Mesh。 |

#### Box

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `"box"` | 盒体碰撞形状。 |
| `halfExtents` | `THREE.Vector3` | 盒体半尺寸，即完整尺寸的一半。 |
| `position` | `THREE.Vector3` | 初始世界坐标，可选。 |
| `quaternion` | `THREE.Quaternion` | 初始世界旋转，可选。 |

#### Sphere

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `"sphere"` | 球体碰撞形状。 |
| `radius` | `number` | 球体半径。 |
| `position` | `THREE.Vector3` | 初始世界坐标，可选。 |

## `VehicleOptions`

### 基础参数

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `model` | `THREE.Object3D` | — | 外部加载后的车辆模型根节点。 |
| `position` | `THREE.Vector3` | — | 车辆初始世界坐标。 |
| `wheelsNames` | `[string, string, string, string]` | — | 车轮节点名数组，顺序为左前、右前、左后、右后。 |
| `driverSeatPosition` | `THREE.Vector3` | — | 驾驶位胶囊中心，车辆底盘局部坐标。 |
| `scale` | `number` | `1` | 车辆模型缩放。 |
| `driverSeatRotation` | `number` | `0` | 驾驶位相对车辆底盘局部的水平旋转（弧度）。 |
| `modelRotation` | `number` | `-Math.PI / 2` | 车辆模型绕 Y 轴的初始旋转。 |
| `followVehicleDirection` | `boolean` | `true` | 驾驶时镜头是否跟随车辆朝向。 |
| `debug` | `VehicleDebugOptions` | — | 车辆物理调试显示配置。 |
| `chassis` | `VehicleChassisOptions` | — | 底盘碰撞盒与阻尼配置。 |
| `suspension` | `VehicleSuspensionOptions` | — | 悬挂与轮胎配置。 |
| `steering` | `VehicleSteeringOptions` | — | 转向配置。 |
| `grip` | `VehicleGripOptions` | — | 抓地和手刹配置。 |
| `power` | `VehiclePowerOptions` | — | 动力配置。 |

### `debug`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `showPhysicsBox` | `boolean` | `false` | 显示底盘物理碰撞盒。 |
| `showWheelRays` | `boolean` | `false` | 显示车轮悬挂射线。 |
| `showWheelTravel` | `boolean` | `false` | 显示车轮 Y 向活动范围。 |
| `showWheelSpheres` | `boolean` | `false` | 显示车轮动态碰撞球。 |

### `chassis`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `density` | `number` | `1` | 底盘密度，质量根据碰撞盒体积与密度计算。 |
| `linearDamping` | `number` | `0.05` | 底盘线阻尼。 |
| `angularDamping` | `number` | `0.5` | 底盘角阻尼。 |
| `clearance` | `number` | 自动计算 | 底盘盒底相对轮胎触地点高度。 |
| `sizeScale.x` | `number` | `1` | 底盘碰撞盒 X 轴尺寸倍率。 |
| `sizeScale.y` | `number` | `1` | 底盘碰撞盒 Y 轴尺寸倍率。 |
| `sizeScale.z` | `number` | `1` | 底盘碰撞盒 Z 轴尺寸倍率。 |

### `suspension`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `restLength` | `number` | 自动计算 | 悬挂静止长度。 |
| `maxTravel` | `number` | `0.35` | 悬挂最大行程。 |
| `stiffness` | `number` | `18` | 悬挂刚度。 |
| `compression` | `number` | `2.1` | 悬挂压缩阻尼。 |
| `relaxation` | `number` | `2.5` | 悬挂回弹阻尼。 |
| `maxForce` | `number` | `6000` | 单轮最大悬挂力。 |
| `frictionSlip` | `number` | `8` | 轮胎纵向抓地。 |
| `sideFrictionStiffness` | `number` | `1` | 轮胎侧向摩擦刚度。 |
| `rollInfluence` | `number` | `0.12` | 侧向力对车身侧倾的影响。 |

### `steering`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxSteerAngle` | `number` | `Math.PI / 5` | 最大转向角，单位为弧度。 |
| `steerTime` | `number` | `0.45` | 从中位打到满舵所需时间，单位为秒。 |
| `steerReturnTimeSlow` | `number` | `0.55` | 低速回正时间，单位为秒。 |
| `steerReturnTimeFast` | `number` | `0.4` | 高速回正时间，单位为秒。 |
| `highSpeedSteerScale` | `number` | `0.3` | 最高车速时的最大转向比例。 |

### `grip`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxG` | `number` | `1.2` | 最大侧向加速度，单位为 g。 |
| `sideFrictionIdle` | `number` | `1` | 直线行驶时侧向摩擦。 |
| `sideFrictionFrontMin` | `number` | `0.55` | 高负载下前轮侧向摩擦下限。 |
| `sideFrictionRearMin` | `number` | `0.45` | 高负载下后轮侧向摩擦下限。 |
| `handbrakeRearFriction` | `number` | `0.35` | 手刹时后轮侧向摩擦。 |
| `handbrakeRearDriveScale` | `number` | `0.65` | 手刹时后轮驱动力比例。 |
| `handbrakeReleaseTime` | `number` | `0.15` | 松开手刹后的恢复时间，单位为秒。 |
| `wheelbaseRatio` | `number` | `0.55` | 轴距相对车长的比例。 |

### `power`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxSpeed` | `number` | `100` | 最高速度基准值（km/h，按 `scale` 缩放）。 |
| `acceleration` | `number` | `5` | 加速度基准值（m/s²，按 `scale` 缩放）。 |
| `deceleration` | `number` | `5` | 制动减速度基准值（m/s²，按 `scale` 缩放）。 |

# 反馈

如果你有任何问题或建议，欢迎提交 [issue](https://github.com/hh-hang/three-player-controller/issues)。

# 致谢

- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
- [three.js](https://github.com/mrdoob/three.js)

[npm]: https://img.shields.io/npm/v/three-player-controller
[npm-url]: https://www.npmjs.com/package/three-player-controller
[github]: https://img.shields.io/badge/-hh--hang-181717?style=flat&logo=github&logoColor=white&labelColor=888
[github-url]: https://github.com/hh-hang