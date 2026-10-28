import type { NativeSettingsAdapter } from './local-presentation.js'
import { createNativeSettings as settings2 } from '@connections-native/rc2/settings'
import { createNativeAccount as account2 } from '@connections-native/rc2/account'
import { createNativeSettings as settings3 } from '@connections-native/rc3/settings'
import { createNativeAccount as account3 } from '@connections-native/rc3/account'
import type { LoginHost } from './login-host.js'

export function nativeContent(version: string, host: LoginHost | undefined, adapt: NativeSettingsAdapter) {
  if (version === '0.2.1-rc.2') return { settings: settings2(adapt), account: account2(host, version) }
  if (version === '0.2.1-rc.3') return { settings: settings3(adapt), account: account3(host, version) }
  throw new Error('Unsupported native settings version')
}
