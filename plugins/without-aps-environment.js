/**
 * expo-notifications always adds the iOS push entitlement (`aps-environment`).
 * The app only schedules local notifications, and a provisioning profile
 * without Push makes codesign fail on the GitHub runner, so this removes it.
 * A plain withEntitlementsPlist runs before the mods registered earlier (the
 * newest mod runs first), so this one lets the rest of the chain finish and
 * deletes the key afterwards, wherever it sits in app.json.
 */
const { withBaseMod } = require('expo/config-plugins');

module.exports = function withoutApsEnvironment(config) {
  return withBaseMod(config, {
    platform: 'ios',
    mod: 'entitlements',
    isProvider: false,
    async action({ modRequest: { nextMod, ...modRequest }, ...rest }) {
      const result = await nextMod({ ...rest, modRequest });
      delete result.modResults['aps-environment'];
      return result;
    },
  });
};
