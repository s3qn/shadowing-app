import {
  Fit,
  RiveFileFactory,
  RiveImages,
  RiveView,
  useRiveBoolean,
  useRiveEnum,
  useRiveNumber,
  useRiveTrigger,
  useViewModelInstance,
  type RiveFile,
} from '@rive-app/react-native';
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGazeValue } from '@/hooks/use-gaze';
import { Image, View } from 'react-native';

import { CAT_BOX, SLOTS, type Equipped, type KagenekoEmotion, type KagenekoMode, type Slot } from '@/constants/cosmetics';

// If the placeholder looks faint in a dev build, try 100 (Rive author's note).
const SHOWN_ON = 1;

export type KagenekoViewProps = {
  size: number;
  equipped: Equipped;
  mode?: KagenekoMode;
  /** A looping emotion. Undefined means none. Cleared on unmount. */
  emotion?: KagenekoEmotion;
  /** Bump to play the pet reaction. The first value is ignored. */
  petKey?: number;
  frameRate?: number;
  /** Follow the live gaze from useGaze. Off means straight ahead. */
  gaze?: boolean;
  instanceName?: 'Default' | 'Showcase';
  onFail?: () => void;
};

// One RiveFile for every cat on screen, never disposed.
let filePromise: Promise<RiveFile> | null = null;
function loadFile(): Promise<RiveFile> {
  if (!filePromise) {
    filePromise = RiveFileFactory.fromSource(require('../../../assets/rive/kageneko.riv'), undefined);
    filePromise.catch(() => {
      filePromise = null;
    });
  }
  return filePromise;
}

function useKagenekoFile(onFail?: () => void): RiveFile | undefined {
  const [file, setFile] = useState<RiveFile | undefined>();
  const fail = useRef(onFail);
  fail.current = onFail;
  useEffect(() => {
    let live = true;
    loadFile().then(
      (f) => live && setFile(f),
      (e) => {
        if (__DEV__) console.warn('Kageneko file failed', e);
        if (live) fail.current?.();
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return file;
}

export function KagenekoView({ size, equipped, mode, emotion, petKey, frameRate, gaze = false, instanceName, onFail }: KagenekoViewProps) {
  const file = useKagenekoFile(onFail);
  const focused = useIsFocused();
  const { instance } = useViewModelInstance(file, {
    async: true,
    viewModelName: 'Kageneko',
    instanceName: instanceName ?? 'Default',
  });

  const { setValue: setMode } = useRiveEnum('mode', instance);
  useEffect(() => {
    setMode(mode ?? 'idle');
  }, [mode, setMode, instance]);

  const viewRef = useRef<{ play: () => Promise<void> } | null>(null);
  const hybridRef = useMemo(() => ({ f: (r: { play: () => Promise<void> } | null) => (viewRef.current = r) }), []);
  const play = () => {
    try {
      void viewRef.current?.play().catch(() => {});
    } catch {
      // The view is not ready yet.
    }
  };
  // Start the state machine explicitly once the file and instance are bound.
  useEffect(() => {
    if (file && instance) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, instance]);

  const { setValue: setEmotion } = useRiveEnum('emotion', instance);
  // The setter identity changes whenever the value does, so it lives in a ref and the effects ignore it.
  const emotionRef = useRef(setEmotion);
  emotionRef.current = setEmotion;
  useEffect(() => {
    try {
      emotionRef.current(emotion ?? 'none');
      play();
    } catch {
      // The file has no emotion input.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emotion, instance]);
  useEffect(
    () => () => {
      try {
        emotionRef.current('none');
      } catch {
        // Already disposed.
      }
    },
    [],
  );

  // Mirror touches into the file's `pressing` boolean. Plain View callbacks do not take the gesture from a parent Pressable.
  const { setValue: setPressing } = useRiveBoolean('pressing', instance);
  const press = (v: boolean) => {
    try {
      setPressing(v);
      play();
    } catch {
      // The file has no pressing input.
    }
  };
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => () => pressRef.current(false), []);

  const { trigger } = useRiveTrigger('pet', instance);
  const lastPet = useRef(petKey);
  useEffect(() => {
    if (lastPet.current === petKey) return;
    lastPet.current = petKey;
    trigger();
  }, [petKey, trigger]);

  const { x: lookX, y: lookY } = useGazeValue(gaze);
  const { setValue: setLookX } = useRiveNumber('lookX', instance);
  const { setValue: setLookY } = useRiveNumber('lookY', instance);
  useEffect(() => {
    try {
      setLookX(lookX);
      setLookY(lookY);
    } catch {
      // The file has no look inputs yet.
    }
  }, [lookX, lookY, setLookX, setLookY, instance]);

  const slots = {
    head: useRiveNumber('headShown', instance),
    face: useRiveNumber('faceShown', instance),
    body: useRiveNumber('bodyShown', instance),
    accessory: useRiveNumber('accessoryShown', instance),
  } satisfies Record<Slot, unknown>;
  const tail = useRiveNumber('tailShown', instance);

  // Tail bows live in the wardrobe accessory slot but draw on the Rive `tail` image.
  const accessoryArt = equipped.accessory ?? null;
  const isTailBow = accessoryArt?.shape === 'tailbow';

  return (
    <>
      {SLOTS.map((slot) =>
        slot === 'accessory' ? (
          <SlotSync
            key={slot}
            riveSlot="accessory"
            art={isTailBow ? null : accessoryArt}
            instance={instance}
            setShown={slots.accessory.setValue}
          />
        ) : (
          <SlotSync key={slot} riveSlot={slot} art={equipped[slot] ?? null} instance={instance} setShown={slots[slot].setValue} />
        ),
      )}
      <SlotSync key="tail" riveSlot="tail" art={isTailBow ? accessoryArt : null} instance={instance} setShown={tail.setValue} />
      <View
        style={{ width: size, height: (size * CAT_BOX.h) / CAT_BOX.w }}
        onTouchStart={() => press(true)}
        onTouchEnd={() => press(false)}
        onTouchCancel={() => press(false)}>
        {file && instance ? (
          <RiveView
            file={file}
            dataBind={instance}
            fit={Fit.Contain}
            autoPlay
            stateMachineName="Kageneko"
            hybridRef={hybridRef}
            frameRate={focused ? Math.min(frameRate ?? 30, 30) : 1}
            onError={() => onFail?.()}
            style={{ width: '100%', height: '100%' }}
          />
        ) : null}
      </View>
    </>
  );
}

type Instance = NonNullable<ReturnType<typeof useViewModelInstance>['instance']>;

/** Mirrors one slot's art into the cat: Shown 1 or 0, and the image when the art has one. */
function SlotSync({
  riveSlot,
  art,
  instance,
  setShown,
}: {
  riveSlot: string;
  art: Equipped[Slot];
  instance: Instance | null | undefined;
  setShown: (v: number) => void;
}) {
  useEffect(() => {
    if (!art) {
      setShown(0);
      return;
    }
    const image = art.image;
    if (image === undefined) {
      setShown(SHOWN_ON);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const uri = Image.resolveAssetSource(image)?.uri;
        if (uri && instance) {
          const img = await RiveImages.loadFromURLAsync(uri);
          if (cancelled) return;
          instance.imageProperty(riveSlot)?.set(img);
        }
      } catch (e) {
        if (__DEV__) console.warn('Kageneko image failed', riveSlot, e);
      }
      if (!cancelled) setShown(SHOWN_ON);
    })();
    return () => {
      cancelled = true;
    };
  }, [art, setShown, instance, riveSlot]);
  return null;
}
