import {
    AnimationMixer,
    MathUtils,
    Quaternion,
    Vector3,
    type AnimationClip,
    type Object3D,
} from "three";
import { collectBones, isReadyLeg } from "./skeleton";
import type {
    FootIKLegs,
    FootIKOptions,
    FootIKSide,
    FootPhaseClipData,
    FootPhaseContactRun,
    FootPhaseDatabase,
    FootPhaseFrameSample,
    FootPhaseLanding,
    FootPhaseOptions,
    FootPhaseRuntime,
    FootPhaseRuntimeState,
    FootPhaseSamplePoint,
    FootPhaseSideData,
    ReadyFootIKLeg,
} from "../types";

const tmpFoot = new Vector3();
const tmpToe = new Vector3();
const tmpFootRotation = new Quaternion();
const tmpModelRotation = new Quaternion();

// 创建单脚相位的运行时默认状态。
export function createFootPhaseRuntimeState(): FootPhaseRuntimeState {
    return {
        planted: false,
        progress: 0,
        timeToLand: Infinity,
        nextLanding: null,
    };
}

// 从控制器配置中提取脚步相位采样参数。
export function createFootPhaseOptions(options: FootIKOptions = {}): FootPhaseOptions {
    return {
        sampleCount: Math.max(16, Math.round(options.footPhaseSampleCount ?? 96)),
        groundThreshold: Math.max(0, options.footPhaseGroundThreshold ?? 5),
        minContactRatio: MathUtils.clamp(options.footPhaseMinContactRatio ?? 0.04, 0, 1),
        speedSlack: Math.max(0, options.footPhaseSpeedSlack ?? 1.35),
    };
}

// 离线采样循环移动动画，生成左右脚落地和抬脚相位。
export function buildFootPhaseDatabase(
    model: Object3D | null | undefined,
    clips: readonly AnimationClip[],
    legs: FootIKLegs,
    options: FootPhaseOptions,
    isLocomotionClip: (clipName: string) => boolean,
): FootPhaseDatabase {
    const phaseClips: FootPhaseDatabase = new Map();
    if (!model || !clips.length || !isReadyLeg(legs.left) || !isReadyLeg(legs.right)) return phaseClips;

    const bones = collectBones(model);
    const savedPoses = bones.map(bone => ({
        bone,
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone(),
    }));
    const savedModelMatrixNeedsUpdate = model.matrixWorldNeedsUpdate;
    const mixer = new AnimationMixer(model);

    try {
        for (const clip of clips) {
            if (!shouldAnalyzeFootPhaseClip(clip, isLocomotionClip)) continue;
            phaseClips.set(clip.name, sampleFootPhaseClip(model, mixer, clip, legs, options));
        }
    } finally {
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        for (const pose of savedPoses) {
            pose.bone.position.copy(pose.position);
            pose.bone.quaternion.copy(pose.quaternion);
            pose.bone.scale.copy(pose.scale);
        }
        model.matrixWorldNeedsUpdate = savedModelMatrixNeedsUpdate;
        model.updateMatrixWorld(true);
    }

    return phaseClips;
}

// 根据当前动画时间采样左右脚运行时相位。
export function sampleFootPhaseRuntime(
    phaseClip: FootPhaseClipData | null | undefined,
    normalizedTime: number,
    duration: number,
): FootPhaseRuntime {
    if (!phaseClip) {
        return {
            left: createFootPhaseRuntimeState(),
            right: createFootPhaseRuntimeState(),
        };
    }

    return {
        left: sampleFootPhaseRuntimeSide(phaseClip.left, normalizedTime, duration),
        right: sampleFootPhaseRuntimeSide(phaseClip.right, normalizedTime, duration),
    };
}

// 只分析 playerModelConfig 中配置为移动状态的循环动画。
function shouldAnalyzeFootPhaseClip(
    clip: AnimationClip,
    isLocomotionClip: (clipName: string) => boolean,
): boolean {
    return clip.duration > 0 && isLocomotionClip(clip.name);
}

// 对单个动画片段离线采样，生成左右脚相位数据。
function sampleFootPhaseClip(
    model: Object3D,
    mixer: AnimationMixer,
    clip: AnimationClip,
    legs: FootIKLegs,
    options: FootPhaseOptions,
): FootPhaseClipData {
    if (!isReadyLeg(legs.left) || !isReadyLeg(legs.right)) {
        throw new Error("[FootIK] 脚步相位采样时腿部骨骼不完整。");
    }

    const action = mixer.clipAction(clip);
    action.reset();
    action.setEffectiveWeight(1);
    action.play();

    const samples: FootPhaseFrameSample[] = [];
    for (let i = 0; i < options.sampleCount; i++) {
        const normalizedTime = i / options.sampleCount;
        mixer.setTime(normalizedTime * clip.duration);
        model.updateMatrixWorld(true);
        samples.push({
            time: normalizedTime,
            left: getFootPhaseSample(model, legs.left),
            right: getFootPhaseSample(model, legs.right),
        });
    }

    action.stop();

    return {
        name: clip.name,
        duration: clip.duration,
        left: analyzeFootPhaseSide(samples, "left", options),
        right: analyzeFootPhaseSide(samples, "right", options),
    };
}

// 采样单只脚在动画中的高度、水平位置和相对模型旋转。
function getFootPhaseSample(model: Object3D, leg: ReadyFootIKLeg): FootPhaseSamplePoint {
    const foot = leg.foot.getWorldPosition(tmpFoot);
    const toeY = leg.toe ? leg.toe.getWorldPosition(tmpToe).y : foot.y;
    const contactY = Math.min(foot.y, toeY);
    const footWorldRotation = leg.foot.getWorldQuaternion(tmpFootRotation);
    const localRotation = model
        .getWorldQuaternion(tmpModelRotation)
        .invert()
        .multiply(footWorldRotation)
        .clone();
    model.worldToLocal(foot);
    return {
        y: contactY,
        x: foot.x,
        localY: foot.y,
        z: foot.z,
        localRotation,
    };
}

// 分析单只脚的落地相位。
function analyzeFootPhaseSide(
    samples: readonly FootPhaseFrameSample[],
    side: FootIKSide,
    options: FootPhaseOptions,
): FootPhaseSideData {
    let minY = Infinity;
    for (const sample of samples) minY = Math.min(minY, sample[side].y);

    const speeds = calculateFootPhaseSpeeds(samples, side);
    const heightContacts = samples.map(sample => sample[side].y <= minY + options.groundThreshold);
    const speedContacts = filterFootPhaseBySpeed(heightContacts, speeds, options.speedSlack);
    const contacts = keepMainFootContactRun(filterShortFootContacts(speedContacts, options.minContactRatio));
    const land: number[] = [];
    const lift: number[] = [];
    const landings: FootPhaseLanding[] = [];

    for (let i = 0; i < contacts.length; i++) {
        const prev = contacts[(i - 1 + contacts.length) % contacts.length];
        const current = contacts[i];
        if (!prev && current) {
            land.push(samples[i].time);
            const point = samples[i][side];
            landings.push({
                phase: samples[i].time,
                localPosition: new Vector3(point.x, point.localY, point.z),
                localRotation: point.localRotation.clone(),
            });
        }
        if (prev && !current) lift.push(samples[i].time);
    }

    return {
        contacts,
        land,
        lift,
        landings,
    };
}

// 计算脚在动画相位中的水平速度。
function calculateFootPhaseSpeeds(
    samples: readonly FootPhaseFrameSample[],
    side: FootIKSide,
): number[] {
    const speeds: number[] = [];
    for (let i = 0; i < samples.length; i++) {
        const prev = samples[(i - 1 + samples.length) % samples.length][side];
        const next = samples[(i + 1) % samples.length][side];
        speeds.push(Math.hypot(next.x - prev.x, next.z - prev.z));
    }
    return speeds;
}

// 在低高度候选点中继续过滤水平速度。
function filterFootPhaseBySpeed(
    contacts: readonly boolean[],
    speeds: readonly number[],
    speedSlack: number,
): boolean[] {
    const contactSpeeds = speeds
        .filter((_speed, index) => contacts[index])
        .sort((a, b) => a - b);
    if (contactSpeeds.length === 0) return contacts.slice();

    const median = contactSpeeds[Math.floor(contactSpeeds.length * 0.5)];
    const p75 = contactSpeeds[Math.floor(contactSpeeds.length * 0.75)];
    const threshold = Math.max(median, p75) * speedSlack;
    return contacts.map((contact, index) => contact && speeds[index] <= threshold);
}

// 去掉过短的接触段，避免脚尖高度抖动产生零碎支撑相位。
function filterShortFootContacts(
    contacts: readonly boolean[],
    minContactRatio: number,
): boolean[] {
    const minLength = Math.max(1, Math.round(contacts.length * minContactRatio));
    const filtered = contacts.slice();

    for (const run of getCircularContactRuns(contacts, true)) {
        if (run.indices.length >= minLength) continue;
        for (const index of run.indices) filtered[index] = false;
    }

    return filtered;
}

// 每只脚只保留最长的主要支撑段。
function keepMainFootContactRun(contacts: readonly boolean[]): boolean[] {
    const runs = getCircularContactRuns(contacts, true);
    if (runs.length <= 1) return contacts.slice();

    const mainRun = runs.sort((a, b) => b.indices.length - a.indices.length)[0];
    const filtered = new Array<boolean>(contacts.length).fill(false);
    for (const index of mainRun.indices) filtered[index] = true;
    return filtered;
}

// 提取循环数组中连续相同值的片段。
function getCircularContactRuns(
    values: readonly boolean[],
    targetValue: boolean,
): FootPhaseContactRun[] {
    const runs: FootPhaseContactRun[] = [];
    if (values.length === 0) return runs;

    const visited = new Array<boolean>(values.length).fill(false);
    const start = values.findIndex((value, index) => {
        const prev = values[(index - 1 + values.length) % values.length];
        return value === targetValue && prev !== targetValue;
    });
    if (start < 0) {
        return values[0] === targetValue
            ? [{ indices: values.map((_value, index) => index) }]
            : runs;
    }

    for (let offset = 0; offset < values.length; offset++) {
        const index = (start + offset) % values.length;
        if (visited[index] || values[index] !== targetValue) continue;

        const indices: number[] = [];
        let cursor = index;
        while (!visited[cursor] && values[cursor] === targetValue) {
            visited[cursor] = true;
            indices.push(cursor);
            cursor = (cursor + 1) % values.length;
            if (cursor === index) break;
        }
        runs.push({ indices });
    }

    return runs;
}

// 计算单脚是否支撑、摆腿进度和下一次落地时间。
function sampleFootPhaseRuntimeSide(
    sideData: FootPhaseSideData,
    normalizedTime: number,
    duration: number,
): FootPhaseRuntimeState {
    const sampleCount = sideData.contacts.length;
    if (sampleCount === 0) return createFootPhaseRuntimeState();

    const sampleIndex = Math.floor(normalizedTime * sampleCount) % sampleCount;
    const planted = !!sideData.contacts[sampleIndex];
    const nextLanding = nextLandingEvent(sideData.landings, normalizedTime);
    const nextLand = nextLanding?.phase ?? null;
    const prevLift = prevPhaseEvent(sideData.lift, normalizedTime);
    const swingSpan = wrapPhaseDistance(prevLift, nextLand) || 1;
    const swingDone = wrapPhaseDistance(prevLift, normalizedTime);

    return {
        planted,
        progress: planted ? 1 : MathUtils.clamp(swingDone / swingSpan, 0, 1),
        timeToLand: nextLand === null
            ? Infinity
            : wrapPhaseDistance(normalizedTime, nextLand) * duration,
        nextLanding,
    };
}

/** 查找循环动画时间轴上的下一次落脚事件。 */
function nextLandingEvent(
    events: readonly FootPhaseLanding[],
    normalizedTime: number,
): FootPhaseLanding | null {
    if (!events.length) return null;
    let best = events[0];
    let bestDistance = Infinity;
    for (const event of events) {
        const distance = wrapPhaseDistance(normalizedTime, event.phase);
        if (distance < bestDistance) {
            best = event;
            bestDistance = distance;
        }
    }
    return best;
}

// 查找循环时间轴上的上一个事件。
function prevPhaseEvent(events: readonly number[], normalizedTime: number): number {
    if (!events.length) return normalizedTime;
    let best = events[0];
    let bestDistance = Infinity;
    for (const eventTime of events) {
        const distance = wrapPhaseDistance(eventTime, normalizedTime);
        if (distance < bestDistance) {
            best = eventTime;
            bestDistance = distance;
        }
    }
    return best;
}

// 计算归一化循环时间轴上的前向距离。
function wrapPhaseDistance(from: number | null, to: number | null): number {
    if (from === null || to === null) return 0;
    return (to - from + 1) % 1;
}
