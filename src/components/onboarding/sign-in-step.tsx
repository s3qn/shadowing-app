import * as AppleAuthentication from 'expo-apple-authentication';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { CatConstellation } from '@/components/cat-constellation';
import { type HeroClock } from '@/components/onboarding/hero-clock';
import { Enter, StepCopy, StepFrame } from '@/components/onboarding/step-frame';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { allowDeviceSession, canBypassSignIn, signInWithApple, signInWithGoogle } from '@/lib/auth';
import { useT } from '@/lib/i18n';

function GoogleG() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        fill="#7CC8FF"
        d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2z"
      />
      <Path
        fill="#5FD9A6"
        d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"
      />
      <Path fill="#FFC857" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z" />
      <Path
        fill="#FF5468"
        d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.4 3-4.1 5.6-4.1z"
      />
    </Svg>
  );
}

// Apple sign-in availability, asked once per launch and kept here: the
// onboarding route prefetches it, so the Account step mounts under the
// welcome with its first pill already known.
let appleAvailable: boolean | null = Platform.OS === 'ios' ? null : false;
let applePending: Promise<void> | null = null;

/** Resolves Apple sign-in availability into the module cache (false off iOS). */
export function prefetchAppleAvailable(): Promise<void> {
  if (appleAvailable !== null) return Promise.resolve();
  if (!applePending) {
    applePending = AppleAuthentication.isAvailableAsync()
      .then((ok) => {
        appleAvailable = ok;
      })
      .catch(() => {
        appleAvailable = false;
      });
  }
  return applePending;
}

/**
 * The account step: Apple (iOS only) and Google, one tap each, no typing. Shown in
 * onboarding and on its own at /sign-in. In Expo Go (development only) a
 * third pill continues on the device path, since native sign-in cannot run
 * there.
 *
 * With `clock` (under the welcome) every part is hidden until Get started
 * is pressed, then enters on the hand-off: the first pill is lit, since the
 * welcome pill rides up and lands on it. Without `clock` (the /sign-in
 * route) everything is static at rest.
 */
export function SignInStep({
  onSignedIn,
  clock,
  travel,
  reduced,
}: {
  onSignedIn: () => void;
  clock?: HeroClock;
  /** Written from the footer's layout: how far the welcome pill rides up to land on the first pill here. */
  travel?: SharedValue<number>;
  reduced?: boolean;
}) {
  const { t } = useT();
  const { width } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [appleOk, setAppleOk] = useState(appleAvailable === true);

  useEffect(() => {
    if (appleAvailable !== null) return;
    let alive = true;
    void prefetchAppleAvailable().then(() => {
      if (alive) setAppleOk(appleAvailable === true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The travel is measured, not assumed: the first pill's distance from the
  // footer's bottom (Expo Go's dev pill adds a row, Android has no Apple pill).
  // Under reduced motion the welcome pill does not travel, so it stays 0.
  const footerH = useRef(0);
  const firstBottom = useRef(0);
  const writeTravel = () => {
    if (travel && !reduced) travel.value = Math.max(0, footerH.current - firstBottom.current);
  };
  const onFooterLayout = (e: LayoutChangeEvent) => {
    footerH.current = e.nativeEvent.layout.height;
    writeTravel();
  };
  const onFirstLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    firstBottom.current = y + height;
    writeTravel();
  };

  async function run(go: () => Promise<'ok' | 'cancelled'>) {
    setBusy(true);
    setError('');
    try {
      const res = await go();
      if (res === 'ok') onSignedIn();
    } catch (err: unknown) {
      const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
      setError(`${t('settings.account.failed')}${detail}`);
    } finally {
      setBusy(false);
    }
  }

  const pillWidth = Math.max(0, width - 2 * Spacing.xl);

  return (
    <StepFrame
      footer={
        <View style={styles.footer} onLayout={onFooterLayout}>
          {busy ? (
            <CatConstellation size={90} label={t('settings.account.signingIn')} />
          ) : (
            <>
              {/* The first pill (Apple on iOS, else Google) is lit: the welcome pill lands on it. */}
              <Enter clock={clock} reduced={reduced} at={260} dur={160} linear onLayout={onFirstLayout}>
                <PrismButton
                  shape="pill"
                  verb="listen"
                  on
                  width={pillWidth}
                  height={52}
                  label={appleOk ? t('settings.account.apple') : t('settings.account.google')}
                  onPress={() => void run(appleOk ? signInWithApple : signInWithGoogle)}>
                  {appleOk ? <SymbolView name="apple.logo" tintColor={tide.text} size={20} /> : <GoogleG />}
                </PrismButton>
              </Enter>
              {appleOk ? (
                <Enter clock={clock} reduced={reduced} at={300} dur={320} rise={24}>
                  <PrismButton
                    shape="pill"
                    verb="tools"
                    on={false}
                    width={pillWidth}
                    height={52}
                    label={t('settings.account.google')}
                    onPress={() => void run(signInWithGoogle)}>
                    <GoogleG />
                  </PrismButton>
                </Enter>
              ) : null}
            </>
          )}
          <Enter clock={clock} reduced={reduced} at={380} dur={260} style={styles.captionBlock}>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.caption}>{t('settings.account.privacyLine')}</Text>
            {canBypassSignIn() && !busy ? (
              <PrismButton
                shape="pill"
                verb="tools"
                flat
                press="light"
                label={t('settings.account.expoGo')}
                onPress={() => {
                  allowDeviceSession();
                  onSignedIn();
                }}
              />
            ) : null}
          </Enter>
        </View>
      }>
      <StepCopy
        enter={clock}
        reduced={reduced}
        kicker={t('settings.account.kicker')}
        kickerColour={verb.listen.c1}
        title={t('settings.account.title')}
        body={t('settings.account.body')}
      />
    </StepFrame>
  );
}

const styles = StyleSheet.create({
  // The same stack StepFrame's footer draws, in one View so its height can be measured.
  footer: { alignSelf: 'stretch', alignItems: 'center', gap: Spacing.sm },
  captionBlock: { alignItems: 'center', gap: Spacing.sm },
  error: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: tide.record,
    textAlign: 'center',
    maxWidth: 280,
  },
  caption: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: tide.textDim,
    textAlign: 'center',
  },
});
