import type { NativeSettingsAdapter } from './local-presentation.js'
import { createNativeSettings as settings2 } from '@connections-native/rc2/settings'
import { createNativeSettings as settings3 } from '@connections-native/rc3/settings'
import { createNativeSettings as settings5 } from '@connections-native/rc5/settings'
import { nativeSnapshotStores } from './settings-native/snapshot-store.js'

/** Only the pre-consumer Settings bootstrap remains version-composed. Account
 * stays an independently activated native plugin and uses public slot inputs. */
export function nativeSettingsContent(version: string, adapt: NativeSettingsAdapter) {
  if (version === '0.2.1-rc.2') return settings2(adapt, nativeSnapshotStores)
  if (version === '0.2.1-rc.3') return settings3(adapt, nativeSnapshotStores)
  if (version === '0.2.1-rc.5') return settings5(adapt, nativeSnapshotStores)
  throw new Error('Unsupported native settings version')
}
