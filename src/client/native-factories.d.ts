declare module '@connections-native/*/settings' {
  export function createNativeSettings(adapt: import('./local-presentation.js').NativeSettingsAdapter): import('./local-presentation.js').NativePresentationFactory
}
declare module '@connections-native/*/account' {
  export function createNativeAccount(host: import('./login-host.js').LoginHost | undefined, version?: string): import('./local-presentation.js').NativePresentationFactory
}
