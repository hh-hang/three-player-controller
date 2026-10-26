// 主入口
export * from "./PlayerController";
export type {
    JumpButtonOptions,
    KeyAction,
    KeyMap,
    LegacyPlayerModelSource,
    LegacyVehicleModelSource,
    LoadedPlayerModelSource,
    LoadedVehicleModelSource,
    MobileButtonOptions,
    MobileControlsOptions,
    PlayerControllerOptions,
    PlayerInput,
    PlayerModelOptions,
    PlayerModelSource,
    VehicleInstance,
    VehicleModelSource,
    VehicleOptions,
    VehicleChassisOptions,
    VehicleSuspensionOptions,
    VehicleSteeringOptions,
    VehicleGripOptions,
    VehiclePowerOptions,
    VehicleWheelColliderUserData,
    KinematicColliderEntry,
} from "./types";
export type { PlayerPlugin } from "./plugins/types";

// 碰撞公开 API
export { CollisionWorld } from "./collision/CollisionWorld";
export type { CollisionCollider, CollisionShape, MotionType } from "./collision/CollisionWorld";
export { CHARACTER_QUERY_MASK, ALL_COLLISION_MASK, CollisionGroup } from "./collision/groups";
export type {
    ColliderDesc,
    ColliderHandle,
    ColliderShape,
    MeshShape,
    BoxShape,
    SphereShape,
} from "./collision/colliderDesc";
export { DYNAMIC_BODY_DEFAULTS } from "./collision/colliderDesc";
export { DynamicSphereBody, isSphereBody } from "./collision/DynamicSphere";
export { DynamicBoxBody, isBoxBody } from "./collision/DynamicBox";
export { DynamicBody } from "./collision/DynamicBody";
export type { DynamicBodyKind, DynamicBodyMaterialOptions } from "./collision/DynamicBody";

// 接触 / 冲量求解
export { ContactImpulseSolver } from "./collision/solver/ContactImpulseSolver";
export type { ImpulseBody } from "./collision/solver/ImpulseBody";
export { ContactManifold } from "./collision/contacts/ContactManifold";
export { ContactPoint, CONTACT_SKIN, CONTACT_REF_EXTENT, contactSkinForExtent } from "./collision/contacts/ContactPoint";

// 载具底层
export { BVHVehicleController } from "./utils/vehiclePhysics/BVHVehicleController";
export { VehicleRigidBody } from "./utils/vehiclePhysics/VehicleRigidBody";
