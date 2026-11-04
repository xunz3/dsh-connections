declare module '@connections-native/*/settings' {
  export function createNativeSettings(
    adapt: import('./local-presentation.js').NativeSettingsAdapter,
    stores: typeof import('./settings-native/snapshot-store.js').nativeSnapshotStores,
  ): import('./local-presentation.js').NativePresentationFactory
}
