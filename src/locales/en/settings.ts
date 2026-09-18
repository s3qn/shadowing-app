/**
 * Settings tab and its screens. Filled in gradually: only the app language
 * screen's own copy lives here for now (Task 1); the rest of the settings
 * screens fill in when their own strings move to `t()`.
 */
export const en = {
  'settings.appLanguage': 'App language',
  'settings.appLanguageAuto': 'Same as understood',

  // Language names, shown wherever `LanguageEntry.english` would otherwise
  // render untranslated (the picker's subtitle, a "coming soon" note). The
  // native name (עברית, 日本語, ...) never changes.
  'language.ja': 'Japanese',
  'language.es': 'Spanish',
  'language.en': 'English',
  'language.he': 'Hebrew',
  'language.fr': 'French',
  'language.de': 'German',
  'language.pt': 'Portuguese',
  'language.it': 'Italian',
  'language.ru': 'Russian',
  'language.ko': 'Korean',
  'language.zh': 'Chinese',
  'language.hi': 'Hindi',
  'language.ar': 'Arabic',

  // Language picker (onboarding and Settings > Language).
  'settings.picker.searchPlaceholder': 'Search a language',
  'settings.picker.regionEurope': 'Europe',
  'settings.picker.regionAsia': 'Asia',
  'settings.picker.regionMiddleEast': 'Middle East',
  'settings.picker.regionAfrica': 'Africa',
  'settings.picker.regionAmericas': 'Americas',
  'settings.picker.readyToLearn': 'Ready to learn',
  'settings.picker.comingSoon': 'Coming soon',
  'settings.picker.suggested': 'Suggested',
  'settings.picker.allLanguages': 'All languages',
  'settings.picker.soonNote': 'Not ready to learn yet. Practice stays in {lang} until one of these is built.',
  'settings.picker.noMatch': 'No languages match "{query}".',

  // Settings > Language (learn / understand pickers).
  'settings.languages.learn': 'I want to learn',
  'settings.languages.understand': 'I understand',

  // Settings > About.
  'settings.about.app': 'App',
  'settings.about.appFootnote': 'Islands belong to this phone. Sean needs this id once to keep his own islands.',
  'settings.about.version': 'Version',
  'settings.about.unknown': 'Unknown',
  'settings.about.deviceId': 'Device ID',
  'settings.about.credits': 'Credits',
  'settings.about.creditsFootnote':
    'Speech is generated with VOICEVOX and transcribed with faster-whisper, both open source and run on this device’s own network.',
  'settings.about.voiceSynthesis': 'Voice synthesis',
  'settings.about.speechRecognition': 'Speech recognition',
  'settings.about.artwork': 'Artwork',
  'settings.about.animatedEmoji': 'Animated emoji',
  'settings.about.licences': 'Licences',
  'settings.about.licencesFootnote': 'Every open source dependency keeps its own licence, unmodified.',
  'settings.about.openSourceLicences': 'Open source licences',

  // Settings > Data.
  'settings.data.storage': 'Storage',
  'settings.data.storageFootnote': 'Every recording made while shadowing, across every island.',
  'settings.data.takesOnDevice': 'Takes on this device',
  'settings.data.takes': 'Takes',
  'settings.data.deleteAllTakes': 'Delete all takes',
  'settings.data.deleteAllTitle': 'Delete all takes?',
  'settings.data.deleteAllBody': 'This removes every recording on this device. Islands themselves are not affected.',
  'settings.data.deleteAllConfirm': 'Delete all',
  'settings.data.backend': 'Backend',
  'settings.data.server': 'Server',
  'settings.data.notSet': 'Not set',
  'settings.data.connection': 'Connection',
  'settings.data.checking': 'Checking…',
  'settings.data.connected': 'Connected',
  'settings.data.offline': 'Offline',

  // Settings > Playback.
  'settings.playback.speed': 'Speed',
  'settings.playback.defaultFootnote': 'Default for new sessions. Change it per session from the player.',
  'settings.playback.times': 'Times',
  'settings.playback.timesFootnote':
    'How many times each line plays before the next. Default for new sessions; change it per session from the player’s Repeat tile.',
  'settings.playback.timesAccessibility': 'Times, {label}',
  'settings.playback.pause': 'Pause',
  'settings.playback.pauseFootnote':
    'Silence after every play, which is also Auto Echo’s Echo step. Default for new sessions; change it per session from the player’s Repeat tile.',
  'settings.playback.pauseAccessibility': 'Pause, {label}',
  'settings.playback.autoEcho': 'Auto Echo',
  'settings.playback.autoRecord': 'Auto record',
  'settings.playback.autoRecordFootnote':
    'Auto record applies on every Echo pass. Auto Echo only decides whether the next pass starts on its own.',
  'settings.playback.screen': 'Screen',
  'settings.playback.keepScreenAwake': 'Keep screen awake',

  // Settings > Practice.
  'settings.practice.reading': 'Reading',
  'settings.practice.readingOff': 'Off',
  'settings.practice.readingFurigana': 'Furigana',
  'settings.practice.readingKana': 'Kana',
  'settings.practice.readingRomaji': 'Romaji',
  'settings.practice.defaults': 'Practice defaults',
  'settings.practice.pitchMarks': 'Pitch marks',
  'settings.practice.hideEnglish': 'Hide English by default',
  'settings.practice.blindByDefault': 'Blind by default',

  // Settings > Suggest a feature.
  'settings.suggest.hint': 'Tell us what the app should do. Every suggestion gets read.',
  'settings.suggest.placeholder': 'What should the app do?',
  'settings.suggest.error': 'Could not send that. Try again.',
  'settings.suggest.sent': 'Sent. Thanks.',
  'settings.suggest.send': 'Send',
  'settings.suggest.sending': 'Sending',

  // Settings > Voice.
  'settings.voice.comingSoonNote': '{name} is not ready yet. Islands are built in {lang} for now.',
  'settings.voice.availableFor':
    'Voices for {lang}. Tap one to hear it; the one you pick is used for new {lang} islands.',
  'settings.voice.loadError': 'Could not load voices',
  'settings.voice.credit': 'Audio made with this voice is credited as VOICEVOX:{name}',

  // Onboarding.
  'settings.onboarding.skip': 'Skip',
  'settings.onboarding.next': 'Next',
  'settings.onboarding.getStarted': 'Get started',
  'settings.onboarding.tagline': 'Learn a language by following its voice, one sentence at a time.',
  'settings.onboarding.micPrompt': 'The app needs your microphone to record you speaking along.',
  'settings.onboarding.allowMicrophone': 'Allow microphone',
  'settings.onboarding.micError': 'Microphone access is off. Turn it on in Settings and try again.',
  'settings.onboarding.notNow': 'Not now',
  'settings.onboarding.ready': 'You’re ready',
  'settings.onboarding.recordFirstIsland': 'Record your first island',
  'settings.onboarding.pickPodcast': 'Pick a podcast instead',
  'settings.onboarding.passListenTitle': 'Listen',
  'settings.onboarding.passListenLine': 'Hear the sentence first. Just the voice, no reading.',
  'settings.onboarding.passMumbleTitle': 'Mumble',
  'settings.onboarding.passMumbleLine': 'Hum along under your breath. Rhythm before words.',
  'settings.onboarding.passReadTitle': 'Read along',
  'settings.onboarding.passReadLine': 'Say it with the text in view, in step with the voice.',
  'settings.onboarding.passShadowTitle': 'Shadow',
  'settings.onboarding.passShadowLine': 'Say it a beat behind the voice, text hidden.',
  'settings.onboarding.passCompareTitle': 'Compare',
  'settings.onboarding.passCompareLine': 'Hear the voice and your take together. Next time, a little faster.',
  'settings.onboarding.voiceLane': 'voice',
  'settings.onboarding.youLane': 'you',
  'settings.onboarding.keptUp': '10 of 12 kept up',
};
