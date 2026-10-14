import {
  Fit,
  RiveFileFactory,
  RiveImages,
  RiveView,
  useRiveEnum,
  useRiveNumber,
  useRiveTrigger,
  useViewModelInstance,
  type RiveFile,
} from '@rive-app/react-native';
import { useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';

import { CAT_BOX, SLOTS, type Equipped, type KagenekoMode, type Slot } from '@/constants/cosmetics';

// If the placeholder looks faint in a dev build, try 100 (Rive author's note).
const SHOWN_ON = 1;

export type KagenekoViewProps = {
  size: number;
  equipped: Equipped;
  mode?: KagenekoMode;
  /** Bump to play the pet reaction. The first value is ignored. */
  petKey?: number;
  frameRate?: number;
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

export function KagenekoView({ size, equipped, mode, petKey, frameRate, instanceName, onFail }: KagenekoViewProps) {
  const file = useKagenekoFile(onFail);
  const { instance } = useViewModelInstance(file, {
    async: true,
    viewModelName: 'Kageneko',
    instanceName: instanceName ?? 'Default',
  });

  const { setValue: setMode } = useRiveEnum('mode', instance);
  useEffect(() => {
    setMode(mode ?? 'idle');
  }, [mode, setMode, instance]);

  const { trigger } = useRiveTrigger('pet', instance);
  const lastPet = useRef(petKey);
  useEffect(() => {
    if (lastPet.current === petKey) return;
    lastPet.current = petKey;
    trigger();
  }, [petKey, trigger]);

  const slots = {
    head: useRiveNumber('headShown', instance),
    face: useRiveNumber('faceShown', instance),
    body: useRiveNumber('bodyShown', instance),
    accessory: useRiveNumber('accessoryShown', instance),
  } satisfies Record<Slot, unknown>;

  return (
    <>
      {SLOTS.map((slot) => (
        <SlotSync key={slot} slot={slot} art={equipped[slot] ?? null} instance={instance} setShown={slots[slot].setValue} />
      ))}
      <View style={{ width: size, height: (size * CAT_BOX.h) / CAT_BOX.w }}>
        {file && instance ? (
          <RiveView
            file={file}
            dataBind={instance}
            fit={Fit.Contain}
            autoPlay
            frameRate={frameRate}
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
  slot,
  art,
  instance,
  setShown,
}: {
  slot: Slot;
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
          instance.imageProperty(slot)?.set(img);
        }
      } catch (e) {
        if (__DEV__) console.warn('Kageneko image failed', slot, e);
      }
      if (!cancelled) setShown(SHOWN_ON);
    })();
    return () => {
      cancelled = true;
    };
  }, [art, setShown, instance, slot]);
  return null;
}
