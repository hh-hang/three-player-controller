import type { playerController } from "../PlayerController";
import type { PlayerInput } from "../types";

/** 控制器插件的生命周期接口。 */
export interface PlayerPlugin {
    /** 插件名称；注册同名插件时会替换已有插件。 */
    readonly name?: string;

    /** 注册到控制器后调用。 */
    onAttach?(player: playerController): void;

    /** 从控制器卸载后调用。 */
    onDetach?(): void;

    /** 每个物理子步前调用，适合生成自动移动指令。 */
    onBeforeUpdate?(delta: number): void;

    /** 每个物理子步及平台携带完成后调用，适合检测到达或受阻。 */
    onAfterUpdate?(delta: number): void;

    /** 收到内置或外部输入时调用，不包含插件的自动移动指令。 */
    onInput?(input: Readonly<PlayerInput>): void;

    /** 动画混合器更新前调用，适合恢复上一帧修改。 */
    onBeforeAnimationUpdate?(delta: number): void;

    /** 动画混合器更新后调用，适合应用本帧后处理。 */
    onAfterAnimationUpdate?(delta: number): void;

    /** 玩家模型切换后调用，插件可在此重新绑定资源。 */
    onPlayerModelChange?(): void;

    /** 控制器销毁时调用。 */
    dispose?(): void;
}
